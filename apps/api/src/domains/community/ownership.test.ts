import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { Hono } from 'hono';
import { ApiError } from '@api/errors';
import { assertLostItemEditable, assertLostItemOwner, lostItemTitle } from '@api/domains/community/lost-items';
import { keywordNotifications, normalizeKeyword } from '@api/domains/community/keywords';
import { integer, paging } from '@api/domains/community/store';
import type { ApiEnv } from '@api/runtime';

test('integer bindings preserve signed 32-bit bounds and defaults apply only to missing values', () => {
  for (const value of ['-2147483648', '-1', '0', '1', '2147483647']) assert.equal(integer(value), Number(value));
  assert.equal(integer(undefined, 10), 10);
  assert.equal(integer(undefined, 0), 0);
  assert.throws(() => integer(undefined), ApiError);
  for (const value of ['', ' ', '1.5', '1e3', '2147483648', '-2147483649', '9007199254740993']) {
    assert.throws(() => integer(value, 10), ApiError);
  }
});

test('pagination defaults and positive bounds are applied after integer parsing', async () => {
  const app = new Hono<ApiEnv>();
  app.get('/', (c) => c.json(paging(c, 95)));
  assert.deepEqual(await (await app.request('/')).json(), { page: 1, limit: 10, offset: 0 });
  assert.deepEqual(await (await app.request('/?page=-1&limit=0')).json(), { page: 1, limit: 1, offset: 0 });
  assert.deepEqual(await (await app.request('/?page=2147483647&limit=2147483647')).json(), {
    page: 2,
    limit: 50,
    offset: 50,
  });
});

test('lost item mutations reject nonauthors and withdrawn authors', () => {
  assert.doesNotThrow(() => assertLostItemOwner(12, 12));
  for (const author of [13, null])
    assert.throws(
      () => assertLostItemOwner(author, 12),
      (error) => error instanceof ApiError && error.status === 403 && error.code === 'FORBIDDEN_AUTHOR',
    );
});
test('found item contents cannot be edited and generated titles preserve source format', () => {
  assert.doesNotThrow(() => assertLostItemEditable(false));
  assert.throws(
    () => assertLostItemEditable(true),
    (error) => error instanceof ApiError && error.code === 'CANNOT_UPDATE_FOUND_ITEM',
  );
  assert.equal(lostItemTitle('신분증', '학생회관', '2026-01-02'), '신분증 | 학생회관 | 26.01.02');
});
test('keywords reject internal spaces before trimming and normalize case', () => {
  assert.equal(normalizeKeyword('BCSD'), 'bcsd');
  assert.equal(normalizeKeyword('\tBCSD\t'), 'bcsd');
  assert.throws(() => normalizeKeyword(' 장학'), ApiError);
  assert.throws(() => normalizeKeyword('장학\n금'), ApiError);
});
test('durable audience snapshots choose longest keyword and exclude author and unsubscribed users', () => {
  const db = new DatabaseSync(':memory:');
  const dialect = new SQLiteSyncDialect();
  try {
    db.exec(`
      CREATE TABLE new_articles(id INTEGER PRIMARY KEY,title TEXT,board_id INTEGER,is_deleted INTEGER);
      CREATE TABLE article_keywords(id INTEGER PRIMARY KEY,keyword TEXT,category TEXT,is_deleted INTEGER);
      CREATE TABLE article_keyword_user_map(id INTEGER PRIMARY KEY,user_id INTEGER,keyword_id INTEGER,is_deleted INTEGER);
      CREATE TABLE users(id INTEGER PRIMARY KEY,is_deleted INTEGER,device_token TEXT);
      CREATE TABLE notification_subscribe(user_id INTEGER,subscribe_type TEXT,detail_type TEXT);
      CREATE TABLE native_community_outbox(id TEXT PRIMARY KEY,kind TEXT,payload TEXT,created_at INTEGER);
      INSERT INTO new_articles VALUES(44,'학생증 | 학생회관 | 26.01.02',14,0);
      INSERT INTO article_keywords VALUES(1,'학생','LOST_ITEM',0),(2,'학생증','LOST_ITEM',0),(3,'학생회관','LOST_ITEM',1);
      INSERT INTO users VALUES(1,0,'author-token'),(2,0,'recipient-token'),(3,0,'unsubscribed-token'),(4,0,NULL);
      INSERT INTO article_keyword_user_map VALUES(1,1,1,0),(2,2,1,0),(3,2,2,0),(4,2,3,0),(5,3,2,0),(6,4,2,0);
      INSERT INTO notification_subscribe VALUES(1,'LOST_ITEM_KEYWORD',NULL),(2,'LOST_ITEM_KEYWORD',NULL),(4,'LOST_ITEM_KEYWORD',NULL);
    `);
    const query = dialect.sqlToQuery(keywordNotifications(44, 'LOST_ITEM', 1));
    db.prepare(query.sql).all(...(query.params as (string | number | null)[]));
    const deliveries = db
      .prepare('SELECT payload FROM native_community_outbox')
      .all()
      .map((row) => JSON.parse(String(row.payload)));
    assert.equal(deliveries.length, 1);
    assert.deepEqual(deliveries[0], {
      userId: 2,
      title: '학생증 | 학생회관 | 26.01.02',
      message: '방금 등록된 학생증 분실물 게시물을 확인해보세요!',
      mobileAppPath: 'LOST_ITEM',
      schemeUri: 'lost-item?id=44&keyword=학생증',
      type: 'MESSAGE',
    });
    db.exec("UPDATE article_keywords SET keyword='바뀐키워드'; DELETE FROM notification_subscribe;");
    assert.equal(
      JSON.parse(String(db.prepare('SELECT payload FROM native_community_outbox').get()!.payload)).schemeUri,
      'lost-item?id=44&keyword=학생증',
    );
  } finally {
    db.close();
  }
});
