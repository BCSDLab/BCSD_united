import { sql, type SQL } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { requirePrincipal } from '@api/auth';
import { coordinateRequest } from '@api/coordination';
import { executeAtomic, type Database } from '@api/db/client';
import { schema } from '@api/db/schema';
import { ApiError } from '@api/errors';
import type { ApiEnv } from '@api/runtime';
import {
  activeParticipant,
  assertJoinable,
  assertNotRestricted,
  assertReopenable,
  beginGuard,
  body,
  createInput,
  departureMillis,
  displayNickname,
  endGuard,
  enumeration,
  eventStatement,
  fail,
  gate,
  getPost,
  getUser,
  guardedId,
  integer,
  localDateTime,
  locations,
  pagination,
  queryInteger,
  reminderTime,
  requireParticipant,
  restrictionCondition,
  signalEvents,
  summary,
  utcText,
  type Post,
  type User,
} from '@api/domains/callvan/core';
import { joinStatements, leaveStatements } from '@api/domains/callvan/state';

function conflict(): never {
  throw new ApiError(409, 'CALLVAN_STATE_CONFLICT', '콜벤 상태가 변경되었습니다. 다시 요청해 주세요.');
}

function listValues(c: Context<ApiEnv>, name: string, values: readonly string[]): string[] {
  return (c.req.queries(name) ?? []).flatMap((item) => item.split(',')).map((value) => enumeration(value, values));
}

function locationFilter(types: string[], keyword: string | undefined, typeColumn: SQL, nameColumn: SQL): SQL {
  const normal = types.filter((type) => type !== 'CUSTOM');
  const terms: SQL[] = [];
  if (normal.length)
    terms.push(
      sql`${typeColumn} IN (${sql.join(
        normal.map((value) => sql`${value}`),
        sql`, `,
      )})`,
    );
  if (types.includes('CUSTOM') && keyword !== undefined)
    terms.push(sql`(${typeColumn} = 'CUSTOM' AND instr(lower(${nameColumn}), lower(${keyword})) > 0)`);
  return terms.length ? sql`(${sql.join(terms, sql` OR `)})` : sql`1`;
}

async function joined(db: Database, postId: number, userId: number | null): Promise<boolean> {
  if (userId === null) return false;
  return Boolean(
    (await db.get<{ joined: number }>(sql`SELECT ${activeParticipant(postId, userId)} AS joined`))?.joined,
  );
}

async function diagnoseJoin(db: Database, postId: number, userId: number): Promise<void> {
  await assertNotRestricted(db, userId);
  const post = await getPost(db, postId);
  await getUser(db, userId);
  if (await joined(db, postId, userId)) fail('CALLVAN_ALREADY_JOINED');
  assertJoinable(post, Date.now());
}

export function registerPosts(app: Hono<ApiEnv>): void {
  app.post('/callvan', async (c) => {
    const userId = requirePrincipal(c, ['STUDENT']).id;
    const coordinated = await coordinateRequest(c, `callvan:user:${userId}`);
    if (coordinated) return coordinated;
    const db = c.get('db');
    await assertNotRestricted(db, userId);
    const user = await getUser(db, userId);
    const input = createInput(await body(c));
    const key = crypto.randomUUID();
    const nowMs = Date.now();
    const now = utcText(nowMs);
    const due = reminderTime(input, nowMs);
    const eventId = crypto.randomUUID();
    const title = `${input.departure_custom_name} -> ${input.arrival_custom_name}`;
    const statements: SQL[] = [
      beginGuard(
        key,
        sql`NOT ${restrictionCondition(userId, now)} AND EXISTS (SELECT 1 FROM ${schema.users} WHERE id = ${userId} AND is_deleted = 0)`,
      ),
      sql`INSERT INTO ${schema.callvan_post} (author_id, title, departure_type, departure_custom_name, arrival_type, arrival_custom_name, departure_date, departure_time, max_participants, current_participants, status, is_deleted, created_at, updated_at) SELECT ${userId}, ${title}, ${input.departure_type}, ${input.departure_custom_name}, ${input.arrival_type}, ${input.arrival_custom_name}, ${input.departure_date}, ${input.departure_time}, ${input.max_participants}, 1, 'RECRUITING', 0, ${now}, ${now} WHERE ${gate(key)}`,
      sql`UPDATE ${schema.native_callvan_guard} SET entity_id = last_insert_rowid() WHERE id = ${key}`,
      sql`INSERT INTO ${schema.callvan_chat_room} (callvan_post_id, room_name, is_deleted, created_at, updated_at) SELECT ${guardedId(key)}, ${`${title} ${input.departure_time.slice(0, 5)}`}, 0, ${now}, ${now} WHERE ${gate(key)}`,
      sql`UPDATE ${schema.callvan_post} SET chat_room_id = (SELECT id FROM ${schema.callvan_chat_room} WHERE callvan_post_id = ${guardedId(key)}) WHERE id = ${guardedId(key)} AND ${gate(key)}`,
      sql`INSERT INTO ${schema.callvan_participant} (post_id, member_id, role, joined_at, is_deleted, created_at, updated_at) SELECT ${guardedId(key)}, ${userId}, 'AUTHOR', ${now}, 0, ${now}, ${now} WHERE ${gate(key)}`,
    ];
    if (due) statements.push(eventStatement(key, eventId, guardedId(key), 'DEPARTURE_UPCOMING', {}, now, due));
    statements.push(sql`SELECT * FROM ${schema.callvan_post} WHERE id = ${guardedId(key)}`, endGuard(key));
    const result = await executeAtomic(db, statements);
    if (!result[0]?.meta.changes) {
      await assertNotRestricted(db, userId);
      await getUser(db, userId);
      return conflict();
    }
    const post = result[result.length - 2]!.results[0] as unknown as Post;
    if (due) await signalEvents(c.env, [eventId], due);
    return c.json(
      {
        id: post.id,
        author: user.nickname,
        departure_type: post.departure_type,
        departure_custom_name: post.departure_custom_name,
        arrival_type: post.arrival_type,
        arrival_custom_name: post.arrival_custom_name,
        departure_date: post.departure_date,
        departure_time: post.departure_time.slice(0, 5),
        max_participants: post.max_participants,
        current_participants: post.current_participants,
        status: post.status,
        created_at: localDateTime(post.created_at)!.replace('T', ' ').slice(0, 19),
        updated_at: localDateTime(post.updated_at)!.replace('T', ' ').slice(0, 19),
      },
      201,
    );
  });

  app.get('/callvan', async (c) => {
    const db = c.get('db');
    const userId = c.get('principal')?.id ?? null;
    const author = enumeration(c.req.query('author') ?? 'ALL', ['ALL', 'MY']);
    if (author === 'MY' && userId === null) fail('UNAUTHORIZED_USER');
    const isJoined = enumeration(c.req.query('joined') ?? 'false', ['true', 'false']) === 'true' && userId !== null;
    const sort = enumeration(c.req.query('sort') ?? 'LATEST_DESC', [
      'LATEST_DESC',
      'LATEST_ASC',
      'DEPARTURE_ASC',
      'DEPARTURE_DESC',
    ]);
    const statuses = listValues(c, 'statuses', ['RECRUITING', 'CLOSED', 'COMPLETED']);
    const departures = listValues(c, 'departures', Object.keys(locations));
    const arrivals = listValues(c, 'arrivals', Object.keys(locations));
    const terms: SQL[] = [
      sql`p.is_deleted = 0`,
      locationFilter(departures, c.req.query('departure_keyword'), sql`p.departure_type`, sql`p.departure_custom_name`),
      locationFilter(arrivals, c.req.query('arrival_keyword'), sql`p.arrival_type`, sql`p.arrival_custom_name`),
    ];
    if (author === 'MY') terms.push(sql`p.author_id = ${userId}`);
    if (isJoined) terms.push(activeParticipant(sql`p.id`, userId!));
    if (author !== 'MY' && !isJoined)
      terms.push(sql`julianday(p.departure_date || 'T' || p.departure_time || '+09:00') > julianday(${utcText()})`);
    if (statuses.length)
      terms.push(
        sql`p.status IN (${sql.join(
          statuses.map((value) => sql`${value}`),
          sql`, `,
        )})`,
      );
    const title = c.req.query('title');
    if (title?.trim()) terms.push(sql`instr(lower(p.title), lower(${title})) > 0`);
    const condition = sql.join(terms, sql` AND `);
    const total = (await db.get<{ count: number }>(
      sql`SELECT count(*) AS count FROM ${schema.callvan_post} p WHERE ${condition}`,
    ))!.count;
    const paging = pagination(queryInteger(c, 'page'), queryInteger(c, 'limit'), total);
    const order = {
      LATEST_DESC: sql`p.created_at DESC, p.id DESC`,
      LATEST_ASC: sql`p.created_at ASC, p.id ASC`,
      DEPARTURE_ASC: sql`p.departure_date ASC, p.departure_time ASC, p.id DESC`,
      DEPARTURE_DESC: sql`p.departure_date DESC, p.departure_time DESC, p.id DESC`,
    }[sort];
    const posts = await db.all<Post & { author_nickname: string | null; joined: number }>(
      sql`SELECT p.*, u.nickname AS author_nickname, ${userId === null ? sql`0` : activeParticipant(sql`p.id`, userId)} AS joined FROM ${schema.callvan_post} p LEFT JOIN ${schema.users} u ON u.id = p.author_id WHERE ${condition} ORDER BY ${order} LIMIT ${paging.limit} OFFSET ${paging.offset}`,
    );
    return c.json({
      posts: posts.map((post) => summary(post, userId)),
      total_count: total,
      current_page: paging.page,
      total_page: Math.max(1, paging.pages),
    });
  });

  app.get('/callvan/posts/:postId/summary', async (c) => {
    const postId = integer(c.req.param('postId'));
    const db = c.get('db');
    const userId = c.get('principal')?.id ?? null;
    const post = await getPost(db, postId);
    const isJoined = await joined(db, postId, userId);
    if (!isJoined && departureMillis(post) <= Date.now()) fail('NOT_FOUND_ARTICLE');
    const author = await getUser(db, post.author_id);
    return c.json(summary({ ...post, author_nickname: author.nickname, joined: Number(isJoined) }, userId));
  });

  app.get('/callvan/posts/:postId', async (c) => {
    const userId = requirePrincipal(c, ['STUDENT']).id;
    const postId = integer(c.req.param('postId'));
    const db = c.get('db');
    await requireParticipant(db, postId, userId);
    const post = await getPost(db, postId);
    const members = await db.all<Pick<User, 'id' | 'nickname' | 'anonymous_nickname'> & { role: string }>(
      sql`SELECT u.id, u.nickname, u.anonymous_nickname, p.role FROM ${schema.callvan_participant} p JOIN ${schema.users} u ON u.id = p.member_id WHERE p.post_id = ${postId} AND p.is_deleted = 0 ORDER BY p.id`,
    );
    const isAuthor = members.some((member) => member.id === userId && member.role === 'AUTHOR');
    const reports = await db.all<{ reported_id: number }>(
      sql`SELECT DISTINCT reported_id FROM ${schema.callvan_report} WHERE callvan_post_id = ${postId} AND is_deleted = 0 AND status IN ('PENDING', 'UNDER_REVIEW', 'CONFIRMED') AND ${isAuthor ? sql`1` : sql`reporter_id = ${userId}`}`,
    );
    const reported = new Set(reports.map((report) => report.reported_id));
    const {
      author_nickname: _nickname,
      is_joined: _joined,
      is_author: _author,
      ...detail
    } = summary({ ...post, author_nickname: null, joined: 1 }, userId);
    return c.json({
      ...detail,
      participants: members.map((member) => ({
        user_id: member.id,
        nickname: displayNickname(member),
        is_me: member.id === userId,
        is_reported: reported.has(member.id),
      })),
    });
  });

  app.post('/callvan/posts/:postId/participants', async (c) => {
    const userId = requirePrincipal(c, ['STUDENT']).id;
    const postId = integer(c.req.param('postId'));
    const coordinated = await coordinateRequest(c, `callvan:${postId}`);
    if (coordinated) return coordinated;
    const db = c.get('db');
    await diagnoseJoin(db, postId, userId);
    const user = await getUser(db, userId);
    const joinedEventId = crypto.randomUUID();
    const completeEventId = crypto.randomUUID();
    const result = await executeAtomic(
      db,
      joinStatements({
        key: crypto.randomUUID(),
        postId,
        userId,
        nickname: displayNickname(user),
        now: utcText(),
        joinedEventId,
        completeEventId,
      }),
    );
    if (!result[0]?.meta.changes) {
      await diagnoseJoin(db, postId, userId);
      return conflict();
    }
    const events = [joinedEventId];
    if (result[5]?.meta.changes) events.push(completeEventId);
    await signalEvents(c.env, events);
    return c.body(null, 201);
  });

  app.delete('/callvan/posts/:postId/participants', async (c) => {
    const userId = requirePrincipal(c, ['STUDENT']).id;
    const postId = integer(c.req.param('postId'));
    const coordinated = await coordinateRequest(c, `callvan:${postId}`);
    if (coordinated) return coordinated;
    const db = c.get('db');
    const post = await getPost(db, postId);
    if (post.author_id === userId) fail('CALLVAN_POST_AUTHOR');
    await requireParticipant(db, postId, userId);
    const result = await executeAtomic(db, leaveStatements(crypto.randomUUID(), postId, userId, utcText()));
    if (!result[0]?.meta.changes) {
      await getPost(db, postId);
      fail('FORBIDDEN_PARTICIPANT');
    }
    return c.body(null, 204);
  });

  app.put('/callvan/posts/:postId/close', (c) => updateStatus(c, 'close'));
  app.put('/callvan/posts/:postId/reopen', (c) => updateStatus(c, 'reopen'));
  app.put('/callvan/posts/:postId/complete', (c) => updateStatus(c, 'complete'));
}

async function updateStatus(c: Context<ApiEnv>, action: 'close' | 'reopen' | 'complete') {
  const userId = requirePrincipal(c, ['STUDENT']).id;
  const postId = integer(c.req.param('postId'));
  const coordinated = await coordinateRequest(c, `callvan:${postId}`);
  if (coordinated) return coordinated;
  const db = c.get('db');
  const post = await getPost(db, postId);
  if (post.author_id !== userId) fail('FORBIDDEN_AUTHOR');
  if (action === 'reopen') assertReopenable(post, Date.now());
  const key = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const now = utcText();
  const extra =
    action === 'reopen'
      ? sql`AND current_participants < max_participants AND julianday(departure_date || 'T' || departure_time || '+09:00') > julianday(${now})`
      : sql``;
  const next =
    action === 'close'
      ? sql`CASE WHEN status = 'RECRUITING' THEN 'CLOSED' ELSE status END`
      : action === 'complete'
        ? sql`CASE WHEN status = 'CLOSED' THEN 'COMPLETED' ELSE status END`
        : sql`'RECRUITING'`;
  const statements = [
    beginGuard(
      key,
      sql`EXISTS (SELECT 1 FROM ${schema.callvan_post} WHERE id = ${postId} AND author_id = ${userId} AND is_deleted = 0 ${extra})`,
    ),
    sql`UPDATE ${schema.callvan_post} SET status = ${next}, updated_at = ${now} WHERE id = ${postId} AND ${gate(key)}`,
  ];
  if (action === 'close') statements.push(eventStatement(key, eventId, postId, 'RECRUITMENT_COMPLETE', {}, now));
  statements.push(endGuard(key));
  const result = await executeAtomic(db, statements);
  if (!result[0]?.meta.changes) {
    const current = await getPost(db, postId);
    if (current.author_id !== userId) fail('FORBIDDEN_AUTHOR');
    if (action === 'reopen') assertReopenable(current, Date.now());
    return conflict();
  }
  if (action === 'close') await signalEvents(c.env, [eventId]);
  return c.body(null, 204);
}
