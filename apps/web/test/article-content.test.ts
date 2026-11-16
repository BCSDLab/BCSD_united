import assert from 'node:assert/strict';
import { test } from 'node:test';

import { fetchArticleContent } from '../src/api/articles/content.server';
import { getArticleContentUrl } from '../src/api/articles/contentUrl';
import { sanitizeHtml } from '../src/utils/ts/sanitize';

const CONTENT_URL = 'https://static.koreatech.in/articles/content/board_5/d8b86e30c8114b2c94a617980c0912cc.txt';
const IMAGE_URL = 'https://portal.koreatech.ac.kr/ctt/bb/bulletin?b=14&a=id&p=37457&fn=poster.jpg';

test('정적 txt 본문을 HTML로 읽어 게시글 사진과 텍스트를 정제 후에도 표시한다', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(input, CONTENT_URL);
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.redirect, 'manual');
    assert.equal(new Headers(init?.headers).has('cookie'), false);
    return new Response(
      `<html><head><script>alert(1)</script></head><body><p>채용설명회</p><img src="${IMAGE_URL.replaceAll('&', '&amp;')}" alt="포스터" onerror="alert(1)"></body></html>`,
      { headers: { 'Content-Type': 'text/plain; charset=utf-8' } },
    );
  });

  const contentUrl = getArticleContentUrl(CONTENT_URL);
  assert.equal(contentUrl, CONTENT_URL);
  assert.ok(contentUrl);
  const visibleHtml = sanitizeHtml(await fetchArticleContent(contentUrl));
  assert.match(visibleHtml, /<p>채용설명회<\/p>/);
  assert.match(visibleHtml, /<img src="https:\/\/portal\.koreatech\.ac\.kr\/ctt\/bb\/bulletin\?b=14&amp;a=id&amp;p=37457&amp;fn=poster\.jpg" alt="포스터"/);
  assert.doesNotMatch(visibleHtml, /<script|onerror|alert\(1\)/);
  assert.doesNotMatch(visibleHtml, /articles\/content/);
});

test('인라인 HTML은 외부 본문 URL로 취급하지 않고 이미지를 유지한다', () => {
  const html = '<p>공지</p><img src="https://static.koreatech.in/poster.jpg" alt="사진">';
  assert.equal(getArticleContentUrl(html), null);
  assert.match(sanitizeHtml(html), /<img src="https:\/\/static\.koreatech\.in\/poster\.jpg" alt="사진"/);
  assert.equal(
    getArticleContentUrl('https://stage-static.koreatech.in/articles/content/board_4/notice-1.txt'),
    'https://stage-static.koreatech.in/articles/content/board_4/notice-1.txt',
  );
});

test('본문 조회는 허용된 정적 출처와 경로만 접근한다', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('Unexpected fetch');
  });
  for (const url of [
    'http://static.koreatech.in/articles/content/board_5/file.txt',
    'https://static.koreatech.in.evil.test/articles/content/board_5/file.txt',
    'https://127.0.0.1/articles/content/board_5/file.txt',
    'https://static.koreatech.in/assets/file.txt',
    'https://static.koreatech.in/articles/content/board_5/file.svg',
    `${CONTENT_URL}?redirect=https://example.test`,
    `${CONTENT_URL}#fragment`,
    CONTENT_URL.replace('https://', 'https://user:pass@'),
  ]) {
    assert.equal(getArticleContentUrl(url), null);
    await assert.rejects(fetchArticleContent(url), /Invalid article content URL/);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('본문 redirect와 HTTP 실패를 빈 본문이나 URL 텍스트로 대체하지 않는다', async (t) => {
  for (const status of [302, 404, 500]) {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () =>
      new Response(null, { status, headers: { Location: 'https://example.test/private' } }),
    );
    await assert.rejects(fetchArticleContent(CONTENT_URL), /Unable to load article content/);
    assert.equal(fetchMock.mock.callCount(), 1);
    fetchMock.mock.restore();
  }
});

test('본문 MIME과 선언된 크기를 제한한다', async (t) => {
  const responseHeaders: HeadersInit[] = [
    { 'Content-Type': 'image/svg+xml' },
    { 'Content-Type': 'text/plain', 'Content-Length': String(2 * 1024 * 1024 + 1) },
  ];
  for (const headers of responseHeaders) {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response('body', { headers }));
    await assert.rejects(fetchArticleContent(CONTENT_URL), /Invalid article content type|exceeds 2 MiB/);
    fetchMock.mock.restore();
  }
});

test('Content-Length가 없어도 수신 본문 크기를 제한한다', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1), {
    headers: { 'Content-Type': 'text/plain' },
  }));
  await assert.rejects(fetchArticleContent(CONTENT_URL), /exceeds 2 MiB/);
});

test('스트림 경계에서 나뉜 UTF-8 한글 본문도 보존한다', async (t) => {
  const bytes = new TextEncoder().encode('<p>사진</p>');
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 4));
      controller.enqueue(bytes.subarray(4));
      controller.close();
    },
  }), { headers: { 'Content-Type': 'text/html' } }));
  assert.equal(await fetchArticleContent(CONTENT_URL), '<p>사진</p>');
});
