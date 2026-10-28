import { sql, type SQL } from 'drizzle-orm';
import type { Hono } from 'hono';
import { requirePrincipal } from '@api/auth';
import { schema } from '@api/db/schema';
import type { ApiEnv } from '@api/runtime';
import {
  array, atomic, body, catalogError, catalogNow, integer, invalid, kstDate, outbox, ownerCondition, rows, shop, signalCatalogJobs, text,
  type CatalogContext,
} from '@api/domains/commerce/catalog-shared';

type Event = typeof schema.event_articles.$inferSelect;
type EventRow = Event & { shop_name: string; event_banner_image_url: string | null };

/**
 * 상점 이벤트 목록. 사장님 조회(`owner`)는 기간과 무관하게 전체를 최근 수정순으로, 그 밖에는
 * 오늘(KST) 진행 중인 이벤트만 id순으로 돌려준다. 상점 지정 조회만 썸네일을 읽고, 전체 조회는
 * 카테고리 배너 이미지로 대신한다.
 */
async function events(c: CatalogContext, shopId?: number, owner = false) {
  const today = kstDate();
  const shopFilter = shopId ? sql`and e.shop_id=${shopId}` : sql``;
  const periodFilter = owner ? sql`` : sql`and e.start_date<=${today} and e.end_date>=${today}`;
  const order = owner ? sql`e.updated_at desc` : sql`e.id`;
  const values = await rows<EventRow>(c, sql`select e.*,s.name as shop_name,sc.event_banner_image_url from ${schema.event_articles} e join ${schema.shops} s on s.id=e.shop_id left join ${schema.shop_categories} sc on sc.id=s.main_category_id where e.is_deleted=0 and s.is_deleted=0 ${shopFilter} ${periodFilter} order by ${order}`);
  const thumbnails = async (event: EventRow): Promise<string[] | null> => {
    if (shopId) {
      const images = await rows<{ thumbnail_image: string }>(c, sql`select thumbnail_image from ${schema.event_article_thumbnail_images} where event_id=${event.id} order by id`);
      return images.map((row) => row.thumbnail_image);
    }
    return event.event_banner_image_url == null ? null : [event.event_banner_image_url];
  };
  return {
    events: await Promise.all(values.map(async (event) => ({
      shop_id: event.shop_id,
      shop_name: event.shop_name,
      event_id: event.id,
      title: event.title,
      content: event.content,
      thumbnail_images: await thumbnails(event),
      start_date: event.start_date,
      end_date: event.end_date,
    }))),
  };
}

function calendarDate(value: unknown, field: string): string {
  const date = text(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
    invalid(field, '날짜 형식이 올바르지 않습니다.');
  }
  return date;
}

async function saveEvent(c: CatalogContext, shopId: number, eventId?: number) {
  const owned = await shop(c, shopId, true);
  const b = await body(c);
  if (eventId) {
    const [event] = await rows<Event>(c, sql`select * from ${schema.event_articles} where id=${eventId} and shop_id=${shopId} and is_deleted=0`);
    if (!event) catalogError(404, '', `존재하지 않는 이벤트 입니다. eventId: ${eventId}`);
  }
  const title = text(b.title, 'title', 1, 255);
  const content = text(b.content, 'content');
  const images = array(b.thumbnail_images, 'thumbnail_images', 0, 3).map((value) => text(value, 'thumbnail_images', 0));
  const start = calendarDate(b.start_date, 'start_date');
  const end = calendarDate(b.end_date, 'end_date');
  if (start > end) catalogError(400, 'INVALID_START_DATE_AFTER_END_DATE', '시작일은 종료일 이전이여야 합니다.');
  const now = catalogNow();
  const id = eventId ? sql`${eventId}` : sql`(select max(id) from ${schema.event_articles})`;
  const statements: SQL[] = eventId
    ? [
      sql`update ${schema.event_articles} set title=${title},content=${content},start_date=${start},end_date=${end},updated_at=${now} where id=${eventId} and shop_id=${shopId}`,
      sql`delete from ${schema.event_article_thumbnail_images} where event_id=${eventId}`,
    ]
    : [sql`insert into ${schema.event_articles} (shop_id,title,content,user_id,hit,ip,start_date,end_date,is_deleted,created_at,updated_at) values (${shopId},${title},${content},${owned.owner_id},0,'',${start},${end},0,${now},${now})`];
  statements.push(...images.map((image) => sql`insert into ${schema.event_article_thumbnail_images} (event_id,thumbnail_image,created_at,updated_at) values (${id},${image},${now},${now})`));
  const jobs: { kind: string; key: string }[] = [];
  if (!eventId) {
    const subscriptions = await rows<{ user_id: number }>(c, sql`select distinct ns.user_id from ${schema.notification_subscribe} ns join ${schema.users} u on u.id=ns.user_id where ns.subscribe_type='SHOP_EVENT' and ns.detail_type is null and u.device_token is not null and u.is_deleted=0`);
    for (const subscription of subscriptions) {
      const job = { kind: 'commerce.catalog.shop-event', key: crypto.randomUUID() };
      statements.push(outbox(job.kind, { userId: subscription.user_id, shopId, shopName: owned.name, title, imageUrl: images[0] ?? null }, Date.now(), job.key));
      jobs.push(job);
    }
  }
  await atomic(c.env, statements, ownerCondition(c, shopId));
  signalCatalogJobs(c, jobs);
}

export function registerCatalogEvents(app: Hono<ApiEnv>): void {
  app.get('/shops/events', async (c) => c.json(await events(c)));
  app.get('/shops/events/count', async (c) => {
    const today = kstDate();
    const [result] = await rows<{ count: number }>(c, sql`select count(distinct e.shop_id) as count from ${schema.event_articles} e join ${schema.shops} s on s.id=e.shop_id where s.is_deleted=0 and e.is_deleted=0 and e.start_date<=${today} and e.end_date>=${today}`);
    return c.json(result);
  });
  app.get('/shops/:shopId/events', async (c) => {
    const found = await shop(c, integer(c.req.param('shopId')));
    return c.json(await events(c, found.id));
  });
  app.get('/owner/shops/:shopId/event', async (c) => {
    const found = await shop(c, integer(c.req.param('shopId')), true);
    return c.json(await events(c, found.id, true));
  });
  app.post('/owner/shops/:shopId/event', async (c) => {
    requirePrincipal(c, ['OWNER']);
    await saveEvent(c, integer(c.req.param('shopId')));
    return c.body(null, 201);
  });
  app.put('/owner/shops/:shopId/events/:eventId', async (c) => {
    requirePrincipal(c, ['OWNER']);
    await saveEvent(c, integer(c.req.param('shopId')), integer(c.req.param('eventId')));
    return c.body(null, 201);
  });
  app.delete('/owner/shops/:shopId/events/:eventId', async (c) => {
    const found = await shop(c, integer(c.req.param('shopId')), true);
    const id = integer(c.req.param('eventId'));
    const [event] = await rows<Event>(c, sql`select * from ${schema.event_articles} where id=${id} and is_deleted=0`);
    if (!event) return c.body(null, 204);
    if (event.shop_id !== found.id) catalogError(404, '', `존재하지 않는 이벤트 입니다. eventId: ${id}`);
    await atomic(c.env, [
      sql`delete from ${schema.event_article_thumbnail_images} where event_id=${id}`,
      sql`update ${schema.event_articles} set is_deleted=1 where id=${id} and shop_id=${found.id}`,
    ], ownerCondition(c, found.id));
    return c.body(null, 204);
  });
}
