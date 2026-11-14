import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as clock from '../src/utils/ssr/serverClock';

test('SSR 시각 기준 오프셋과 Date 표본은 1초 미만의 후퇴를 무시한다', async (t) => {
  const now = Math.floor(Date.now() / 1000) * 1000;
  t.mock.method(Date, 'now', () => now);
  clock.initializeServerClock(new Date(performance.timeOrigin + 900).toISOString(), false);
  clock.sampleServerClock(new Response(null, { headers: { Date: new Date(now).toUTCString() } }));
  const read = () =>
    clock.getFreshServerNow(async () => {
      throw new Error('unexpected request');
    });
  assert.ok(Math.abs(Date.parse(await read()) - (now + 900)) <= 1);
  clock.sampleServerClock(new Response(null, { headers: { Date: new Date(now + 2000).toUTCString() } }));
  assert.equal(Date.parse(await read()), now + 2500);
  clock.sampleServerClock(new Response(null, { headers: { Date: new Date(now + 1000).toUTCString() } }));
  assert.equal(Date.parse(await read()), now + 1500);
  clock.sampleServerClock(new Response(null, { headers: { Date: new Date(now).toUTCString() } }));
  assert.equal(Date.parse(await read()), now + 500);
});
