import { and, eq, sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { requirePrincipal } from '@api/auth';
import { executeAtomic, type Database } from '@api/db/client';
import { schema } from '@api/db/schema';
import { ApiError } from '@api/errors';
import type { ApiEnv } from '@api/runtime';
import { compareEvents, eventStatus, integer, invalid, localDateTime, sqlNow, validateEvent } from '@api/domains/clubs/behavior';
import { body, clubId, getClub, getUser, requireManager, requireStudent } from '@api/domains/clubs/shared';
import { planEventReminders, signalEventReminders } from '@api/domains/clubs/schedules';

async function getEvent(db: Database, id: number) {
  const [event] = await db.select().from(schema.club_event).where(eq(schema.club_event.id, id));
  if (!event) throw new ApiError(404, 'NOT_FOUND_CLUB_EVENT', '동아리 행사가 존재하지 않습니다.');
  return event;
}

async function response(db: Database, event: typeof schema.club_event.$inferSelect, now: number) {
  const images = await db.select().from(schema.club_event_image).where(eq(schema.club_event_image.club_event_id, event.id));
  return { id: event.id, name: event.name, image_urls: images.map(image => image.image_url), start_date: localDateTime(event.start_date), end_date: localDateTime(event.end_date), introduce: event.introduce, content: event.content, status: eventStatus(event.start_date, event.end_date, now) };
}

export function registerEvents(app: Hono<ApiEnv>): void {
  app.post('/clubs/:clubId/event', async c => {
    const data = validateEvent(await body(c));
    const { club } = await requireManager(c);
    await requireStudent(c);
    const id = sql`(SELECT MAX(id) FROM ${schema.club_event})`;
    const plans = planEventReminders(id, data.start_date, false);
    await executeAtomic(c.get('db'), [
      sql`INSERT INTO ${schema.club_event} (club_id,name,start_date,end_date,introduce,content,notified_before_one_hour) VALUES (${club.id},${data.name},${data.start_date},${data.end_date},${data.introduce},${data.content},0)`,
      ...data.image_urls.map(url => sql`INSERT INTO ${schema.club_event_image} (club_event_id,image_url) VALUES (${id},${url})`),
      ...plans.map(plan => plan.statement),
    ]);
    await signalEventReminders(c.env, plans);
    return c.body(null, 200);
  });

  app.put('/clubs/:clubId/event/:eventId', async c => {
    const data = validateEvent(await body(c));
    await requireManager(c);
    await requireStudent(c);
    const db = c.get('db');
    const event = await getEvent(db, integer(c.req.param('eventId'), 'eventId'));
    const plans = planEventReminders(event.id, data.start_date, event.notified_before_one_hour);
    await executeAtomic(db, [
      sql`UPDATE ${schema.club_event} SET name=${data.name},start_date=${data.start_date},end_date=${data.end_date},introduce=${data.introduce},content=${data.content},updated_at=${sqlNow()} WHERE id=${event.id}`,
      sql`DELETE FROM ${schema.club_event_image} WHERE club_event_id=${event.id}`,
      ...data.image_urls.map(url => sql`INSERT INTO ${schema.club_event_image} (club_event_id,image_url) VALUES (${event.id},${url})`),
      ...plans.map(plan => plan.statement),
    ]);
    await signalEventReminders(c.env, plans);
    return c.body(null, 200);
  });

  app.delete('/clubs/:clubId/event/:eventId', async c => {
    await requireManager(c);
    await requireStudent(c);
    const db = c.get('db');
    const event = await getEvent(db, integer(c.req.param('eventId'), 'eventId'));
    await executeAtomic(db, [
      sql`DELETE FROM ${schema.club_event_image} WHERE club_event_id=${event.id}`,
      sql`DELETE FROM ${schema.club_event_subscription} WHERE event_id=${event.id}`,
      sql`DELETE FROM ${schema.club_event} WHERE id=${event.id}`,
    ]);
    return c.body(null, 204);
  });

  app.get('/clubs/:clubId/event/:eventId', async c => {
    const event = await getEvent(c.get('db'), integer(c.req.param('eventId'), 'eventId'));
    if (event.club_id !== clubId(c)) throw new ApiError(404, 'NOT_FOUND_CLUB_EVENT', '동아리 행사가 존재하지 않습니다.');
    return c.json(await response(c.get('db'), event, Date.now()));
  });

  app.get('/clubs/:clubId/events', async c => {
    const db = c.get('db');
    const events = await db.select().from(schema.club_event).where(eq(schema.club_event.club_id, clubId(c)));
    const type = c.req.query('eventType') ?? 'RECENT';
    if (!['RECENT', 'ONGOING', 'UPCOMING', 'ENDED'].includes(type)) invalid('eventType', '지원하지 않는 행사 타입입니다.');
    const now = Date.now();
    const user = c.get('principal')?.id;
    const subscriptions = user === undefined ? [] : await db.select({ event_id: schema.club_event_subscription.event_id }).from(schema.club_event_subscription).where(eq(schema.club_event_subscription.user_id, user));
    const subscribed = new Set(subscriptions.map(item => item.event_id));
    const filtered = events.filter(event => {
      const status = eventStatus(event.start_date, event.end_date, now);
      return type === 'RECENT' || (type === 'ONGOING' ? status === 'SOON' || status === 'ONGOING' : status === type);
    }).sort((a, b) => compareEvents(a, b, type, now));
    return c.json(await Promise.all(filtered.map(async event => ({ ...await response(db, event, now), is_subscribed: subscribed.has(event.id) }))));
  });

  app.post('/clubs/:clubId/event/:eventId/notification', async c => {
    const user = requirePrincipal(c, ['STUDENT']).id;
    const db = c.get('db');
    await getClub(db, clubId(c));
    await getUser(db, user);
    const event = await getEvent(db, integer(c.req.param('eventId'), 'eventId'));
    if (event.club_id !== clubId(c)) throw new ApiError(400, 'NOT_MATCHED_CLUB_AND_EVENT', '해당 동아리의 이벤트가 아닙니다.');
    const [existing] = await db.select({ id: schema.club_event_subscription.id }).from(schema.club_event_subscription).where(and(eq(schema.club_event_subscription.event_id, event.id), eq(schema.club_event_subscription.user_id, user)));
    if (!existing) {
      const plans = planEventReminders(event.id, event.start_date, event.notified_before_one_hour);
      await executeAtomic(db, [
        sql`INSERT INTO ${schema.club_event_subscription} (event_id,user_id) VALUES (${event.id},${user}) ON CONFLICT DO NOTHING`,
        ...plans.map(plan => plan.statement),
      ]);
      await signalEventReminders(c.env, plans);
    }
    return c.body(null, 201);
  });

  app.delete('/clubs/:clubId/event/:eventId/notification', async c => {
    const user = requirePrincipal(c, ['STUDENT']).id;
    const db = c.get('db');
    await getClub(db, clubId(c));
    await getUser(db, user);
    const event = await getEvent(db, integer(c.req.param('eventId'), 'eventId'));
    if (event.club_id !== clubId(c)) throw new ApiError(400, 'NOT_MATCHED_CLUB_AND_EVENT', '해당 동아리의 이벤트가 아닙니다.');
    await db.delete(schema.club_event_subscription).where(and(eq(schema.club_event_subscription.event_id, event.id), eq(schema.club_event_subscription.user_id, user)));
    return c.body(null, 204);
  });
}
