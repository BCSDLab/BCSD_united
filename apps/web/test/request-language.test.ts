import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLanguageAwarePath } from '../src/utils/language/requestLanguage';

test('서버 값을 번역해 주는 조회 경로만 언어를 붙인다', () => {
  for (const path of [
    '/v3/shops',
    'shops/categories',
    'v2/shops/12',
    'shops/12',
    'shops/12/summary',
    '/dinings',
    '/callvan',
    '/callvan/posts/3',
    '/callvan/posts/3/chat',
    '/callvan/posts/3/summary',
    '/bus/timetable/shuttle/abc123',
    '/bus/timetable/city',
    '/bus/route',
    '/v3/lectures',
    '/v3/timetables/lecture',
    '/v3/timetables/main/lectures',
    'shops/12/summary?foo=1',
  ]) {
    assert.equal(isLanguageAwarePath(path), true, path);
  }
});

test('번역하지 않는 경로는 그대로 둔다', () => {
  for (const path of [
    'shops/12/menus',
    'shops/12/reviews',
    'shops/events',
    'shops/count',
    'v2/shops/search/related',
    '/callvan/notifications',
    '/callvan/posts/3/participants',
    '/v3/timetables/lecture/regular',
    '/bus/courses/shuttle',
    '/v3/users/me',
    'order/shops',
  ]) {
    assert.equal(isLanguageAwarePath(path), false, path);
  }
});
