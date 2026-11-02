import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Hono } from 'hono';
import type { ApiEnv, Bindings } from '@api/runtime';
import { registerSourceSync } from '@api/source-sync';

const secret = 'integration-source-sync-secret-at-least-32-random-bytes';
const checkpoint = (offset: number) => String(1_770_000_000_000 + offset);
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
function fixture(
  syncEnabled: string | null = 'true',
  beforeBatch?: (database: DatabaseSync, statements: LocalStatement[]) => void,
) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  for (const file of readdirSync(new URL('../drizzle/', import.meta.url))
    .filter((name) => name.endsWith('.sql'))
    .sort())
    sqlite.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url), 'utf8'));
  sqlite.exec(`CREATE TABLE sync_audit(name TEXT NOT NULL, action TEXT, hash TEXT);
    CREATE TRIGGER audit_article_update AFTER UPDATE ON new_articles BEGIN INSERT INTO sync_audit(name) VALUES('article'); END;
    CREATE TRIGGER audit_portal_update AFTER UPDATE ON new_koreatech_articles BEGIN INSERT INTO sync_audit(name) VALUES('portal'); END;
    CREATE TRIGGER audit_attachment_update AFTER UPDATE ON article_attachments BEGIN
      INSERT INTO sync_audit(name,action,hash) VALUES('attachment','UPDATE',lower(hex(NEW.hash))); END;
    CREATE TRIGGER audit_attachment_insert AFTER INSERT ON article_attachments BEGIN
      INSERT INTO sync_audit(name,action,hash) VALUES('attachment','INSERT',lower(hex(NEW.hash))); END;
    CREATE TRIGGER audit_attachment_delete AFTER DELETE ON article_attachments BEGIN
      INSERT INTO sync_audit(name,action,hash) VALUES('attachment','DELETE',lower(hex(OLD.hash))); END;
    CREATE TRIGGER audit_gram_update AFTER UPDATE ON native_article_ngram BEGIN INSERT INTO sync_audit(name) VALUES('gram'); END;
    CREATE TRIGGER audit_gram_insert AFTER INSERT ON native_article_ngram BEGIN INSERT INTO sync_audit(name) VALUES('gram'); END;
    CREATE TRIGGER audit_gram_delete AFTER DELETE ON native_article_ngram BEGIN INSERT INTO sync_audit(name) VALUES('gram'); END;`);
  let databaseAccess = 0;
  const binding = {
    prepare: (query: string) => {
      databaseAccess++;
      return new LocalStatement(sqlite, query);
    },
    batch: async (statements: LocalStatement[]) => {
      databaseAccess++;
      beforeBatch?.(sqlite, statements);
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
    SOURCE_SYNC_ENABLED: syncEnabled ?? undefined,
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
  function changes(name: string) {
    return sqlite.prepare('SELECT count(*) count FROM sync_audit WHERE name=?').get(name)?.count as number;
  }
  return { sqlite, send, changes, databaseAccess: () => databaseAccess, close: () => sqlite.close() };
}
const delta = (
  dataset: string,
  offset: number,
  upserts: unknown[] = [],
  deletes: unknown[] = [],
  page = 0,
  final = true,
) => ({ version: 2, dataset, checkpoint: checkpoint(offset), page, final, upserts, deletes });
const baseline = (dataset: string, keys: unknown[]) => ({ version: 2, action: 'baseline', dataset, keys });
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
const article = (title = '학교 공지', portal_hit = 19, attachments: unknown[] = []) => ({
  board_id: 1,
  portal_num: 42,
  title,
  content: 'https://object/content',
  is_notice: 1,
  is_deleted: 0,
  author: 'Source',
  portal_hit,
  url: 'https://portal/new',
  registered_at: '2026-10-29 08:30:00.123456',
  attachments,
});
const attachment = (hash: string, name: string) => ({
  hash: hash.repeat(64),
  url: 'https://object/attach',
  name,
  is_deleted: 0,
});

test('sync remains paused by default or explicit false before any database access, even for valid signed requests', async () => {
  for (const setting of [null, 'false', 'TRUE', '1']) {
    const f = fixture(setting);
    try {
      const before = f.sqlite.prepare('SELECT total_changes() count').get()?.count;
      for (const payload of [
        baseline('dining', [['2026-10-29', 'LUNCH', 'A코너']]),
        delta('dining', 0, [dining('would write')]),
      ]) {
        const response = await f.send(payload);
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { error: 'SOURCE_SYNC_DISABLED' });
      }
      assert.equal(f.databaseAccess(), 0);
      assert.equal(f.sqlite.prepare('SELECT total_changes() count').get()?.count, before);
    } finally {
      f.close();
    }
  }
});

test('read-only authenticated keyed baseline and strict v2 allowlist/key limits', async () => {
  const f = fixture();
  try {
    f.sqlite.exec(
      `INSERT INTO dining_menus(id,date,type,place,menu,likes) VALUES(17,'2026-10-29','LUNCH','A코너','old',43)`,
    );
    const before = f.sqlite.prepare('SELECT total_changes() count').get()?.count;
    const read = await f.send(
      baseline('dining', [
        ['2026-10-29', 'lunch', 'A코너'],
        ['2026-10-29', 'LUNCH', 'B코너'],
      ]),
    );
    assert.equal(read.status, 200);
    assert.deepEqual(((await read.json()) as { rows: unknown[] }).rows, [{ ...dining('old'), price_card: null }]);
    assert.equal(f.sqlite.prepare('SELECT total_changes() count').get()?.count, before);
    assert.equal(
      (
        await f.send(
          baseline('dining', [
            ['2026-10-29', 'LUNCH', 'A코너'],
            ['2026-10-29', 'lunch', 'A코너'],
          ]),
        )
      ).status,
      400,
    );
    assert.equal((await f.send(baseline('dining', [['2026-10-29', 'LUNCH']]))).status, 400);
    assert.equal((await f.send(delta('dining', 0, [{ ...dining('x'), likes: 0 }]))).status, 400);
    assert.equal((await f.send(delta('articles', 0, [{ ...article(), hit: 8 }]))).status, 400);
    assert.equal(
      (
        await f.send({
          version: 1,
          dataset: 'dining',
          checkpoint: checkpoint(0),
          page: 0,
          final: true,
          rows: [dining('x')],
        })
      ).status,
      400,
    );
    assert.equal((await f.send(delta('dining', 0, [dining('x'), dining('y')]))).status, 400);
    assert.equal((await f.send(delta('dining', 0, [dining('x')], [['2026-10-29', 'LUNCH', 'A코너']]))).status, 400);
    assert.equal((await f.send(delta('dining', 0))).status, 400);
    const manyKeys = Array.from({ length: 101 }, (_, i) => ['2026-10-29', 'LUNCH', String(i)]);
    assert.equal(
      (
        await f.send(
          delta(
            'dining',
            0,
            manyKeys.map((key) => dining('x', key[2]!)),
          ),
        )
      ).status,
      400,
    );
    assert.equal((await f.send(baseline('dining', manyKeys))).status, 400);
    assert.equal(
      (
        await f.send(
          delta('articles', 0, [
            {
              ...article(),
              content: 'a'.repeat(200_000),
              attachments: [{ ...attachment('c', 'file'), url: 'b'.repeat(100_000) }],
            },
          ]),
        )
      ).status,
      413,
    );
    assert.equal(
      (await f.send(delta('weather', 0, [{ id: 'session:key', payload: {}, expires_at: null, updated_at: 1 }]))).status,
      400,
    );
    assert.equal((await f.send(delta('dining', 0, [dining('x')]), { signature: '0'.repeat(64) })).status, 401);
    assert.equal((await f.send(delta('dining', 0, [dining('x')]), { timestamp: '1000000000' })).status, 401);
    assert.equal(f.sqlite.prepare('SELECT total_changes() count').get()?.count, before);
  } finally {
    f.close();
  }
});

test('keyed article baseline uses one indexed D1 read and bounds the entire response to 1 MiB', async () => {
  const f = fixture();
  try {
    f.sqlite.exec(`INSERT INTO boards(id,name) VALUES(1,'공지')`);
    const newArticle = f.sqlite.prepare('INSERT INTO new_articles(id,board_id,title,content) VALUES(?,1,?,?)');
    const portal = f.sqlite.prepare(
      'INSERT INTO new_koreatech_articles(article_id,author,portal_num,url) VALUES(?,?,?,?)',
    );
    const keys = [];
    for (let number = 1; number <= 100; number++) {
      newArticle.run(number, `Title ${number}`, 'short');
      portal.run(number, 'Source', number, 'https://portal/notice');
      keys.push([1, number]);
    }
    const initialWrites = f.sqlite.prepare('SELECT total_changes() count').get()?.count;
    const read = await f.send(baseline('articles', keys));
    assert.equal(read.status, 200);
    assert.equal(((await read.json()) as { rows: unknown[] }).rows.length, 100);
    assert.equal(f.databaseAccess(), 1);
    assert.equal(f.sqlite.prepare('SELECT total_changes() count').get()?.count, initialWrites);

    const enlarge = f.sqlite.prepare('UPDATE new_articles SET content=? WHERE id=?');
    for (let number = 1; number <= 6; number++) enlarge.run('x'.repeat(200_000), number);
    const before = f.sqlite.prepare('SELECT total_changes() count').get()?.count;
    const oversized = await f.send(baseline('articles', keys.slice(0, 6)));
    assert.equal(oversized.status, 413);
    assert.deepEqual(await oversized.json(), { error: 'BASELINE_TOO_LARGE' });
    assert.equal(f.databaseAccess(), 2);
    assert.equal(f.sqlite.prepare('SELECT total_changes() count').get()?.count, before);
    const split = await f.send(baseline('articles', keys.slice(0, 3)));
    assert.equal(split.status, 200);
    assert.equal(((await split.json()) as { rows: unknown[] }).rows.length, 3);
    assert.equal(f.databaseAccess(), 3);
    assert.equal(f.sqlite.prepare('SELECT total_changes() count').get()?.count, before);
  } finally {
    f.close();
  }
});

test('each page commits atomically; replay zero writes, ordered checkpoints, failed page rolls back', async () => {
  const f = fixture();
  try {
    f.sqlite.exec(`INSERT INTO dining_menus(id,date,type,place,menu,likes,sold_out,sold_out_source,image_url)
      VALUES(17,'2026-10-29','LUNCH','A코너','old',43,'SOLD_OUT','REPORT','original.jpg')`);
    const p0 = delta('dining', 0, [dining('new')], [], 0, false);
    assert.equal((await f.send(p0)).status, 200);
    assert.equal(f.sqlite.prepare('SELECT menu FROM dining_menus WHERE id=17').get()?.menu, 'new');
    const before = f.sqlite.prepare('SELECT total_changes() count').get()?.count;
    const replay = await f.send(p0);
    assert.deepEqual(await replay.json(), {
      version: 2,
      dataset: 'dining',
      checkpoint: checkpoint(0),
      page: 0,
      appliedRows: 1,
      completed: true,
    });
    assert.equal(f.sqlite.prepare('SELECT total_changes() count').get()?.count, before);
    assert.equal((await f.send({ ...p0, upserts: [dining('altered')] })).status, 409);
    assert.equal((await f.send(delta('dining', 0, [dining('reordered')], [], 2))).status, 409);
    assert.equal((await f.send(delta('dining', 1, [dining('too soon')]))).status, 409);
    const p1 = delta('dining', 0, [dining('new', 'B코너')], [], 1);
    assert.equal((await f.send(p1)).status, 200);
    assert.equal(
      (await f.send(delta('dining', 1, [dining('failing', 'C코너')], [['2026-10-29', 'LUNCH', 'C코너']]))).status,
      400,
    );
    assert.equal(
      (await f.send(delta('dining', 1, [dining('one', 'C코너')], [['2026-10-29', 'LUNCH', 'Z코너']]))).status,
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
    assert.equal((await f.send(delta('dining', 0, [dining('stale')]))).status, 409);
    const failed = delta('articles', 0, [article()]);
    assert.equal((await f.send(failed)).status, 409);
    assert.equal(
      f.sqlite.prepare('SELECT count(*) count FROM native_source_sync_v2_receipt WHERE dataset=?').get('articles')
        ?.count,
      0,
    );
    f.sqlite.exec(`INSERT INTO boards(id,name) VALUES(1,'공지')`);
    assert.equal((await f.send(failed)).status, 200);
    const atomic = delta('articles', 1, [
      { ...article('Should rollback'), portal_num: 43 },
      { ...article('Missing board'), board_id: 2, portal_num: 44 },
    ]);
    assert.equal((await f.send(atomic)).status, 409);
    assert.equal(
      f.sqlite.prepare('SELECT count(*) count FROM native_source_article_identity WHERE portal_num=43').get()?.count,
      0,
    );
    assert.equal(
      f.sqlite.prepare('SELECT count(*) count FROM native_source_sync_v2_receipt WHERE dataset=?').get('articles')
        ?.count,
      1,
    );
    assert.equal((await f.send(delta('articles', 1, [{ ...article('Recovered'), portal_num: 43 }]))).status, 200);
  } finally {
    f.close();
  }
});

test('article portal hit-only, token position and attachment diffs leave untouched subtables with native hits', async () => {
  const f = fixture();
  try {
    f.sqlite.exec(`INSERT INTO boards(id,name) VALUES(1,'공지');
      INSERT INTO new_articles(id,board_id,title,hit) VALUES(9,1,'학교 공지',11);
      INSERT INTO new_koreatech_articles(article_id,author,portal_num,portal_hit,url) VALUES(9,'Source',42,7,'https://portal/new');
      INSERT INTO native_article_ngram(article_id,position,token) VALUES(9,0,'학교'),(9,1,'공지')`);
    const first = article('학교 공지', 19, [attachment('a', 'one'), attachment('b', 'two')]);
    assert.equal((await f.send(delta('articles', 0, [first]))).status, 200);
    const grams = f.changes('gram');
    const attachments = f.changes('attachment');
    const articles = f.changes('article');
    assert.equal((await f.send(delta('articles', 1, [{ ...first, portal_hit: 20 }]))).status, 200);
    assert.equal(f.changes('gram'), grams);
    assert.equal(f.changes('attachment'), attachments);
    assert.equal(f.changes('article'), articles);
    assert.ok(f.changes('portal') > 0);
    assert.equal(f.sqlite.prepare('SELECT hit FROM new_articles WHERE id=9').get()?.hit, 11);
    assert.equal((await f.send(delta('articles', 2, [{ ...first, portal_hit: 20, title: '학교 안내' }]))).status, 200);
    assert.equal(f.changes('gram'), grams + 1);
    assert.deepEqual(
      f.sqlite
        .prepare('SELECT position,token FROM native_article_ngram WHERE article_id=9 ORDER BY position')
        .all()
        .map((row) => ({ ...row })),
      [
        { position: 0, token: '학교' },
        { position: 1, token: '안내' },
      ],
    );
    const tokensAfter = f.changes('gram');
    assert.equal(
      (
        await f.send(
          delta('articles', 3, [
            {
              ...first,
              portal_hit: 20,
              title: '학교 안내',
              attachments: [attachment('a', 'renamed'), attachment('b', 'two')],
            },
          ]),
        )
      ).status,
      200,
    );
    assert.equal(f.changes('gram'), tokensAfter);
    const renamed = f.sqlite
      .prepare(`SELECT action,hash FROM sync_audit WHERE name='attachment'
      ORDER BY rowid LIMIT -1 OFFSET ?`)
      .all(attachments)
      .map((row) => ({ ...row }));
    assert.ok(renamed.length <= 2, 'one changed attachment must not amplify writes beyond its timestamp update');
    assert.deepEqual(new Set(renamed.map((row) => `${row.action}:${row.hash}`)), new Set([`UPDATE:${'a'.repeat(64)}`]));
    assert.deepEqual(
      f.sqlite
        .prepare('SELECT lower(hex(hash)) hash,name FROM article_attachments WHERE article_id=9 ORDER BY hash')
        .all()
        .map((row) => ({ ...row })),
      [
        { hash: 'a'.repeat(64), name: 'renamed' },
        { hash: 'b'.repeat(64), name: 'two' },
      ],
    );
    assert.deepEqual(
      { ...f.sqlite.prepare('SELECT id,title,hit FROM new_articles WHERE id=9').get() },
      { id: 9, title: '학교 안내', hit: 11 },
    );
    const total = f.sqlite.prepare('SELECT total_changes() count').get()?.count;
    const exact = delta('articles', 3, [
      {
        ...first,
        portal_hit: 20,
        title: '학교 안내',
        attachments: [attachment('a', 'renamed'), attachment('b', 'two')],
      },
    ]);
    assert.equal((await f.send(exact)).status, 200);
    assert.equal(f.sqlite.prepare('SELECT total_changes() count').get()?.count, total);
    const afterRename = f.changes('attachment');
    assert.equal(
      (
        await f.send(
          delta('articles', 4, [
            { ...first, portal_hit: 20, title: '학교 안내', attachments: [attachment('a', 'renamed')] },
          ]),
        )
      ).status,
      200,
    );
    const removed = f.sqlite
      .prepare(`SELECT action,hash FROM sync_audit WHERE name='attachment'
      ORDER BY rowid LIMIT -1 OFFSET ?`)
      .all(afterRename)
      .map((row) => ({ ...row }));
    assert.deepEqual(removed, [{ action: 'DELETE', hash: 'b'.repeat(64) }]);
    assert.equal(f.changes('gram'), tokensAfter);
    assert.equal(f.sqlite.prepare('SELECT count(*) count FROM article_attachments WHERE article_id=9').get()?.count, 1);
    assert.equal((await f.send(delta('articles', 5, [], [[1, 42]]))).status, 200);
    const disappeared = await f.send(baseline('articles', [[1, 42]]));
    assert.deepEqual(((await disappeared.json()) as { rows: unknown[] }).rows, []);
    assert.equal(f.sqlite.prepare('SELECT hit FROM new_articles WHERE id=9').get()?.hit, 11);
    assert.equal(
      (
        await f.send(
          delta('articles', 6, [
            { ...first, portal_hit: 20, title: '학교 안내', attachments: [attachment('a', 'renamed')] },
          ]),
        )
      ).status,
      200,
    );
    assert.equal(f.sqlite.prepare('SELECT count(*) count FROM new_articles WHERE board_id=1').get()?.count, 1);
    assert.equal(f.sqlite.prepare('SELECT is_deleted FROM new_articles WHERE id=9').get()?.is_deleted, 0);
  } finally {
    f.close();
  }
});

test('duplicate lecture group preserves timetable IDs and rejects ambiguous edits or linked removals', async () => {
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
    const unchanged = await f.send(baseline('lectures', [['2026-2', 'abc100', '01']]));
    assert.equal(((await unchanged.json()) as { rows: unknown[] }).rows.length, 2);
    assert.equal((await f.send(delta('lectures', 0, [row, row]))).status, 200);
    assert.equal((await f.send(delta('lectures', 1, [row, lecture('Changed 2')]))).status, 200);
    assert.equal(f.sqlite.prepare('SELECT name FROM lectures WHERE id=11').get()?.name, 'Changed 2');
    assert.equal((await f.send(delta('lectures', 2, [lecture('Changed 1'), lecture('Changed 3')]))).status, 409);
    assert.equal((await f.send(delta('lectures', 2, [], [['2026-2', 'ABC100', '01']]))).status, 409);
    assert.deepEqual(
      f.sqlite
        .prepare('SELECT id,name FROM lectures ORDER BY id')
        .all()
        .map((row) => ({ ...row })),
      [
        { id: 10, name: 'Original' },
        { id: 11, name: 'Changed 2' },
      ],
    );
    assert.equal(f.sqlite.prepare('SELECT lectures_id FROM timetable_lecture WHERE id=1').get()?.lectures_id, 11);
  } finally {
    f.close();
  }
});

test('shrinking an exact duplicate lecture group keeps the timetable-linked ID', async () => {
  const f = fixture();
  try {
    const row = lecture('Same');
    const insert = f.sqlite.prepare(
      'INSERT INTO lectures(id,semester_date,code,name,grades,class,regular_number,department,target,professor,is_english,design_score,is_elearning,class_time) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    for (const id of [10, 11]) insert.run(id, ...Object.values(row));
    f.sqlite.exec(`INSERT INTO users(id,password,user_type,anonymous_nickname) VALUES(1,'hash','STUDENT','a');
      INSERT INTO timetable_frame(id,user_id,semester_id,name) VALUES(1,1,1,'2026-2');
      INSERT INTO timetable_lecture(id,frame_id,lectures_id) VALUES(1,1,11)`);
    assert.equal((await f.send(delta('lectures', 0, [row]))).status, 200);
    assert.deepEqual(
      f.sqlite
        .prepare('SELECT id FROM lectures')
        .all()
        .map((entry) => entry.id),
      [11],
    );
    assert.equal(f.sqlite.prepare('SELECT lectures_id FROM timetable_lecture WHERE id=1').get()?.lectures_id, 11);
  } finally {
    f.close();
  }
});

test('concurrent timetable link before atomic page prevents lecture deletion and receipt ACK', async () => {
  let injected = false;
  const f = fixture('true', (sqlite, statements) => {
    if (injected || !statements.some((entry) => entry.query === 'DELETE FROM lectures WHERE id=?')) return;
    sqlite.exec('INSERT INTO timetable_lecture(id,frame_id,lectures_id) VALUES(1,1,10)');
    injected = true;
  });
  try {
    f.sqlite
      .prepare(
        'INSERT INTO lectures(id,semester_date,code,name,grades,class,regular_number,department,target,professor,is_english,design_score,is_elearning,class_time) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(10, ...Object.values(lecture('Original')));
    f.sqlite.exec(`INSERT INTO users(id,password,user_type,anonymous_nickname) VALUES(1,'hash','STUDENT','a');
      INSERT INTO timetable_frame(id,user_id,semester_id,name) VALUES(1,1,1,'2026-2')`);
    const removal = delta('lectures', 0, [], [['2026-2', 'ABC100', '01']]);
    assert.equal((await f.send(removal)).status, 409);
    assert.equal(injected, true);
    assert.equal(f.sqlite.prepare('SELECT count(*) count FROM lectures WHERE id=10').get()?.count, 1);
    assert.equal(f.sqlite.prepare('SELECT count(*) count FROM native_source_sync_v2_receipt').get()?.count, 0);
    assert.equal(f.sqlite.prepare('SELECT count(*) count FROM native_source_sync_v2_state').get()?.count, 0);
    f.sqlite.exec('DELETE FROM timetable_lecture WHERE id=1');
    assert.equal((await f.send(removal)).status, 200);
    assert.equal(f.sqlite.prepare('SELECT count(*) count FROM lectures WHERE id=10').get()?.count, 0);
  } finally {
    f.close();
  }
});

test('target lecture drift over 1000 rows per group or page refuses before any writes', async () => {
  const f = fixture();
  try {
    const insert = f.sqlite.prepare(
      'INSERT INTO lectures(id,semester_date,code,name,grades,class,regular_number,department,target,professor,is_english,design_score,is_elearning,class_time) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    );
    for (let id = 1; id <= 1001; id++) insert.run(id, ...Object.values(lecture('Original')));
    const before = f.sqlite.prepare('SELECT total_changes() count').get()?.count;
    assert.equal((await f.send(delta('lectures', 0, [lecture('Original')]))).status, 409);
    assert.equal(f.sqlite.prepare('SELECT total_changes() count').get()?.count, before);
    f.sqlite.exec("UPDATE lectures SET class='02' WHERE id>501");
    const splitBefore = f.sqlite.prepare('SELECT total_changes() count').get()?.count;
    assert.equal((await f.send(delta('lectures', 0, [lecture('Original'), lecture('Original', '02')]))).status, 409);
    assert.equal(
      (
        await f.send(
          delta(
            'lectures',
            0,
            [],
            [
              ['2026-2', 'ABC100', '01'],
              ['2026-2', 'ABC100', '02'],
            ],
          ),
        )
      ).status,
      409,
    );
    assert.equal(f.sqlite.prepare('SELECT total_changes() count').get()?.count, splitBefore);
    assert.equal(f.sqlite.prepare('SELECT count(*) count FROM native_source_sync_v2_receipt').get()?.count, 0);
  } finally {
    f.close();
  }
});

test('target article attachment drift over 1000 refuses upsert and removal without metadata writes', async () => {
  const f = fixture();
  try {
    f.sqlite.exec(`INSERT INTO boards(id,name) VALUES(1,'공지');
      INSERT INTO new_articles(id,board_id,title) VALUES(9,1,'공지');
      INSERT INTO new_koreatech_articles(article_id,author,portal_num,url) VALUES(9,'Source',42,'https://portal/new')`);
    const insert = f.sqlite.prepare('INSERT INTO article_attachments(article_id,hash,url,name) VALUES(9,unhex(?),?,?)');
    for (let id = 1; id <= 1001; id++)
      insert.run(id.toString(16).padStart(64, '0'), 'https://object/attach', `file-${id}`);
    const before = f.sqlite.prepare('SELECT total_changes() count').get()?.count;
    assert.equal((await f.send(delta('articles', 0, [article()]))).status, 409);
    assert.equal((await f.send(delta('articles', 0, [], [[1, 42]]))).status, 409);
    assert.equal(f.sqlite.prepare('SELECT total_changes() count').get()?.count, before);
    assert.equal(
      f.sqlite.prepare('SELECT count(*) count FROM article_attachments WHERE article_id=9').get()?.count,
      1001,
    );
    assert.equal(f.sqlite.prepare('SELECT count(*) count FROM native_source_sync_v2_receipt').get()?.count, 0);
  } finally {
    f.close();
  }
});

test('complete timetable version group changes only its rows, and other entity tombstones are keyed', async () => {
  const f = fixture();
  try {
    f.sqlite
      .exec(`INSERT INTO versions(id,version,type,title) VALUES(1,'1.0','app','Native'),(2,'2026-1','timetable','Old');
      INSERT INTO citybus_timetables(id,bus_info,bus_timetables,updated_at) VALUES('retain','{}','[]','2026-10-01 00:00:00')`);
    const version = { version: '2026-1', type: 'timetable', title: 'New', is_previous: 0, content: null };
    assert.equal((await f.send(delta('versions', 0, [version]))).status, 200);
    assert.equal(f.sqlite.prepare('SELECT title FROM versions WHERE id=1').get()?.title, 'Native');
    assert.equal(f.sqlite.prepare('SELECT title FROM versions WHERE id=2').get()?.title, 'New');
    assert.equal(
      (
        await f.send(
          delta('citybus', 0, [
            { id: 'route', bus_info: { route: '1' }, bus_timetables: [], updated_at: '2026-10-29 12:00:00' },
          ]),
        )
      ).status,
      200,
    );
    assert.equal(f.sqlite.prepare('SELECT count(*) count FROM citybus_timetables').get()?.count, 2);
    assert.equal((await f.send(delta('citybus', 1, [], [['route']]))).status, 200);
    assert.equal(f.sqlite.prepare('SELECT id FROM citybus_timetables WHERE id=?').get('retain')?.id, 'retain');
    assert.equal((await f.send(delta('versions', 1, [], [['timetable']]))).status, 200);
    assert.equal(f.sqlite.prepare('SELECT count(*) count FROM versions').get()?.count, 1);
  } finally {
    f.close();
  }
});

test('weather updates only changed forecast or expiry and does not overwrite a newer native refresh', async () => {
  const f = fixture();
  try {
    const forecast = {
      '202610292000': {
        temperature: 13,
        weather: '맑음',
        weather_id: 1,
        weather_icon_url: 'https://static.koreatech.in/upload/WEATHER/sun-03.webp',
      },
    };
    const row = {
      id: 'Weather:byeongcheon',
      payload: forecast,
      expires_at: 1_770_086_400_000,
      updated_at: 1_770_000_000_000,
    };
    assert.equal((await f.send(delta('weather', 0, [row]))).status, 200);
    const before = f.sqlite.prepare('SELECT total_changes() count').get()?.count;
    const read = await f.send(baseline('weather', [['Weather:byeongcheon']]));
    assert.deepEqual(((await read.json()) as { rows: unknown[] }).rows, [row]);
    assert.equal(f.sqlite.prepare('SELECT total_changes() count').get()?.count, before);
    assert.equal((await f.send(delta('weather', 1, [{ ...row, updated_at: row.updated_at + 100 }]))).status, 200);
    assert.equal(
      f.sqlite.prepare('SELECT updated_at FROM native_transport_cache WHERE id=?').get(row.id)?.updated_at,
      row.updated_at,
    );
    f.sqlite.prepare('UPDATE native_transport_cache SET updated_at=? WHERE id=?').run(row.updated_at + 300, row.id);
    assert.equal(
      (
        await f.send(
          delta('weather', 2, [{ ...row, expires_at: row.expires_at + 100, updated_at: row.updated_at + 200 }]),
        )
      ).status,
      200,
    );
    assert.equal(
      f.sqlite.prepare('SELECT expires_at FROM native_transport_cache WHERE id=?').get(row.id)?.expires_at,
      row.expires_at,
    );
    assert.equal(
      (
        await f.send(
          delta('weather', 3, [{ ...row, expires_at: row.expires_at + 100, updated_at: row.updated_at + 400 }]),
        )
      ).status,
      200,
    );
    assert.equal(
      f.sqlite.prepare('SELECT expires_at FROM native_transport_cache WHERE id=?').get(row.id)?.expires_at,
      row.expires_at + 100,
    );
  } finally {
    f.close();
  }
});
