import { and, eq, sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { requirePrincipal } from '@api/auth';
import { executeAtomic } from '@api/db/client';
import { schema } from '@api/db/schema';
import { ApiError } from '@api/errors';
import type { ApiEnv } from '@api/runtime';
import { recruitmentInfo, sqlNow, validateRecruitment } from '@api/domains/clubs/behavior';
import {
  body,
  clubId,
  getClub,
  getUser,
  manager,
  outboxSql,
  requireManager,
  requireStudent,
  signalClubJobs,
} from '@api/domains/clubs/shared';

export function registerRecruitment(app: Hono<ApiEnv>): void {
  app.get('/clubs/:clubId/recruitment', async (c) => {
    const db = c.get('db');
    const id = clubId(c);
    await getClub(db, id);
    const [recruitment] = await db
      .select()
      .from(schema.club_recruitment)
      .where(eq(schema.club_recruitment.club_id, id));
    if (!recruitment) throw new ApiError(404, 'NOT_FOUND_CLUB_RECRUITMENT', '동아리 모집 공고가 존재하지 않습니다.');
    return c.json({
      id: recruitment.id,
      ...recruitmentInfo(recruitment.is_always_recruiting, recruitment.start_date, recruitment.end_date),
      start_date: recruitment.start_date?.replaceAll('-', '.') ?? null,
      end_date: recruitment.end_date?.replaceAll('-', '.') ?? null,
      image_url: recruitment.image_url,
      content: recruitment.content,
      is_manager: await manager(db, id, c.get('principal')?.id ?? null),
    });
  });

  app.post('/clubs/:clubId/recruitment', async (c) => {
    const data = validateRecruitment(await body(c));
    const { club } = await requireManager(c);
    await requireStudent(c);
    const db = c.get('db');
    const [existing] = await db
      .select({ id: schema.club_recruitment.id })
      .from(schema.club_recruitment)
      .where(eq(schema.club_recruitment.club_id, club.id));
    if (existing) throw new ApiError(409, 'DUPLICATE_CLUB_RECRUITMENT', '동아리 공고가 이미 존재합니다.');
    const subscriptions = await db
      .select()
      .from(schema.club_recruitment_subscription)
      .where(eq(schema.club_recruitment_subscription.club_id, club.id));
    const deliveryIds = subscriptions.map(() => crypto.randomUUID());
    await executeAtomic(db, [
      sql`INSERT INTO ${schema.club_recruitment} (club_id,start_date,end_date,is_always_recruiting,image_url,content) VALUES (${club.id},${data.start_date},${data.end_date},${data.is_always_recruiting},${data.image_url},${data.content})`,
      ...subscriptions.map((subscription, index) =>
        outboxSql(
          'recruitment',
          { userId: subscription.user_id, clubId: club.id, clubName: club.name },
          deliveryIds[index],
        ),
      ),
    ]);
    await signalClubJobs(c.env, deliveryIds);
    return c.body(null, 200);
  });

  app.put('/clubs/:clubId/recruitment', async (c) => {
    const data = validateRecruitment(await body(c));
    const { club } = await requireManager(c);
    await requireStudent(c);
    const db = c.get('db');
    const [existing] = await db
      .select()
      .from(schema.club_recruitment)
      .where(eq(schema.club_recruitment.club_id, club.id));
    if (!existing) throw new ApiError(404, 'NOT_FOUND_CLUB_RECRUITMENT', '동아리 모집 공고가 존재하지 않습니다.');
    const subscriptions = await db
      .select()
      .from(schema.club_recruitment_subscription)
      .where(eq(schema.club_recruitment_subscription.club_id, club.id));
    const deliveryIds = subscriptions.map(() => crypto.randomUUID());
    await executeAtomic(db, [
      sql`UPDATE ${schema.club_recruitment} SET start_date=${data.start_date},end_date=${data.end_date},is_always_recruiting=${data.is_always_recruiting},image_url=${data.image_url},content=${data.content},updated_at=${sqlNow()} WHERE id=${existing.id}`,
      ...subscriptions.map((subscription, index) =>
        outboxSql(
          'recruitment',
          { userId: subscription.user_id, clubId: club.id, clubName: club.name },
          deliveryIds[index],
        ),
      ),
    ]);
    await signalClubJobs(c.env, deliveryIds);
    return c.body(null, 200);
  });

  app.delete('/clubs/:clubId/recruitment', async (c) => {
    const { club } = await requireManager(c);
    await requireStudent(c);
    const deleted = await c
      .get('db')
      .delete(schema.club_recruitment)
      .where(eq(schema.club_recruitment.club_id, club.id))
      .returning({ id: schema.club_recruitment.id });
    if (!deleted.length) throw new ApiError(404, 'NOT_FOUND_CLUB_RECRUITMENT', '동아리 모집 공고가 존재하지 않습니다.');
    return c.body(null, 204);
  });

  app.post('/clubs/:clubId/recruitment/notification', async (c) => {
    const userId = requirePrincipal(c, ['STUDENT']).id;
    const db = c.get('db');
    const id = clubId(c);
    await getClub(db, id);
    await getUser(db, userId);
    await db
      .insert(schema.club_recruitment_subscription)
      .values({ club_id: id, user_id: userId })
      .onConflictDoNothing();
    return c.body(null, 201);
  });

  app.delete('/clubs/:clubId/recruitment/notification', async (c) => {
    const userId = requirePrincipal(c, ['STUDENT']).id;
    const db = c.get('db');
    const id = clubId(c);
    await getClub(db, id);
    await getUser(db, userId);
    await db
      .delete(schema.club_recruitment_subscription)
      .where(
        and(
          eq(schema.club_recruitment_subscription.club_id, id),
          eq(schema.club_recruitment_subscription.user_id, userId),
        ),
      );
    return c.body(null, 204);
  });
}
