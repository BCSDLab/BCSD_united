import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as clock from '../src/utils/ssr/serverClock';

test('공유 문서의 실패한 표본은 이동에만 사용하고 다음 이동에서 다시 조회한다', async (t) => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  clock.initializeServerClock(new Date(performance.timeOrigin + 10_000).toISOString(), true);
  let calls = 0;
  const fail = async () => {
    calls++;
    throw new Error('offline');
  };
  const [first, concurrent] = await Promise.all([clock.getFreshServerNow(fail), clock.getFreshServerNow(fail)]);
  assert.equal(calls, 1);
  assert.ok(Math.abs(Date.parse(first) - (now + 10_000)) < 1000);
  assert.equal(first, concurrent);
  await clock.getFreshServerNow(async () => {
    calls++;
    clock.sampleServerClock(new Response(null, { status: 403, headers: { Date: new Date(now).toUTCString() } }));
    throw new Error('forbidden');
  });
  assert.equal(calls, 2);
  await clock.getFreshServerNow(fail);
  assert.equal(calls, 2);
});
