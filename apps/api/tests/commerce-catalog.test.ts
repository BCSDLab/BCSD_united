import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCatalogShopOpen, sanitizeCatalogSearch, type Opening } from '@api/domains/commerce/catalog-data';

const mondayNight: Opening = { day_of_week: 'MONDAY', closed: false, open_time: '22:00', close_time: '02:00' };

test('shop opening intervals use KST and carry previous-day overnight hours', () => {
  assert.equal(isCatalogShopOpen([mondayNight], Date.parse('2026-10-26T13:00:00Z')), true);
  assert.equal(isCatalogShopOpen([mondayNight], Date.parse('2026-10-26T16:30:00Z')), true);
  assert.equal(isCatalogShopOpen([mondayNight], Date.parse('2026-10-26T17:00:00Z')), true);
  assert.equal(isCatalogShopOpen([mondayNight], Date.parse('2026-10-26T17:00:00.001Z')), false);
  assert.equal(isCatalogShopOpen([mondayNight], Date.parse('2026-10-26T12:59:59Z')), false);
});

test('equal opening and closing times mean a full day and closed rows never open', () => {
  const allDay = { ...mondayNight, open_time: '09:00', close_time: '09:00' };
  assert.equal(isCatalogShopOpen([allDay], Date.parse('2026-10-26T23:59:59Z')), true);
  assert.equal(isCatalogShopOpen([{ ...allDay, closed: true }], Date.parse('2026-10-26T10:00:00Z')), false);
  assert.equal(isCatalogShopOpen([], Date.parse('2026-10-26T10:00:00Z')), false);
});

test('related search drops incomplete Hangul and punctuation without merging separate terms', () => {
  assert.deepEqual(sanitizeCatalogSearch(' 치킨ㄱ  피자ㅏ!\tABC-123 '), ['치킨', '피자', 'ABC123']);
  assert.deepEqual(sanitizeCatalogSearch('ㄱ ㅏ !'), []);
  assert.deepEqual(sanitizeCatalogSearch('   '), []);
  assert.deepEqual(sanitizeCatalogSearch('짜장 짜장'), ['짜장', '짜장']);
});
