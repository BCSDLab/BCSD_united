import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import test from 'node:test';
import { URL } from 'node:url';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { createDatabase, executeAtomic } from '@api/db/client';
import { schema } from '@api/db/schema';
import { ApiError, errorResponse } from '@api/errors';
import type { Job } from '@api/jobs';
import type { ApiEnv, Bindings } from '@api/runtime';
import { registerCallvan } from '@api/domains/callvan';
import {
  assertJoinable,
  assertReopenable,
  createInput,
  endGuard,
  pagination,
  queueDelaySeconds,
  reminderTime,
  restrictionCondition,
  utcText,
} from '@api/domains/callvan/core';
import {
  claimDeliveryStatement,
  handleCallvanJob,
  materializationStatements,
  messagePreview,
  pushMessage,
  runCallvanCron,
} from '@api/domains/callvan/jobs';
import { chatDateTime } from '@api/domains/callvan/messages';
import { reportInput } from '@api/domains/callvan/reports';
import { joinStatements, leaveStatements, processStatements } from '@api/domains/callvan/state';

function fixture() {
  const sqlite = new DatabaseSync(':memory:');
  for (const name of ['0000_source_and_native.sql', '0001_native_invariants.sql'])
    sqlite.exec(readFileSync(new URL(`../../../drizzle/${name}`, import.meta.url), 'utf8'));
  class Statement {
    constructor(
      readonly query: string,
      readonly parameters: SQLInputValue[] = [],
    ) {}
    bind(...parameters: SQLInputValue[]) {
      return new Statement(this.query, parameters);
    }
    async all() {
      const results = sqlite.prepare(this.query).all(...this.parameters);
      const changes = Number(sqlite.prepare('SELECT changes() AS count').get()!.count);
      return { success: true, results, meta: { changes } };
    }
    async raw() {
      return sqlite
        .prepare(this.query)
        .all(...this.parameters)
        .map((row) => Object.values(row));
    }
    async first(column?: string) {
      const row = sqlite.prepare(this.query).get(...this.parameters);
      return column ? (row?.[column] ?? null) : (row ?? null);
    }
    async run() {
      return this.all();
    }
  }
  const binding = {
    prepare(query: string) {
      return new Statement(query);
    },
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.all());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
  for (const id of [1, 2, 3, 4])
    sqlite
      .prepare("INSERT INTO users(id,password,user_type,nickname,anonymous_nickname) VALUES (?,'hash',?,?,?)")
      .run(id, id === 4 ? 'ADMIN' : 'STUDENT', `닉네임${id}`, `anonymous${id}`);
  sqlite.exec(
    "INSERT INTO callvan_post(id,author_id,title,departure_type,departure_custom_name,arrival_type,arrival_custom_name,departure_date,departure_time,max_participants,current_participants,status) VALUES (1,1,'정문 -> 천안역','FRONT_GATE','정문','STATION','천안역','2099-01-01','12:00:00',2,1,'RECRUITING')",
  );
  sqlite.exec("INSERT INTO callvan_chat_room(id,callvan_post_id,room_name) VALUES (1,1,'정문 -> 천안역 12:00')");
  sqlite.exec('UPDATE callvan_post SET chat_room_id=1 WHERE id=1');
  sqlite.exec("INSERT INTO callvan_participant(post_id,member_id,role) VALUES (1,1,'AUTHOR')");
  const db = createDatabase(binding);
  const queued: Job[] = [];
  const env = {
    DB: binding,
    JOBS: {
      async send(job: Job) {
        queued.push(job);
      },
    },
    ENVIRONMENT: 'development',
    SERIALIZED: true,
  } as unknown as Bindings;
  const app = new Hono<ApiEnv>();
  app.use('*', async (c, next) => {
    c.set('db', db);
    const user = Number(c.req.header('x-test-user') ?? 0);
    c.set('principal', user ? { id: user, userType: user === 4 ? 'ADMIN' : 'STUDENT' } : null);
    await next();
  });
  app.onError((error) =>
    error instanceof ApiError ? errorResponse(error) : Response.json({ error: error.message }, { status: 500 }),
  );
  registerCallvan(app);
  const request = (path: string, method = 'GET', user = 1, body?: unknown) =>
    app.request(
      path,
      {
        method,
        headers: { 'x-test-user': String(user), 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      env,
    );
  return { sqlite, db, queued, env, app, request };
}

const now = '2098-12-31 00:00:00.000';
function join(userId: number, key = `join-${userId}`) {
  return joinStatements({
    key,
    postId: 1,
    userId,
    nickname: `닉네임${userId}`,
    now,
    joinedEventId: `${key}-joined`,
    completeEventId: `${key}-complete`,
  });
}

const departure = {
  status: 'RECRUITING',
  departure_date: '2026-10-28',
  departure_time: '09:00:00',
  current_participants: 1,
  max_participants: 2,
};

test('join and reopen honor exact KST departure, status precedence, and full capacity', () => {
  const exact = Date.parse('2026-10-28T00:00:00.000Z');
  assert.doesNotThrow(() => assertJoinable(departure, exact - 1));
  assert.throws(() => assertJoinable(departure, exact), { code: 'CALLVAN_POST_JOIN_FAILED_TIME' });
  assert.throws(() => assertJoinable({ ...departure, status: 'CLOSED' }, exact), {
    code: 'CALLVAN_POST_NOT_RECRUITING',
  });
  assert.throws(() => assertJoinable({ ...departure, current_participants: 2 }, exact - 1), {
    code: 'CALLVAN_POST_FULL',
  });
  assert.throws(() => assertReopenable({ ...departure, current_participants: 2 }, exact), {
    code: 'CALLVAN_POST_REOPEN_FAILED_FULL',
  });
  assert.throws(() => assertReopenable(departure, exact), { code: 'CALLVAN_POST_REOPEN_FAILED_TIME' });
});

test('reminders are scheduled only strictly before the thirty-minute boundary', () => {
  const boundary = Date.parse('2026-10-27T23:30:00.000Z');
  assert.equal(reminderTime(departure, boundary), null);
  assert.equal(reminderTime(departure, boundary + 1), null);
  assert.equal(reminderTime(departure, boundary - 1), '2026-10-27 23:30:00.000');
  assert.deepEqual(chatDateTime('2026-10-27 15:00:00'), { date: '2026. 10. 28', time: '오전 12:00' });
  assert.deepEqual(chatDateTime('2026-10-28 03:05:00'), { date: '2026. 10. 28', time: '오후 12:05' });
});

test('delayed reminders cap relays at twelve hours and round up rather than firing early', () => {
  const start = Date.parse('2026-10-28T00:00:00.000Z');
  assert.equal(queueDelaySeconds('2026-10-28 00:00:00.001', start), 1);
  assert.equal(queueDelaySeconds('2026-10-29 00:00:00.000', start), 43_200);
  assert.equal(queueDelaySeconds('2026-10-27 23:59:59.999', start), 0);
});

test('recovery cron performs no database work outside five-minute ticks', async () => {
  await runCallvanCron({} as Bindings, Date.parse('2026-10-28T00:01:00.000Z'));
});

test('creation validates calendar dates, capacities and custom-only names', () => {
  const input = {
    departure_type: 'FRONT_GATE',
    departure_custom_name: ' ',
    arrival_type: 'CUSTOM',
    arrival_custom_name: '우리 집',
    departure_date: '2028-02-29',
    departure_time: '23:59',
    max_participants: 11,
  };
  assert.equal(createInput(input).departure_custom_name, '정문');
  assert.throws(() => createInput({ ...input, departure_date: '2026-02-29' }), { code: 'INVALID_REQUEST_BODY' });
  assert.throws(() => createInput({ ...input, max_participants: 12 }), { code: 'INVALID_REQUEST_BODY' });
  assert.throws(() => createInput({ ...input, arrival_custom_name: '' }), { code: 'INVALID_CUSTOM_LOCATION_NAME' });
  assert.throws(() => createInput({ ...input, departure_custom_name: '기숙사' }), {
    code: 'INVALID_CUSTOM_LOCATION_NAME',
  });
  assert.deepEqual(pagination(100, 100, 51), { page: 2, limit: 50, pages: 2, offset: 50 });
  assert.deepEqual(pagination(-1, -1, 0), { page: 1, limit: 1, pages: 0, offset: 0 });
});

test('two prevalidated final-seat contenders cannot exceed capacity or emit phantom events', async () => {
  const { sqlite, db } = fixture();
  try {
    const first = join(2);
    const second = join(3);
    assert.equal((await executeAtomic(db, first))[0]!.meta.changes, 1);
    assert.equal((await executeAtomic(db, second))[0]!.meta.changes, 0);
    assert.deepEqual(
      { ...sqlite.prepare('SELECT current_participants,status FROM callvan_post WHERE id=1').get() },
      { current_participants: 2, status: 'CLOSED' },
    );
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM callvan_participant WHERE member_id=3').get()!.n, 0);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM native_callvan_event').get()!.n, 2);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM native_callvan_guard').get()!.n, 0);
    assert.equal((await executeAtomic(db, join(2, 'duplicate')))[0]!.meta.changes, 0);
  } finally {
    sqlite.close();
  }
});

test('outbox failure rolls back membership, capacity, chat flags and event insertion', async () => {
  const { sqlite, db } = fixture();
  try {
    sqlite.exec(
      "CREATE TRIGGER fail_event BEFORE INSERT ON native_callvan_event BEGIN SELECT RAISE(ABORT,'outbox unavailable'); END",
    );
    await assert.rejects(executeAtomic(db, join(2)));
    assert.equal(
      sqlite.prepare('SELECT current_participants FROM callvan_post WHERE id=1').get()!.current_participants,
      1,
    );
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM callvan_participant').get()!.n, 1);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM native_callvan_guard').get()!.n, 0);
  } finally {
    sqlite.close();
  }
});

test('leave is guarded and rejoin preserves original joined_at while restoring message sender flags', async () => {
  const { sqlite, db } = fixture();
  try {
    await executeAtomic(db, join(2));
    sqlite.exec(
      "INSERT INTO callvan_chat_message(callvan_chat_room_id,sender_id,sender_nickname,content) VALUES (1,2,'닉네임2','안녕하세요')",
    );
    const initial = sqlite.prepare('SELECT joined_at FROM callvan_participant WHERE member_id=2').get()!.joined_at;
    assert.equal((await executeAtomic(db, leaveStatements('leave', 1, 2, now)))[0]!.meta.changes, 1);
    assert.equal((await executeAtomic(db, leaveStatements('leave-again', 1, 2, now)))[0]!.meta.changes, 0);
    assert.deepEqual(
      { ...sqlite.prepare('SELECT current_participants,status FROM callvan_post').get() },
      { current_participants: 1, status: 'CLOSED' },
    );
    assert.equal(sqlite.prepare('SELECT is_left_user FROM callvan_chat_message').get()!.is_left_user, 1);
    sqlite.exec("UPDATE callvan_post SET status='RECRUITING'");
    await executeAtomic(db, join(2, 'rejoin'));
    assert.equal(
      sqlite.prepare('SELECT joined_at FROM callvan_participant WHERE member_id=2').get()!.joined_at,
      initial,
    );
    assert.equal(sqlite.prepare('SELECT is_left_user FROM callvan_chat_message').get()!.is_left_user, 0);
    assert.equal((await executeAtomic(db, leaveStatements('author-leave', 1, 1, now)))[0]!.meta.changes, 0);
  } finally {
    sqlite.close();
  }
});

test('report validation preserves distinct reasons, OTHER limits, and attachment normalization', () => {
  const input = {
    reported_user_id: 2,
    reasons: [{ reason_code: 'OTHER', custom_text: '  욕설  ' }],
    description: '  상황  ',
    attachments: [{ attachment_type: 'IMAGE', url: ' https://static.example/image.png ' }],
  };
  const parsed = reportInput(input);
  assert.equal(parsed.reasons[0]!.custom_text, '욕설');
  assert.equal(parsed.attachments[0]!.url, 'https://static.example/image.png');
  assert.equal(parsed.description, '상황');
  assert.throws(() => reportInput({ ...input, reasons: [{ reason_code: 'NO_SHOW' }, { reason_code: 'NO_SHOW' }] }), {
    code: 'INVALID_REQUEST_BODY',
  });
  assert.throws(() => reportInput({ ...input, reasons: [{ reason_code: 'OTHER', custom_text: '가'.repeat(151) }] }), {
    code: 'INVALID_REQUEST_BODY',
  });
  assert.throws(() => reportInput({ ...input, attachments: Array.from({ length: 11 }, () => input.attachments[0]) }), {
    code: 'INVALID_REQUEST_BODY',
  });
});

test('moderation is single-shot and temporary restriction remains active at the exact expiry', async () => {
  const { sqlite, db } = fixture();
  try {
    sqlite.exec('INSERT INTO callvan_report(id,callvan_post_id,reporter_id,reported_id) VALUES (1,1,1,2)');
    const first = [
      ...processStatements('review1', 1, 4, 'TEMPORARY_RESTRICTION_14_DAYS', now, '2099-01-14 00:00:00'),
      endGuard('review1'),
    ];
    const second = [...processStatements('review2', 1, 4, 'PERMANENT_RESTRICTION', now, null), endGuard('review2')];
    assert.equal((await executeAtomic(db, first))[0]!.meta.changes, 1);
    assert.equal((await executeAtomic(db, second))[0]!.meta.changes, 0);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM callvan_report_process').get()!.n, 1);
    assert.equal(
      (await db.get<{ active: number }>(sql`SELECT ${restrictionCondition(2, '2099-01-14 00:00:00.000')} AS active`))!
        .active,
      1,
    );
    assert.equal(
      (await db.get<{ active: number }>(sql`SELECT ${restrictionCondition(2, '2099-01-14 00:00:00.001')} AS active`))!
        .active,
      0,
    );
  } finally {
    sqlite.close();
  }
});

test('replayed scheduled event creates each notification and push delivery exactly once', async () => {
  const { sqlite, db } = fixture();
  try {
    await executeAtomic(db, join(2));
    const event = {
      id: 'reminder',
      post_id: 1,
      type: 'DEPARTURE_UPCOMING',
      payload: '{}',
      available_at: now,
      completed_at: null,
      created_at: now,
    };
    sqlite
      .prepare('INSERT INTO native_callvan_event(id,post_id,type,payload,available_at,created_at) VALUES (?,?,?,?,?,?)')
      .run(event.id, event.post_id, event.type, event.payload, now, now);
    assert.equal(
      (await executeAtomic(db, materializationStatements(event, [1, 2], 'materialize1', now)))[0]!.meta.changes,
      1,
    );
    assert.equal(
      (await executeAtomic(db, materializationStatements(event, [1, 2], 'materialize2', now)))[0]!.meta.changes,
      0,
    );
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM callvan_notification').get()!.n, 2);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM native_callvan_delivery').get()!.n, 2);
    const notification = await db.get<typeof schema.callvan_notification.$inferSelect>(
      sql`SELECT * FROM ${schema.callvan_notification} WHERE recipient_id = 1`,
    );
    assert.equal(pushMessage(notification!).data.notification_id, String(notification!.id));
    assert.equal(pushMessage(notification!).body, '정문 -> 천안역 콜벤팟이 30분 뒤 출발해요');
  } finally {
    sqlite.close();
  }
});

test('push claims exclude concurrent workers, expire deterministically, and never reclaim acknowledged delivery', async () => {
  const { sqlite, db } = fixture();
  try {
    sqlite
      .prepare('INSERT INTO native_callvan_delivery(id,notification_id,created_at) VALUES (?,?,?)')
      .run('push', 1, now);
    assert.equal(
      (await executeAtomic(db, [claimDeliveryStatement('push', 'first', now, '2098-12-31 00:05:00.000')]))[0]!.meta
        .changes,
      1,
    );
    assert.equal(
      (
        await executeAtomic(db, [
          claimDeliveryStatement('push', 'second', '2098-12-31 00:04:59.999', '2098-12-31 00:10:00.000'),
        ])
      )[0]!.meta.changes,
      0,
    );
    assert.equal(
      (
        await executeAtomic(db, [
          claimDeliveryStatement('push', 'second', '2098-12-31 00:05:00.000', '2098-12-31 00:10:00.000'),
        ])
      )[0]!.meta.changes,
      1,
    );
    sqlite.prepare('UPDATE native_callvan_delivery SET delivered_at=? WHERE id=?').run(now, 'push');
    assert.equal(
      (
        await executeAtomic(db, [
          claimDeliveryStatement('push', 'third', '2098-12-31 00:20:00.000', '2098-12-31 00:25:00.000'),
        ])
      )[0]!.meta.changes,
      0,
    );
  } finally {
    sqlite.close();
  }
});

test('message preview uses Java UTF-16 truncation and image-specific text', () => {
  assert.equal(messagePreview('NEW_MESSAGE', { content: '가'.repeat(95) }), '가'.repeat(95));
  assert.equal(messagePreview('NEW_MESSAGE', { content: '가'.repeat(96) }), `${'가'.repeat(95)}...`);
  assert.equal(
    messagePreview('NEW_MESSAGE', { is_image: true, sender_nickname: '코룡이', content: 'https://image' }),
    '코룡이님이 사진을 보냈습니다.',
  );
});

test('concrete endpoints enforce roles and membership, persist chat, report and moderation contracts', async () => {
  const { sqlite, db, request, app, queued } = fixture();
  try {
    assert.equal(app.routes.filter((route) => route.method !== 'ALL').length, 20);
    assert.equal((await request('/callvan/posts/1', 'GET', 2)).status, 403);
    assert.equal((await request('/admin/callvan/reports', 'GET', 1)).status, 403);
    assert.equal((await request('/callvan/posts/1/participants', 'POST', 2)).status, 201);
    assert.equal(
      (await request('/callvan/posts/1/chat', 'POST', 2, { content: 'hello', is_image: false })).status,
      201,
    );
    const chat = (await (await request('/callvan/posts/1/chat', 'GET', 1)).json()) as {
      room_name: string;
      messages: { content: string; is_mine: boolean }[];
    };
    assert.equal(chat.room_name, '정문 -> 천안역 (12:00) (2명)');
    assert.equal(chat.messages[0]!.content, 'hello');
    assert.equal(chat.messages[0]!.is_mine, false);
    const report = { reported_user_id: 2, reasons: [{ reason_code: 'NO_SHOW' }] };
    assert.equal((await request('/callvan/posts/1/reports', 'POST', 1, report)).status, 201);
    assert.equal((await request('/callvan/posts/1/reports', 'POST', 1, report)).status, 409);
    assert.equal(
      (await request('/admin/callvan/reports/1/process', 'POST', 4, { process_type: 'WARNING' })).status,
      200,
    );
    assert.equal(
      (await request('/admin/callvan/reports/1/process', 'POST', 4, { process_type: 'REJECT' })).status,
      400,
    );
    const restrictions = await (await request('/callvan/restriction', 'GET', 2)).json();
    assert.deepEqual(restrictions, { is_restricted: false, restriction_type: null, restricted_until: null });
    const notificationsBefore = (await db.all(sql`SELECT * FROM ${schema.native_callvan_event}`)).length;
    assert.equal(notificationsBefore, 4);
    assert.equal(queued.length, 4);
  } finally {
    sqlite.close();
  }
});

test('created posts atomically link room and author and persist only future reminder tasks', async () => {
  const { sqlite, request } = fixture();
  try {
    const response = await request('/callvan', 'POST', 1, {
      departure_type: 'FRONT_GATE',
      arrival_type: 'STATION',
      departure_date: '2099-01-01',
      departure_time: '12:00',
      max_participants: 4,
    });
    assert.equal(response.status, 201);
    const post = (await response.json()) as { id: number; author: string; current_participants: number };
    assert.equal(post.author, '닉네임1');
    assert.equal(post.current_participants, 1);
    assert.equal(sqlite.prepare('SELECT role FROM callvan_participant WHERE post_id=?').get(post.id)!.role, 'AUTHOR');
    assert.equal(
      sqlite
        .prepare(
          'SELECT callvan_post_id FROM callvan_chat_room WHERE id=(SELECT chat_room_id FROM callvan_post WHERE id=?)',
        )
        .get(post.id)!.callvan_post_id,
      post.id,
    );
    assert.equal(
      sqlite.prepare('SELECT available_at FROM native_callvan_event WHERE post_id=?').get(post.id)!.available_at,
      '2099-01-01 02:30:00.000',
    );
  } finally {
    sqlite.close();
  }
});

test('unsubscribed push is durably acknowledged and a repeated queue job does not resend', async () => {
  const { sqlite, db, env } = fixture();
  try {
    const stamp = utcText();
    const event = {
      id: 'now-reminder',
      post_id: 1,
      type: 'DEPARTURE_UPCOMING',
      payload: '{}',
      available_at: stamp,
      completed_at: null,
      created_at: stamp,
    };
    sqlite
      .prepare('INSERT INTO native_callvan_event(id,post_id,type,payload,available_at,created_at) VALUES (?,?,?,?,?,?)')
      .run(event.id, 1, event.type, '{}', stamp, stamp);
    await executeAtomic(db, materializationStatements(event, [1], 'materialize', stamp));
    const job = { kind: 'callvan.push', key: 'now-reminder:1', payload: {} };
    assert.equal(await handleCallvanJob(env, job), true);
    assert.equal(await handleCallvanJob(env, job), true);
    assert.notEqual(sqlite.prepare('SELECT delivered_at FROM native_callvan_delivery').get()!.delivered_at, null);
    assert.equal(await handleCallvanJob(env, { kind: 'other', key: '', payload: {} }), false);
  } finally {
    sqlite.close();
  }
});

test('future queue wake relays its durable due time without creating notifications early', async () => {
  const { sqlite, env, queued } = fixture();
  try {
    const due = '2099-01-01 02:30:00.000';
    sqlite
      .prepare('INSERT INTO native_callvan_event(id,post_id,type,payload,available_at,created_at) VALUES (?,?,?,?,?,?)')
      .run('future', 1, 'DEPARTURE_UPCOMING', '{}', due, utcText());
    assert.equal(await handleCallvanJob(env, { kind: 'callvan.event', key: 'future', payload: {} }), true);
    assert.deepEqual(queued, [{ kind: 'callvan.event', key: 'future', payload: {} }]);
    assert.equal(
      sqlite.prepare('SELECT completed_at FROM native_callvan_event WHERE id=?').get('future')!.completed_at,
      null,
    );
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM callvan_notification').get()!.n, 0);
  } finally {
    sqlite.close();
  }
});

test('persisted provider retry time prevents early duplicate sends and permits the exact due boundary', async () => {
  const { sqlite, db } = fixture();
  try {
    sqlite
      .prepare('INSERT INTO native_callvan_delivery(id,notification_id,created_at,next_attempt_at) VALUES (?,?,?,?)')
      .run('retry', 1, now, '2098-12-31 00:00:30.000');
    assert.equal(
      (
        await executeAtomic(db, [
          claimDeliveryStatement('retry', 'early', '2098-12-31 00:00:29.999', '2098-12-31 00:05:30.000'),
        ])
      )[0]!.meta.changes,
      0,
    );
    assert.equal(
      (
        await executeAtomic(db, [
          claimDeliveryStatement('retry', 'due', '2098-12-31 00:00:30.000', '2098-12-31 00:05:30.000'),
        ])
      )[0]!.meta.changes,
      1,
    );
    assert.equal(sqlite.prepare('SELECT attempts FROM native_callvan_delivery WHERE id=?').get('retry')!.attempts, 1);
  } finally {
    sqlite.close();
  }
});
