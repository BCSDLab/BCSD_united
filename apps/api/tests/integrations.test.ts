import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import type { Bindings } from '@api/runtime';
import { ApiError } from '@api/errors';
import {
  generateFileKey,
  extractFileKey,
  publicFileUrl,
  signCapability,
  uploadUrl,
  validateUploadInput,
  verifyCapability,
} from '@api/integrations/storage';
import { naverSignature, sendSms } from '@api/integrations/messaging';
import { fcmMessage } from '@api/integrations/push';
import {
  studentRegistrationEmail,
  studentPasswordResetEmail,
  userVerificationEmail,
} from '@api/integrations/templates';
import { allowedDocumentUrl, extractDocumentText, summarizeArticle, UpstageError } from '@api/integrations/upstage';
import { tossConfirm, tossCancel, TossGatewayError } from '@api/integrations/toss';

const env = {
  UPLOAD_SIGNING_SECRET: 'a-32-byte-minimum-signing-secret-for-tests',
  API_PUBLIC_URL: 'https://api.example.test/',
  R2_FILES_PUBLIC_URL: 'https://files.example.test/assets/',
} as Bindings;

function expectApiStatus(status: number) {
  return (error: unknown) => error instanceof ApiError && error.status === status;
}

test('capabilities bind method, object, metadata, expiry and signing key', async () => {
  const payload = {
    version: 1 as const,
    method: 'PUT' as const,
    key: 'upload/COOP/a.png',
    expires: 10_000,
    contentType: 'image/png',
    contentLength: 12,
  };
  const token = await signCapability(env, payload);
  assert.deepEqual(await verifyCapability(env, token, 'PUT', 9999), payload);
  await assert.rejects(verifyCapability(env, token, 'PUT', 10_000), expectApiStatus(403));
  await assert.rejects(verifyCapability(env, token, 'GET', 9999), expectApiStatus(403));
  await assert.rejects(
    verifyCapability({ ...env, UPLOAD_SIGNING_SECRET: 'different-32-byte-minimum-signing-secret' }, token, 'PUT', 9999),
    expectApiStatus(403),
  );
  const [body, signature] = token.split('.');
  const changed = Buffer.from(JSON.stringify({ ...payload, key: 'private/secret' })).toString('base64url');
  await assert.rejects(verifyCapability(env, `${changed}.${signature}`, 'PUT', 9999), expectApiStatus(403));
  await assert.rejects(verifyCapability(env, `${body}.x`, 'PUT', 9999), expectApiStatus(403));
  await assert.rejects(verifyCapability(env, `${token}.extra`, 'PUT', 9999), expectApiStatus(403));
});

test('upload URLs keep source snake case and ten-minute KST expiration', async () => {
  const now = Date.parse('2026-01-01T14:55:00Z');
  const input = validateUploadInput({ file_name: '품절% photo.png', content_type: 'image/png', content_length: 99 });
  const result = await uploadUrl(env, 'coop', input, now);
  assert.equal(result.expiration_date, '2026-01-02 00:05:00');
  assert.match(
    result.file_url,
    /^https:\/\/files.example.test\/assets\/upload\/COOP\/2026\/1\/1\/.+\/품절% photo.png$/,
  );
  const capability = await verifyCapability(
    env,
    new URL(result.pre_signed_url).pathname.split('/').at(-1)!,
    'PUT',
    now,
  );
  assert.equal(capability.contentLength, 99);
  assert.equal(capability.contentType, 'image/png');
  assert.equal(capability.expires, now + 600_000);
  assert.equal(
    generateFileKey('coop', 'a.b.png', Date.parse('2026-01-01T15:00:00Z'), 'id'),
    'upload/COOP/2026/1/2/id/ab.png',
  );
});

test('upload input rejects invalid sizes, blank metadata and path escapes', () => {
  const valid = { file_name: 'a.png', content_type: 'image/png', content_length: 1 };
  for (const size of [0, -1, 1.5, 2_147_483_648, '1', null])
    assert.throws(() => validateUploadInput({ ...valid, content_length: size }), expectApiStatus(400));
  for (const name of ['', ' ', '../secret', 'a\\b', '\0.png'])
    assert.throws(() => validateUploadInput({ ...valid, file_name: name }), expectApiStatus(400));
  for (const type of ['', ' ', 'image/png\r\nx-test: hi'])
    assert.throws(() => validateUploadInput({ ...valid, content_type: type }), expectApiStatus(400));
});

test('raw file URLs preserve literal percent, spaces, unicode and repeated slashes', () => {
  for (const key of ['upload/COOP/soldout%20photo.jpg', 'upload/COOP/100%.jpg', 'upload/COOP/a//품절 photo+.jpg']) {
    assert.equal(publicFileUrl(env, key), `https://files.example.test/assets/${key}`);
    assert.equal(extractFileKey(env, publicFileUrl(env, key)), key);
  }
  for (const url of [
    'https://files.example.test.evil/assets/x',
    'https://user@files.example.test/assets/x',
    'https://files.example.test/other/x',
    'https://files.example.test/assets/../x',
    'https://files.example.test/assets/x/../../secret',
  ])
    assert.throws(() => extractFileKey(env, url), expectApiStatus(400));
});

test('Naver signature covers exact method, path, timestamp and access key', async () => {
  const path = '/sms/v2/services/ncp:sms:kr:123:app/messages';
  const expected = createHmac('sha256', 'secret').update(`POST ${path}\n1700000000000\naccess`).digest('base64');
  assert.equal(await naverSignature('secret', path, '1700000000000', 'access'), expected);
  assert.notEqual(await naverSignature('secret', path, '1700000000001', 'access'), expected);
});

test('SMS sends signed real-provider request and rejects application-level failure', async (t) => {
  const smsEnv = {
    ...env,
    NAVER_SMS_SERVICE_ID: 'service',
    NAVER_SMS_FROM: '01012345678',
    NAVER_ACCESS_KEY: 'access',
    NAVER_SECRET_KEY: 'secret',
  };
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, 'https://sens.apigw.ntruss.com/sms/v2/services/service/messages');
    const headers = new Headers(init.headers);
    assert.equal(
      headers.get('x-ncp-apigw-signature-v2'),
      await naverSignature(
        'secret',
        '/sms/v2/services/service/messages',
        headers.get('x-ncp-apigw-timestamp')!,
        'access',
      ),
    );
    assert.deepEqual(JSON.parse(String(init.body)), {
      type: 'SMS',
      from: '01012345678',
      contentType: 'COMM',
      content: '인증번호',
      messages: [{ to: '01087654321' }],
    });
    return Response.json({ statusCode: '202' }, { status: 202 });
  });
  await sendSms(smsEnv, { to: '01087654321', content: '인증번호' });
  fetchMock.mock.mockImplementation(async () => Response.json({ statusCode: '400' }));
  await assert.rejects(sendSms(smsEnv, { to: '01087654321', content: '인증번호' }));
});

test('FCM preserves Android routing and APNs category, sound and notification identity', () => {
  const message = fcmMessage({
    token: 'device',
    title: '제목',
    body: '본문',
    data: {
      imageUrl: 'https://files.example.test/a.png',
      path: 'callvan',
      schemeUri: 'callvan/1',
      type: 'callvan',
      notification_id: '9007199254740993',
    },
  }) as {
    android: { priority: string; data: Record<string, string> };
    apns: { payload: { aps: Record<string, unknown>; notification_id: string }; fcm_options: { image: string } };
  };
  assert.equal(message.android.priority, 'HIGH');
  assert.equal(message.android.data.url, 'koin://callvan/1');
  assert.equal(message.android.data.content, '본문');
  assert.deepEqual(message.apns.payload.aps, {
    alert: { title: '제목', body: '본문' },
    sound: 'default',
    category: 'callvan',
    'mutable-content': 1,
  });
  assert.equal(message.apns.payload.notification_id, '9007199254740993');
  assert.equal(message.apns.fcm_options.image, 'https://files.example.test/a.png');
});

test('email templates escape data and encode credentials inside exact legacy routes', () => {
  const verification = userVerificationEmail('<img src=x onerror=alert(1)>');
  assert.equal(verification.subject, '코인 이메일 인증');
  assert.ok(verification.html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!verification.html.includes('th:text='));
  assert.ok(verification.html.includes('5분간'));
  const registration = studentRegistrationEmail('https://api.example.test', 'a&"<>');
  assert.ok(registration.html.includes('/user/authenticate?auth_token=a%26%22%3C%3E'));
  assert.ok(!registration.html.includes('th:href='));
  assert.ok(
    studentPasswordResetEmail('https://api.example.test', 'token').html.includes(
      '/user/change/password/config?reset_token=token',
    ),
  );
  assert.throws(() => studentRegistrationEmail('javascript:alert(1)', 'token'));
});

test('document extraction prefers markdown, deduplicates fallback and limits text', () => {
  assert.equal(extractDocumentText({ content: { markdown: '  **본문** ', text: 'ignored' } }), '**본문**');
  assert.equal(
    extractDocumentText({
      elements: [{ content: { text: '첫째' } }, { children: [{ text: '둘째' }, { text: '첫째' }] }],
    }),
    '첫째\n둘째',
  );
  assert.equal(extractDocumentText({ content: { text: 'x'.repeat(9000) } }).length, 8000);
  assert.equal(allowedDocumentUrl('https://portal.koreatech.ac.kr/file.pdf'), true);
  for (const url of [
    'http://portal.koreatech.ac.kr/file',
    'https://portal.koreatech.ac.kr.evil/file',
    'https://user@portal.koreatech.ac.kr/file',
    'https://127.0.0.1/file',
    'https://portal.koreatech.ac.kr:444/file',
  ])
    assert.equal(allowedDocumentUrl(url), false);
});

test('Upstage 429 exposes retry delay without fabricating a summary', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 429, headers: { 'retry-after': '120' } }));
  await assert.rejects(
    summarizeArticle(
      { ...env, UPSTAGE_API_KEY: 'test' },
      { systemMessage: 'system', userMessage: 'user', maxItems: 5 },
    ),
    (error: unknown) =>
      error instanceof UpstageError && error.retryable && error.retryAfterMs === 120_000 && error.status === 429,
  );
});

test('Upstage preserves overflowing model content for domain refinement', async (t) => {
  const items = [
    { icon_key: ' calendar ', text: 'x'.repeat(201) },
    { icon_key: 'unknown', text: 'second' },
  ];
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ choices: [{ message: { content: JSON.stringify({ items }) } }] }),
  );
  const result = await summarizeArticle(
    { ...env, UPSTAGE_API_KEY: 'test' },
    { systemMessage: 'system', userMessage: 'user', maxItems: 1 },
  );
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0]?.text.length, 201);
  assert.equal(result.items[0]?.icon_key, 'CALENDAR');
  assert.equal(result.items[1]?.icon_key, 'DEFAULT');
  assert.equal(allowedDocumentUrl('https://koreatech.ac.kr/document'), true);
});

test('Toss transport sends stable idempotency and distinguishes uncertain outcomes', async (t) => {
  const tossEnv = { ...env, TOSS_SECRET_KEY: 'test_sk_secret' };
  const fetchMock = t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    assert.equal(headers.get('authorization'), `Basic ${Buffer.from('test_sk_secret:').toString('base64')}`);
    assert.equal(headers.get('idempotency-key'), 'durable-attempt-1');
    return Response.json({ paymentKey: 'p', orderId: 'o', status: 'DONE', totalAmount: 1000, balanceAmount: 1000 });
  });
  assert.equal(
    (await tossConfirm(tossEnv, { paymentKey: 'p', orderId: 'o', amount: 1000 }, 'durable-attempt-1')).status,
    'DONE',
  );
  fetchMock.mock.mockImplementation(async () => {
    throw new DOMException('timeout', 'TimeoutError');
  });
  await assert.rejects(
    tossCancel(tossEnv, 'p', { cancelReason: '요청' }, 'durable-attempt-1'),
    (error: unknown) => error instanceof TossGatewayError && error.timeout && error.uncertain && error.retryable,
  );
  fetchMock.mock.mockImplementation(async () => Response.json({ code: 'NOT_FOUND_PAYMENT' }, { status: 404 }));
  await assert.rejects(
    tossConfirm(tossEnv, { paymentKey: 'p', orderId: 'o', amount: 1000 }, 'durable-attempt-1'),
    (error: unknown) =>
      error instanceof TossGatewayError &&
      error.code === 'NOT_FOUND_PAYMENT' &&
      error.status === 404 &&
      !error.uncertain,
  );
});
