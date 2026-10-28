import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { requirePrincipal } from '@api/auth';
import { executeAtomic } from '@api/db/client';
import { schema } from '@api/db/schema';
import { ApiError } from '@api/errors';
import type { ApiEnv } from '@api/runtime';
import { integer, invalid, kstDate, normalizeName, recruitmentInfo, sqlNow, text, validateClub } from '@api/domains/clubs/behavior';
import { body, clubId, clubResponse, contactsSql, getCategory, getClub, getUser, missing, outboxSql, requireManager } from '@api/domains/clubs/shared';

export function registerCatalog(app: Hono<ApiEnv>): void {
  app.get('/clubs/categories', async c => c.json({ club_categories: await c.get('db').select().from(schema.club_category) }));

  app.get('/clubs/search/related', async c => {
    const query = normalizeName(c.req.query('query') ?? '');
    if (!query) return c.json({ keywords: [] });
    const clubs = await c.get('db').select({ club_id: schema.club.id, club_name: schema.club.name }).from(schema.club)
      .where(and(eq(schema.club.is_active, true), sql`${schema.club.normalized_name} LIKE ${`${query}%`}`)).orderBy(asc(schema.club.normalized_name)).limit(5);
    return c.json({ keywords: clubs });
  });

  app.get('/clubs/hot', async c => {
    const db = c.get('db');
    const [cache] = await db.select().from(schema.native_club_hot).where(eq(schema.native_club_hot.key, 'hot'));
    if (cache) return c.json(JSON.parse(cache.payload));
    const [hot] = await db.select().from(schema.club_hot).orderBy(desc(schema.club_hot.end_date)).limit(1);
    if (!hot) missing('인기 동아리가 존재하지 않습니다.');
    const club = await getClub(db, hot.club_id);
    const response = { club_id: club.id, name: club.name, image_url: club.image_url };
    await db.insert(schema.native_club_hot).values({ key: 'hot', payload: JSON.stringify(response) }).onConflictDoNothing();
    return c.json(response);
  });

  app.get('/clubs', async c => {
    const db = c.get('db');
    const userId = c.get('principal')?.id ?? null;
    const recruitingValue = c.req.query('isRecruiting') ?? 'false';
    if (!['true', 'false'].includes(recruitingValue)) invalid('isRecruiting', '올바른 Boolean 값이 아닙니다.');
    const recruiting = recruitingValue === 'true';
    const sort = c.req.query('sortType') ?? 'CREATED_AT_ASC';
    if (!['NONE', 'CREATED_AT_ASC', 'HITS_DESC', 'RECRUITMENT_UPDATED_DESC', 'RECRUITING_DEADLINE_ASC'].includes(sort)) invalid('sortType', '지원하지 않는 정렬 방식입니다.');
    if (!recruiting && ['RECRUITMENT_UPDATED_DESC', 'RECRUITING_DEADLINE_ASC'].includes(sort)) throw new ApiError(400, 'NOT_ALLOWED_RECRUITING_SORT_TYPE', '해당 정렬 방식은 모집 중일 때만 사용할 수 있습니다.');
    const category = c.req.query('categoryId');
    const query = normalizeName(c.req.query('query') ?? '');
    const today = kstDate();
    const r = schema.club_recruitment;
    const order = sort === 'HITS_DESC' ? [desc(schema.club.hits)] : sort === 'RECRUITMENT_UPDATED_DESC' ? [desc(r.updated_at)] : sort === 'RECRUITING_DEADLINE_ASC'
      ? [sql`CASE WHEN ${r.is_always_recruiting} = 1 THEN 1 WHEN ${r.start_date} > ${today} THEN 2 ELSE 0 END ASC`, asc(r.end_date)] : [asc(schema.club.created_at)];
    const clubs = await db.select({ club: schema.club, category: schema.club_category.name, recruitment: r }).from(schema.club)
      .innerJoin(schema.club_category, eq(schema.club.club_category_id, schema.club_category.id))
      .leftJoin(r, eq(r.club_id, schema.club.id))
      .where(and(eq(schema.club.is_active, true), category === undefined ? undefined : eq(schema.club.club_category_id, integer(category, 'categoryId')),
        query ? sql`instr(${schema.club.normalized_name},${query}) > 0` : undefined,
        recruiting ? sql`${r.id} IS NOT NULL AND (${r.end_date} >= ${today} OR ${r.is_always_recruiting} = 1)` : undefined)).orderBy(...order);
    const likes = userId === null ? [] : await db.select({ club_id: schema.club_like.club_id }).from(schema.club_like).where(eq(schema.club_like.user_id, userId));
    const liked = new Set(likes.map(item => item.club_id));
    return c.json({ clubs: clubs.map(({ club, category: categoryName, recruitment }) => ({
      id: club.id, name: club.name, category: categoryName, likes: club.likes, image_url: club.image_url,
      is_liked: liked.has(club.id), is_like_hidden: club.is_like_hidden,
      recruitment_info: recruitmentInfo(recruitment?.is_always_recruiting ?? null, recruitment?.start_date ?? null, recruitment?.end_date ?? null, today),
    })) });
  });

  app.post('/clubs', async c => {
    const user = requirePrincipal(c, ['STUDENT']).id;
    const request = await body(c);
    validateClub(request, 'request');
    const name = request.name as string;
    const now = Date.now();
    const deliveryId = crypto.randomUUID();
    await executeAtomic(c.get('db'), [
      sql`INSERT INTO ${schema.native_club_requests} (name,payload,requester_id,created_at,expires_at) VALUES (${name},${JSON.stringify(request)},${user},${sqlNow(now)},${sqlNow(now + 3 * 86400000)}) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload,requester_id=excluded.requester_id,created_at=excluded.created_at,expires_at=excluded.expires_at`,
      outboxSql('slack', { clubName: name }, deliveryId),
    ]);
    await c.env.JOBS.send({ kind: 'clubs.outbox', key: deliveryId, payload: {} });
    return c.body(null, 200);
  });

  app.put('/clubs/empowerment', async c => {
    const request = await body(c);
    const id = integer(request.club_id, 'club_id');
    const { userId } = await requireManager(c, id);
    const login = text(request, 'changed_manager_id', 255, true)!;
    const db = c.get('db');
    const [next] = await db.select().from(schema.users).where(and(eq(schema.users.user_id, login), eq(schema.users.is_deleted, false), inArray(schema.users.user_type, ['STUDENT', 'COUNCIL']))).limit(1);
    if (!next) missing('사용자가 존재하지 않습니다.');
    const [existing] = await db.select().from(schema.club_manager).where(and(eq(schema.club_manager.club_id, id), eq(schema.club_manager.user_id, next.id))).limit(1);
    if (existing) throw new ApiError(400, 'INVALID_REQUEST', '이미 동아리의 관리자입니다.');
    await executeAtomic(db, [
      sql`DELETE FROM ${schema.club_manager} WHERE club_id=${id} AND user_id=${userId}`,
      sql`INSERT INTO ${schema.club_manager} (club_id,user_id) VALUES (${id},${next.id})`,
    ]);
    return c.body(null, 200);
  });

  app.get('/clubs/:clubId', async c => {
    const db = c.get('db');
    const club = await getClub(db, clubId(c));
    if (!club.is_active) throw new ApiError(400, 'ILLEGAL_STATE', '잘못된 상태로 요청이 들어왔습니다.');
    await db.insert(schema.native_club_hits).values({ club_id: club.id, hits: 1 }).onConflictDoUpdate({ target: schema.native_club_hits.club_id, set: { hits: sql`${schema.native_club_hits.hits} + 1` } });
    return c.json(await clubResponse(db, club, c.get('principal')?.id ?? null, true));
  });

  app.put('/clubs/:clubId', async c => {
    const { club, userId } = await requireManager(c);
    const data = validateClub(await body(c), 'update');
    const db = c.get('db');
    await getCategory(db, data.club_category_id);
    await executeAtomic(db, [
      sql`UPDATE ${schema.club} SET name=${data.name},normalized_name=${data.normalized_name},image_url=${data.image_url},club_category_id=${data.club_category_id},location=${data.location},description=${data.description},is_like_hidden=${data.is_like_hidden},updated_at=${sqlNow()} WHERE id=${club.id}`,
      sql`DELETE FROM ${schema.club_sns} WHERE club_id=${club.id}`,
      ...contactsSql(club.id, data.contacts, true),
    ]);
    return c.json(await clubResponse(db, await getClub(db, club.id), userId));
  });

  app.put('/clubs/:clubId/introduction', async c => {
    const { club, userId } = await requireManager(c);
    const introduction = text(await body(c), 'introduction', Infinity, true)!;
    const db = c.get('db');
    const [updated] = await db.update(schema.club).set({ introduction, updated_at: sqlNow() }).where(eq(schema.club.id, club.id)).returning();
    return c.json(await clubResponse(db, updated!, userId));
  });

  app.put('/clubs/:clubId/like', async c => {
    const user = requirePrincipal(c, ['STUDENT']).id;
    const db = c.get('db');
    const id = clubId(c);
    await getClub(db, id);
    await getUser(db, user);
    const result = await executeAtomic(db, [
      sql`INSERT INTO ${schema.club_like} (club_id,user_id) SELECT ${id},${user} WHERE NOT EXISTS (SELECT 1 FROM ${schema.club_like} WHERE club_id=${id} AND user_id=${user})`,
      sql`UPDATE ${schema.club} SET likes=likes+1,updated_at=${sqlNow()} WHERE id=${id} AND changes() > 0`,
    ]);
    if (!result[0]?.meta.changes) throw new ApiError(409, 'DUPLICATION', '이미 좋아요를 누른 동아리입니다!');
    return c.body(null, 200);
  });

  app.delete('/clubs/:clubId/like/cancel', async c => {
    const user = requirePrincipal(c, ['STUDENT']).id;
    const db = c.get('db');
    const id = clubId(c);
    await getClub(db, id);
    await getUser(db, user);
    const result = await executeAtomic(db, [
      sql`DELETE FROM ${schema.club_like} WHERE club_id=${id} AND user_id=${user}`,
      sql`UPDATE ${schema.club} SET likes=likes-1,updated_at=${sqlNow()} WHERE id=${id} AND changes() > 0`,
    ]);
    if (!result[0]?.meta.changes) missing('좋아요를 누른 적 없는 동아리입니다!');
    return c.body(null, 200);
  });
}
