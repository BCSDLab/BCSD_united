import assert from 'node:assert/strict';
import test from 'node:test';
import { figmaReference, gaps, githubItem, notionRow, render, validateFeatures } from './board.mjs';

const item = (state, number = 1) => ({
  number,
  title: 't',
  state,
  author: 'a',
  updated: '2026-11-16T00:00:00Z',
  url: `https://github.com/o/r/issues/${number}`,
});

function feature(overrides = {}) {
  return {
    id: 'f',
    name: '기능',
    github: { web: { repository: 'o/web', items: [item('issue-open', 1), item('pr-open', 2)] } },
    notion: {
      pages: [{ role: 'plan', title: '기획', updated: '2026-11-02T00:00:00Z', url: 'https://www.notion.so/p' }],
      databases: [
        {
          role: 'qa',
          url: 'https://www.notion.so/d',
          rows: [{ title: '모달', status: '수정 완료', updated: '2026-10-19T00:00:00Z' }],
        },
      ],
    },
    figma: [{ role: 'design', url: 'https://www.figma.com/design/k/n' }],
    ...overrides,
  };
}

test('GitHub search items are classified by issue, draft, open, merged, and closed PR state', () => {
  const base = { number: 3, title: 't', user: { login: 'u' }, updated_at: 'x', html_url: 'y' };
  assert.equal(githubItem({ ...base, state: 'open' }).state, 'issue-open');
  assert.equal(githubItem({ ...base, state: 'open', draft: true, pull_request: {} }).state, 'pr-draft');
  assert.equal(githubItem({ ...base, state: 'open', pull_request: {} }).state, 'pr-open');
  assert.equal(githubItem({ ...base, state: 'closed', pull_request: { merged_at: 'z' } }).state, 'pr-merged');
  assert.equal(githubItem({ ...base, state: 'closed', pull_request: { merged_at: null } }).state, 'pr-closed');
});

test('Notion rows read the title and prefer a status property over a select', () => {
  const row = notionRow({
    last_edited_time: '2026-11-01T00:00:00Z',
    url: 'u',
    properties: {
      분류: { type: 'select', select: { name: 'web' } },
      상태: { type: 'status', status: { name: '확인 필요' } },
      Issue: { type: 'title', title: [{ plain_text: '모달 ' }, { plain_text: '스크롤' }] },
    },
  });
  assert.deepEqual(row, { title: '모달 스크롤', status: '확인 필요', updated: '2026-11-01T00:00:00Z', url: 'u' });
});

test('a fully linked feature has no gaps', () => {
  assert.deepEqual(gaps(feature()), []);
});

test('gaps name each missing link and keep skipped sources apart from empty ones', () => {
  const found = gaps(
    feature({
      github: {
        web: { repository: 'o/web', items: [item('issue-open')] },
        ios: { repository: 'o/ios', items: [] },
      },
      notion: {
        pages: [],
        databases: [{ role: 'qa', url: 'u', rows: [{ title: '프로필 작성', status: '확인 필요', updated: 'x' }] }],
      },
      figma: [],
    }),
  );
  assert.deepEqual(found, [
    '웹: 열린 이슈 1건에 PR 없음',
    'iOS: 이슈·PR 없음',
    '기획 문서 연결 없음',
    'QA 미완료 1건: 프로필 작성',
    'Figma 프레임 연결 없음',
  ]);
  assert.deepEqual(gaps(feature({ notion: null })), ['Notion: 수집 안 됨 (NOTION_TOKEN 없음)']);
});

test('render lists every platform row and escapes table cells', () => {
  const board = render({
    collectedAt: '2026-11-17T07:00:00.000Z',
    since: '2026-08-19',
    features: [feature({ notion: { pages: [{ role: 'plan', title: 'A|B', updated: 'x', url: 'u' }], databases: [] } })],
  });
  assert.match(board, /\| 웹 \(web\) \| \[#1\]\(.+\) \| \[#2\]\(.+\) \| - \| 2026-11-16 \|/);
  assert.match(board, /A\\\|B/);
  assert.match(board, /QA 기록 연결 없음/);
  assert.match(board, /버전 수집 안 됨/);
});

test('feature lists reject unknown platforms and keywords that break the search query', () => {
  const valid = { id: 'a', name: 'A', keywords: ['복덕방'], repos: { web: 'o/r' } };
  assert.equal(validateFeatures([valid]).length, 1);
  assert.throws(() => validateFeatures([{ ...valid, repos: { desktop: 'o/r' } }]), /repos/);
  assert.throws(() => validateFeatures([{ ...valid, keywords: ['a" OR repo:x'] }]), /keywords/);
  assert.throws(() => validateFeatures([]), /nonempty/);
});

test('Figma URLs yield the file key and node id, and other hosts are refused', () => {
  assert.deepEqual(figmaReference('https://www.figma.com/design/KEY/Name?node-id=20593-13508&t=x'), {
    key: 'KEY',
    nodeId: '20593:13508',
  });
  assert.throws(() => figmaReference('https://example.com/design/KEY/Name'), /Figma/);
});
