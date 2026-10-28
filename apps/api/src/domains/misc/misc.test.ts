import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { registerBanners, validateBannerRelease } from '@api/domains/misc/banners';
import { formatBusRemain, kakaoText } from '@api/domains/misc/kakao';
import { registerNotifications, notificationStatus } from '@api/domains/misc/notifications';
import { registerVersions, isPlatformVersion } from '@api/domains/misc/versions';
import { kstDate, kstTimestamp } from '@api/domains/misc/helpers';
import { registerLands } from '@api/domains/misc/lands';
import { ApiError } from '@api/errors';
import type { ApiEnv, Principal } from '@api/runtime';

const banner = {
  title: '배너', image_url: 'https://example.com/banner.png',
  is_web_released: false, web_redirect_link: null,
  is_android_released: false, android_redirect_link: null, android_minimum_version: null,
  is_ios_released: false, ios_redirect_link: null, ios_minimum_version: null,
};
test('mobile banners allow a released image without a deep link but reject half pairs', () => {
  assert.doesNotThrow(() => validateBannerRelease({ ...banner, is_android_released: true }));
  assert.doesNotThrow(() => validateBannerRelease({ ...banner, is_android_released: true, android_redirect_link: 'koin://home', android_minimum_version: '3.0' }));
  assert.throws(() => validateBannerRelease({ ...banner, is_android_released: true, android_redirect_link: 'koin://home' }));
  assert.throws(() => validateBannerRelease({ ...banner, android_redirect_link: 'koin://home', android_minimum_version: '3.0' }));
  assert.throws(() => validateBannerRelease({ ...banner, web_redirect_link: 'https://example.com' }));
});
test('notification token rejection leaves stored category and meal preferences intact', () => {
  const status = notificationStatus(null, [{ subscribe_type: 'DINING_SOLD_OUT', detail_type: 'LUNCH' }, { subscribe_type: 'MARKETING', detail_type: null }]);
  assert.equal(status.is_permit, false);
  const dining = status.subscribes.find(({ type }) => type === 'DINING_SOLD_OUT')!;
  assert.equal(dining.is_permit, false);
  assert.deepEqual(dining.detail_subscribes.map(({ is_permit }) => is_permit), [false, true, false]);
  assert.equal(status.subscribes.find(({ type }) => type === 'MARKETING')!.is_permit, true);
  assert.equal(notificationStatus('   ', []).is_permit, false);
  assert.equal(notificationStatus('fcm-token', []).is_permit, true);
});
test('platform versions create history while data catalog versions update in place', () => {
  for (const type of ['android', 'ios', 'android_owner']) assert.equal(isPlatformVersion(type), true);
  for (const type of ['timetable', 'shuttle_bus_timetable', 'city_bus_timetable', 'express_bus_timetable']) assert.equal(isPlatformVersion(type), false);
});
test('Kakao remaining-time text preserves hour and minute boundaries', () => {
  assert.equal(formatBusRemain('셔틀버스', 3599), '셔틀버스, 0시간 59분 59초 남음');
  assert.equal(formatBusRemain('셔틀버스', 3600), '셔틀버스, 1시간 0분 0초 남음');
  assert.equal(formatBusRemain('셔틀버스', 0), '셔틀버스, 0시간 0분 0초 남음');
  assert.deepEqual(kakaoText(['메뉴']).template.outputs, [{ simpleText: { text: '메뉴' } }]);
});
test('KST business dates switch at 15:00 UTC independently of host timezone', () => {
  assert.equal(kstDate(Date.parse('2026-10-28T14:59:59Z')), '2026-10-28');
  assert.equal(kstDate(Date.parse('2026-10-28T15:00:00Z')), '2026-10-29');
  assert.equal(kstTimestamp('2026-10-28 15:00:00'), '2026-10-29 00:00:00');
});

test('catalog administration rejects anonymous and every non-admin role before database access', async () => {
  const principals: (Principal | null)[] = [null, ...(['GENERAL', 'STUDENT', 'COUNCIL', 'OWNER', 'COOP'] as const).map((userType) => ({ id: 1, userType }))];
  for (const principal of principals) {
    const app = new Hono<ApiEnv>();
    app.use('*', async (c, next) => { c.set('principal', principal); await next(); });
    app.onError((error) => Response.json({}, { status: error instanceof ApiError ? error.status : 500 }));
    registerBanners(app);
    registerVersions(app);
    registerLands(app);
    for (const [method, path] of [['POST', '/admin/banners'], ['DELETE', '/admin/banners/1'], ['PATCH', '/admin/banners/1/priority'], ['POST', '/admin/version/android'], ['PUT', '/admin/lands/1']] as const) {
      const response = await app.request(path, { method });
      assert.equal(response.status, principal ? 403 : 401, `${principal?.userType ?? 'anonymous'} ${path}`);
    }
  }
});

test('admin identities cannot mutate ordinary-user notification preferences', async () => {
  const app = new Hono<ApiEnv>();
  app.use('*', async (c, next) => { c.set('principal', { id: 1, userType: 'ADMIN' }); await next(); });
  app.onError((error) => Response.json({}, { status: error instanceof ApiError ? error.status : 500 }));
  registerNotifications(app);
  assert.equal((await app.request('/notification', { method: 'DELETE' })).status, 403);
  assert.equal((await app.request('/notification/subscribe?type=MARKETING', { method: 'POST' })).status, 403);
});
