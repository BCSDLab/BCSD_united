import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Hono } from 'hono';
import { createDatabase } from '@api/db/client';
import { getWeather } from '@api/domains/transport/weather';
import type { ApiEnv, Bindings } from '@api/runtime';
import { registerSourceSync } from '@api/source-sync';

const secret = 'integration-source-sync-secret-at-least-32-random-bytes';
class LocalStatement {
  constructor(
    readonly database: DatabaseSync,
    readonly query: string,
    readonly parameters: (string | number | null | Uint8Array)[] = [],
  ) {}
  bind(...parameters: (string | number | null | Uint8Array)[]) {
    return new LocalStatement(this.database, this.query, parameters);
  }
  async first() {
    return this.database.prepare(this.query).get(...this.parameters) ?? null;
  }
  async all() {
    return { results: this.database.prepare(this.query).all(...this.parameters) };
  }
  execute() {
    const stmt = this.database.prepare(this.query);
    const results = stmt.columns().length ? stmt.all(...this.parameters) : [];
    const meta = stmt.columns().length ? { changes: 0 } : stmt.run(...this.parameters);
    return { success: true, results, meta: { changes: meta.changes } };
  }
}
function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url))
    .filter((name) => name.endsWith('.sql'))
    .sort())
    sqlite.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'));
  const binding = {
    prepare: (query: string) => new LocalStatement(sqlite, query),
    batch: async (statements: LocalStatement[]) => {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const result = statements.map((statement) => statement.execute());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
  const app = new Hono<ApiEnv>();
  registerSourceSync(app);
  const env = {
    DB: binding,
    ENVIRONMENT: 'development',
    SOURCE_SYNC_SECRET: secret,
    JOBS: { sendBatch: async () => {} },
  } as unknown as Bindings;
  async function send(payload: Record<string, unknown>, options: { signature?: string; timestamp?: string } = {}) {
    const body = JSON.stringify(payload);
    const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = Array.from(
      new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`))),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('');
    return app.request(
      'http://localhost/internal/source-sync',
      {
        method: 'POST',
        body,
        headers: {
          'content-type': 'application/json',
          'X-Source-Sync-Timestamp': timestamp,
          'X-Source-Sync-Signature': options.signature ?? signature,
        },
      },
      env,
    );
  }
  return { sqlite, binding, send, close: () => sqlite.close() };
}
const envelope = (
  dataset: string,
  checkpoint: string,
  page: number,
  rows: unknown[],
  final = true,
  totalRows = rows.length,
) => ({ version: 1, dataset, checkpoint, page, rows, final, ...(final ? { totalRows } : {}) });
const dining = (menu: string, place = 'A코너') => ({
  date: '2026-10-29',
  type: 'LUNCH',
  place,
  price_card: 5000,
  price_cash: null,
  kcal: null,
  menu,
  is_changed: null,
  image_url: null,
});
const lecture = (name: string, classNumber = '01') => ({
  semester_date: '2026-2',
  code: 'ABC100',
  name,
  grades: '3',
  class: classNumber,
  regular_number: '123',
  department: '컴퓨터공학부',
  target: '전체',
  professor: '교수',
  is_english: 'N',
  design_score: '0',
  is_elearning: 'N',
  class_time: '월1',
});
const weather = (temperature: number, updatedAt: number, expiresAt: number | null) => ({
  id: 'Weather:byeongcheon',
  payload: {
    '202610292000': {
      temperature,
      weather: '맑음',
      weather_id: 1,
      weather_icon_url: 'https://static.koreatech.in/upload/WEATHER/sun-03.webp',
    },
  },
  expires_at: expiresAt,
  updated_at: updatedAt,
});

test('signed paged dining upload preserves local-owned fields; replay, ordering, stale and altered pages are rejected', async () => {
  const f = fixture();
  try {
    f.sqlite.exec(`INSERT INTO dining_menus(id,date,type,place,menu,likes,sold_out,sold_out_source,image_url)
      VALUES(17,'2026-10-29','LUNCH','A코너','old',43,'SOLD_OUT','REPORT','original.jpg')`);
    const first = envelope('dining', '1770000000000', 0, [dining('new')], false);
    assert.equal((await f.send(first)).status, 200);
    assert.equal(f.sqlite.prepare('SELECT menu FROM dining_menus WHERE id=17').get()?.menu, 'old');
    assert.equal((await f.send(envelope('dining', '1770000000000', 2, [], true, 2))).status, 409);
    assert.equal((await f.send({ ...first, rows: [dining('changed')] })).status, 409);
    assert.equal(
      (await f.send(envelope('dining', '1770000000000', 1, [dining('fresh', 'B코너')], true, 2))).status,
      200,
    );
    assert.deepEqual(
      {
        ...f.sqlite
          .prepare('SELECT id,menu,likes,sold_out,sold_out_source,image_url FROM dining_menus WHERE id=17')
          .get(),
      },
      { id: 17, menu: 'new', likes: 43, sold_out: 'SOLD_OUT', sold_out_source: 'REPORT', image_url: 'original.jpg' },
    );
    assert.equal(
      (await f.send(envelope('dining', '1770000000000', 1, [dining('fresh', 'B코너')], true, 2))).status,
      200,
    );
    assert.equal((await f.send(envelope('dining', '1769999999999', 0, [dining('stale')], true))).status, 409);
    assert.equal(
      (await f.send(envelope('dining', '1770000000001', 0, [dining('forged')], true), { signature: '0'.repeat(64) }))
        .status,
      401,
    );
    assert.equal(
      (await f.send(envelope('dining', '1770000000001', 0, [dining('old-time')], true), { timestamp: '1000000000' }))
        .status,
      401,
    );
  } finally {
    f.close();
  }
});

test('interrupted multi-page upload replays each signed prefix exactly, including after commit', async () => {
  const f = fixture();
  try {
    const p0 = envelope('dining', '1770000000000', 0, [dining('one', 'A코너')], false);
    const p1 = envelope('dining', '1770000000000', 1, [dining('two', 'B코너'), dining('three', 'C코너')], false);
    const p2 = envelope('dining', '1770000000000', 2, [dining('four', 'D코너')], true, 4);
    assert.equal((await f.send(p0)).status, 200);
    assert.equal((await f.send(p1)).status, 200);
    assert.equal(f.sqlite.prepare('SELECT count(*) count FROM dining_menus').get()?.count, 0);
    const replay0 = await f.send(p0);
    assert.equal(replay0.status, 200);
    assert.deepEqual(await replay0.json(), {
      version: 1,
      dataset: 'dining',
      checkpoint: '1770000000000',
      page: 0,
      stagedRows: 1,
      appliedRows: 0,
      completed: false,
    });
    const replay1 = await f.send(p1);
    assert.equal(replay1.status, 200);
    assert.deepEqual(await replay1.json(), {
      version: 1,
      dataset: 'dining',
      checkpoint: '1770000000000',
      page: 1,
      stagedRows: 3,
      appliedRows: 0,
      completed: false,
    });
    assert.equal((await f.send({ ...p0, rows: [dining('altered', 'A코너')] })).status, 409);
    assert.equal((await f.send(p2)).status, 200);
    assert.equal(f.sqlite.prepare('SELECT count(*) count FROM dining_menus').get()?.count, 4);
    const committedReplay = await f.send(p0);
    assert.equal(committedReplay.status, 200);
    assert.deepEqual(await committedReplay.json(), {
      version: 1,
      dataset: 'dining',
      checkpoint: '1770000000000',
      page: 0,
      stagedRows: 1,
      appliedRows: 4,
      completed: true,
    });
    assert.equal((await f.send({ ...p1, rows: [dining('altered', 'B코너')] })).status, 409);
  } finally {
    f.close();
  }
});

test('failed final page never partly applies, and a corrected newer checkpoint supersedes incomplete staging', async () => {
  const f = fixture();
  try {
    const a = envelope('dining', '1770000000000', 0, [dining('A')], false);
    assert.equal((await f.send(a)).status, 200);
    assert.equal((await f.send(envelope('dining', '1770000000000', 1, [dining('duplicate')], true, 2))).status, 409);
    assert.equal(f.sqlite.prepare('SELECT count(*) count FROM dining_menus').get()?.count, 0);
    assert.equal((await f.send(envelope('dining', '1770000000001', 0, [dining('fixed')], true))).status, 200);
    assert.equal(f.sqlite.prepare('SELECT menu FROM dining_menus').get()?.menu, 'fixed');
  } finally {
    f.close();
  }
});

test('portal identity maps existing migrated article and attachment without touching native hits', async () => {
  const f = fixture();
  try {
    f.sqlite.exec(`INSERT INTO boards(id,name) VALUES(1,'공지');
      INSERT INTO new_articles(id,board_id,title,hit) VALUES(9,1,'기존공지',11);
      INSERT INTO new_koreatech_articles(article_id,author,portal_num,portal_hit,url) VALUES(9,'Old',42,7,'https://portal/old');
      INSERT INTO native_article_ngram(article_id,position,token) VALUES(9,0,'기존')`);
    const row = {
      board_id: 1,
      portal_num: 42,
      title: '수정공지',
      content: 'https://object/content',
      is_notice: 1,
      is_deleted: 0,
      author: 'Source',
      portal_hit: 19,
      url: 'https://portal/new',
      registered_at: '2026-10-29 08:30:00.123456',
      attachments: [{ hash: 'a'.repeat(64), url: 'https://object/attach', name: 'file', is_deleted: 0 }],
    };
    assert.equal((await f.send(envelope('articles', '1770000000000', 0, [row]))).status, 200);
    assert.deepEqual(
      {
        ...f.sqlite
          .prepare(
            'SELECT a.id,a.title,a.hit,k.portal_hit,k.registered_at FROM new_articles a JOIN new_koreatech_articles k ON k.article_id=a.id',
          )
          .get(),
      },
      { id: 9, title: '수정공지', hit: 11, portal_hit: 19, registered_at: '2026-10-29 08:30:00.123456' },
    );
    assert.equal(f.sqlite.prepare('SELECT count(*) count FROM article_attachments WHERE article_id=9').get()?.count, 1);
    assert.equal(
      f.sqlite.prepare(`SELECT count(*) count FROM native_article_ngram WHERE article_id=9 AND token='수정'`).get()
        ?.count,
      1,
    );
    assert.equal(
      f.sqlite.prepare(`SELECT count(*) count FROM native_article_ngram WHERE article_id=9 AND token='기존'`).get()
        ?.count,
      0,
    );
    assert.equal(
      (await f.send(envelope('articles', '1770000000001', 0, [{ ...row, registered_at: '2026-10-29T08:30:00Z' }])))
        .status,
      400,
    );
  } finally {
    f.close();
  }
});

test('duplicate lecture fingerprints retain original timetable-linked identities; ambiguous changed duplicates reject atomically', async () => {
  const f = fixture();
  try {
    const row = lecture('Original');
    const insert = f.sqlite.prepare(
      'INSERT INTO lectures(id,semester_date,code,name,grades,class,regular_number,department,target,professor,is_english,design_score,is_elearning,class_time) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    for (const id of [10, 11]) insert.run(id, ...Object.values(row));
    f.sqlite.exec(`INSERT INTO users(id,password,user_type,anonymous_nickname) VALUES(1,'hash','STUDENT','a');
      INSERT INTO timetable_frame(id,user_id,semester_id,name) VALUES(1,1,1,'2026-2');
      INSERT INTO timetable_lecture(id,frame_id,lectures_id) VALUES(1,1,11)`);
    assert.equal((await f.send(envelope('lectures', '1770000000000', 0, [row, row]))).status, 200);
    assert.equal(f.sqlite.prepare('SELECT lectures_id FROM timetable_lecture WHERE id=1').get()?.lectures_id, 11);
    assert.equal((await f.send(envelope('lectures', '1770000000001', 0, [row, lecture('Changed 2')]))).status, 200);
    assert.equal(f.sqlite.prepare('SELECT name FROM lectures WHERE id=11').get()?.name, 'Changed 2');
    assert.equal(
      (await f.send(envelope('lectures', '1770000000002', 0, [lecture('Changed 1'), lecture('Changed 3')]))).status,
      409,
    );
    assert.deepEqual(
      f.sqlite
        .prepare('SELECT id,name FROM lectures ORDER BY id')
        .all()
        .map((entry) => ({ ...entry })),
      [
        { id: 10, name: 'Original' },
        { id: 11, name: 'Changed 2' },
      ],
    );
  } finally {
    f.close();
  }
});

test('source semester/version and citybus updates do not alter unrelated native versions or prune unseen routes', async () => {
  const f = fixture();
  try {
    f.sqlite
      .exec(`INSERT INTO versions(id,version,type,title) VALUES(1,'1.0','app','Native'),(2,'2026-1','timetable','Old');
      INSERT INTO citybus_timetables(id,bus_info,bus_timetables,updated_at) VALUES('retain','{}','[]','2026-10-01 00:00:00')`);
    assert.equal(
      (await f.send(envelope('semesters', '1770000000000', 0, [{ semester: '2026-2', year: 2026, term: 'FALL' }])))
        .status,
      200,
    );
    assert.equal(
      (
        await f.send(
          envelope('versions', '1770000000000', 0, [
            { version: '2026-1', type: 'timetable', title: 'New', is_previous: 0, content: null },
          ]),
        )
      ).status,
      200,
    );
    assert.equal(f.sqlite.prepare('SELECT title FROM versions WHERE id=1').get()?.title, 'Native');
    assert.equal(f.sqlite.prepare('SELECT title FROM versions WHERE id=2').get()?.title, 'New');
    assert.equal(
      (
        await f.send(
          envelope('citybus', '1770000000000', 0, [
            { id: 'route', bus_info: { route: '1' }, bus_timetables: [], updated_at: '2026-10-29 12:00:00' },
          ]),
        )
      ).status,
      200,
    );
    assert.equal(f.sqlite.prepare('SELECT count(*) count FROM citybus_timetables').get()?.count, 2);
  } finally {
    f.close();
  }
});

test('signed weather upload populates the consumer cache without replacing a newer native refresh', async () => {
  const f = fixture();
  try {
    const now = Date.UTC(2026, 9, 29, 11, 12);
    const initial = weather(13, now - 1_000, now + 86_400_000);
    assert.equal((await f.send(envelope('weather', '1770000000000', 0, [initial]))).status, 200);
    const row = () =>
      f.sqlite
        .prepare('SELECT payload,expires_at,updated_at FROM native_transport_cache WHERE id=?')
        .get('Weather:byeongcheon')!;
    assert.deepEqual(JSON.parse(row().payload as string), initial.payload);
    assert.equal(row().expires_at, initial.expires_at);
    assert.equal(row().updated_at, initial.updated_at);
    assert.deepEqual(
      await getWeather(createDatabase(f.binding), { OPEN_API_KEY_PUBLIC: undefined } as Bindings, now),
      initial.payload['202610292000'],
    );
    f.sqlite
      .prepare('UPDATE native_transport_cache SET payload=?,expires_at=?,updated_at=? WHERE id=?')
      .run(JSON.stringify(weather(21, now + 200, null).payload), null, now + 200, 'Weather:byeongcheon');
    assert.equal(
      (await f.send(envelope('weather', '1770000000001', 0, [weather(8, now + 100, now + 86_400_100)]))).status,
      200,
    );
    assert.equal(JSON.parse(row().payload as string)['202610292000'].temperature, 21);
    assert.equal(row().expires_at, null);
    assert.equal(row().updated_at, now + 200);
    const newest = weather(25, now + 300, now + 86_400_300);
    assert.equal((await f.send(envelope('weather', '1770000000002', 0, [newest]))).status, 200);
    assert.deepEqual(JSON.parse(row().payload as string), newest.payload);
    assert.equal(row().expires_at, newest.expires_at);
    assert.equal(row().updated_at, newest.updated_at);
    assert.equal((await f.send(envelope('weather', '1770000000003', 0, []))).status, 200);
    assert.deepEqual(JSON.parse(row().payload as string), newest.payload);
    assert.equal(row().expires_at, newest.expires_at);
  } finally {
    f.close();
  }
});

test('weather sync rejects arbitrary cache identities, credentials, malformed forecasts and duplicate rows', async () => {
  const f = fixture();
  try {
    const valid = weather(13, 1_770_000_000_000, null);
    const forbidden = [
      { ...valid, id: 'auth:session' },
      { ...valid, token: 'private-credential' },
      {
        ...valid,
        payload: {
          ...valid.payload,
          '202610292100': { ...valid.payload['202610292000'], apiKey: 'private-credential' },
        },
      },
      { ...valid, payload: { token: 'private-credential' } },
      { ...valid, updated_at: 1.5 },
      {
        ...valid,
        payload: {
          '202610292000': { ...valid.payload['202610292000'], weather_icon_url: 'http://example.invalid/token' },
        },
      },
      { ...valid, payload: { '202610292030': valid.payload['202610292000'] } },
      { ...valid, payload: {} },
    ];
    for (const row of forbidden)
      assert.equal((await f.send(envelope('weather', '1770000000000', 0, [row]))).status, 400);
    assert.equal((await f.send(envelope('weather', '1770000000000', 0, [valid, valid]))).status, 409);
    assert.equal(f.sqlite.prepare('SELECT count(*) count FROM native_transport_cache').get()?.count, 0);
    assert.equal((await f.send(envelope('weather', '1770000000001', 0, [valid]))).status, 200);
    assert.equal(f.sqlite.prepare('SELECT count(*) count FROM native_transport_cache').get()?.count, 1);
  } finally {
    f.close();
  }
});
