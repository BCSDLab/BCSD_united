import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolveNaverMapsClientId } from '../scripts/build-target.mjs';

test('배포 빌드는 누락되거나 가짜인 지도 Client ID를 거부한다', () => {
  for (const value of [undefined, '', '   ', 'undefined', 'null']) {
    assert.throws(() => resolveNaverMapsClientId({ NEXT_PUBLIC_NAVER_MAPS_CLIENT_ID: value }, true), Error);
  }
});
