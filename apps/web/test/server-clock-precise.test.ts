import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as clock from '../src/utils/ssr/serverClock';

test('정밀한 SSR 시각을 초 단위 Date 표본으로 뒤로 돌리지 않는다', async (t) => {
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  clock.initializeServerClock(new Date(performance.timeOrigin + 900).toISOString(), false);
  clock.sampleServerClock(new Response(null, { headers: { Date: new Date(now).toUTCString() } }));
  const result = await clock.getFreshServerNow(async () => {
    throw new Error('unexpected request');
  });
  assert.ok(Date.parse(result) - Date.now() > 850);
});
