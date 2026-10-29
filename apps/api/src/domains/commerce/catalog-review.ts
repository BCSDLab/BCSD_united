import { sql, type SQL } from 'drizzle-orm';
import type { Hono } from 'hono';
import { requirePrincipal } from '@api/auth';
import { schema } from '@api/db/schema';
import type { ApiEnv } from '@api/runtime';
import {
  array,
  atomic,
  body,
  catalogDate,
  catalogError,
  catalogNow,
  integer,
  invalid,
  object,
  outbox,
  pageInfo,
  rows,
  shop,
  signalCatalogJobs,
  strings,
  text,
  type CatalogContext,
  type JsonObject,
} from '@api/domains/commerce/catalog-shared';

type Review = typeof schema.shop_reviews.$inferSelect;
const REVIEWER_ROLES = ['STUDENT', 'COUNCIL'] as const;
const DAY_MS = 86400000;

async function review(c: CatalogContext, id: number): Promise<Review> {
  const [value] = await rows<Review>(c, sql`select * from ${schema.shop_reviews} where id=${id} and is_deleted=0`);
  if (!value) catalogError(404, '', `리뷰가 존재하지 않습니다. reviewId: ${id}`);
  return value;
}

async function reviewResponse(c: CatalogContext, value: Review) {
  const [user] = await rows<{ nickname: string | null; anonymous_nickname: string }>(
    c,
    sql`select nickname,anonymous_nickname from ${schema.users} where id=${value.reviewer_id}`,
  );
  const [images, menus] = await Promise.all([
    rows<{ image_urls: string }>(
      c,
      sql`select image_urls from ${schema.shop_review_images} where review_id=${value.id} order by id`,
    ),
    rows<{ menu_name: string }>(
      c,
      sql`select menu_name from ${schema.shop_review_menus} where review_id=${value.id} order by id`,
    ),
  ]);
  return {
    review_id: value.id,
    rating: value.rating,
    nick_name: user?.nickname ?? user?.anonymous_nickname ?? null,
    content: value.content,
    image_urls: images.map((row) => row.image_urls),
    menu_names: menus.map((row) => row.menu_name),
    is_modified: value.created_at !== value.updated_at,
    created_at: value.created_at === null ? null : catalogDate(value.created_at),
  };
}

function reviewOrder(c: CatalogContext): SQL {
  const sorter = c.req.query('sorter') ?? 'LATEST';
  switch (sorter) {
    case 'LATEST':
      return sql`created_at desc`;
    case 'OLDEST':
      return sql`created_at asc`;
    case 'HIGHEST_RATING':
      return sql`rating desc`;
    case 'LOWEST_RATING':
      return sql`rating asc`;
    default:
      return invalid('sorter', '유효하지 않은 정렬입니다.');
  }
}

/** 작성과 수정이 같은 본문 규칙을 쓴다. `content`가 없을 때의 기본값만 호출자가 정한다. */
function reviewInput(b: JsonObject, emptyContent: string | null) {
  const rating = integer(b.rating, 'rating');
  if (rating > 5) invalid('rating', '5 이하여야 합니다.');
  const content = b.content == null ? emptyContent : text(b.content, 'content', 0);
  const images = strings(b.image_urls ?? [], 'image_urls', 3);
  const menus = array(b.menu_names ?? [], 'menu_names').map((value) => text(value, 'menu_names'));
  return { rating, content, images, menus };
}

function reviewAttachmentStatements(reviewId: SQL, images: string[], menus: string[], now: string): SQL[] {
  return [
    ...images.map(
      (image) =>
        sql`insert into ${schema.shop_review_images} (review_id,image_urls,created_at,updated_at) values (${reviewId},${image},${now},${now})`,
    ),
    ...menus.map(
      (menu) =>
        sql`insert into ${schema.shop_review_menus} (review_id,menu_name,created_at,updated_at) values (${reviewId},${menu},${now},${now})`,
    ),
  ];
}

/** 조회한 리뷰가 요청한 상점의 것인지 확인한다. 다른 상점의 리뷰 id는 존재하지 않는 것으로 취급한다. */
function requireShopReview(found: Review, shopId: number, message: string): void {
  if (found.shop_id !== shopId) catalogError(404, '', message);
}

export function registerCatalogReviews(app: Hono<ApiEnv>) {
  app.get('/shops/reviews/reports/categories', async (c) => {
    const categories = await rows<{ name: string; detail: string }>(
      c,
      sql`select name,detail from ${schema.shop_review_reports_categories} order by id`,
    );
    return c.json({ count: categories.length, categories });
  });
  app.get('/shops/:shopId/reviews/me', async (c) => {
    const user = requirePrincipal(c, [...REVIEWER_ROLES]);
    const shopId = integer(c.req.param('shopId'));
    const values = await rows<Review>(
      c,
      sql`select * from ${schema.shop_reviews} where shop_id=${shopId} and reviewer_id=${user.id} and is_deleted=0 order by ${reviewOrder(c)}`,
    );
    const reviews = await Promise.all(
      values.map(async (found) => ({ ...(await reviewResponse(c, found)), is_mine: true })),
    );
    return c.json({ count: reviews.length, reviews });
  });
  app.get('/shops/:shopId/reviews', async (c) => {
    const shopId = integer(c.req.param('shopId'));
    const limit = Math.max(1, Math.min(50, Number(c.req.query('limit') ?? 50)));
    const page = Math.max(1, Number(c.req.query('page') ?? 1));
    if (!Number.isInteger(limit) || !Number.isInteger(page)) invalid('page', '페이지 값이 올바르지 않습니다.');
    const ratings: Record<string, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    const groups = await rows<{ rating: number; count: number }>(
      c,
      sql`select rating,count(*) count from ${schema.shop_reviews} where shop_id=${shopId} and is_deleted=0 group by rating`,
    );
    let total = 0;
    let sum = 0;
    for (const group of groups) {
      ratings[group.rating] = group.count;
      total += group.count;
      sum += group.rating * group.count;
    }
    const { offset, ...paging } = pageInfo(total, page, limit);
    const values = await rows<Review>(
      c,
      sql`select * from ${schema.shop_reviews} where shop_id=${shopId} and is_deleted=0 order by ${reviewOrder(c)} limit ${limit} offset ${offset}`,
    );
    const reviews = await Promise.all(
      values.map(async (found) => {
        const [reported] = await rows<{ reported: number }>(
          c,
          sql`select exists(select 1 from ${schema.shop_review_reports} where review_id=${found.id} and status<>'DISMISSED') reported`,
        );
        return {
          ...(await reviewResponse(c, found)),
          is_mine: found.reviewer_id === c.get('principal')?.id,
          is_reported: !!reported!.reported,
        };
      }),
    );
    const average_rating = total ? Math.round((sum / total) * 10) / 10 : 0;
    return c.json({ ...paging, current_count: reviews.length, statistics: { average_rating, ratings }, reviews });
  });
  app.get('/shops/:shopId/reviews/:reviewId', async (c) => {
    const found = await review(c, integer(c.req.param('reviewId')));
    requireShopReview(found, integer(c.req.param('shopId')), '리뷰가 존재하지 않습니다. 해당 상점의 리뷰가 아닙니다.');
    return c.json(await reviewResponse(c, found));
  });
  app.post('/shops/:shopId/reviews', async (c) => {
    const user = requirePrincipal(c, [...REVIEWER_ROLES]);
    const shopId = integer(c.req.param('shopId'));
    const found = await shop(c, shopId);
    const { rating, content, images, menus } = reviewInput(await body(c), '');
    const now = catalogNow();
    const since = new Date(Date.now() - DAY_MS).toISOString().replace('T', ' ').replace('Z', '');
    const existing = await rows<{ id: number }>(
      c,
      sql`select id from ${schema.shop_reviews} where reviewer_id=${user.id} and shop_id=${shopId} and created_at>${since} limit 1`,
    );
    const rateMessage = `한 상점에 하루에 한번만 리뷰를 남길 수 있습니다. studentId : ${user.id}shopId : ${shopId}`;
    if (existing.length) catalogError(400, '', rateMessage);
    const id = sql`(select max(id) from ${schema.shop_reviews})`;
    const job = { kind: 'commerce.catalog.review-created', key: crypto.randomUUID() };
    try {
      await atomic(c.env, [
        sql`insert into ${schema.shop_reviews} (shop_id,reviewer_id,rating,content,is_deleted,created_at,updated_at) values (${shopId},${user.id},${rating},${content},0,${now},${now})`,
        ...reviewAttachmentStatements(id, images, menus, now),
        outbox(job.kind, { shop: found.name, content, rating }, Date.now(), job.key),
      ]);
    } catch (error) {
      // 사전 조회를 통과해도 동시 요청은 DB 트리거(CATALOG_ONE_REVIEW_PER_DAY)가 막는다.
      if (String(error).includes('CATALOG_ONE_REVIEW_PER_DAY')) catalogError(400, '', rateMessage);
      throw error;
    }
    signalCatalogJobs(c, [job]);
    return c.body(null, 201);
  });
  app.put('/shops/:shopId/reviews/:reviewId', async (c) => {
    const user = requirePrincipal(c, [...REVIEWER_ROLES]);
    const found = await review(c, integer(c.req.param('reviewId')));
    if (found.reviewer_id !== user.id) catalogError(401, 'UNAUTHORIZED_USER', '인증이 필요합니다.');
    const { rating, content, images, menus } = reviewInput(await body(c), null);
    const now = catalogNow();
    await atomic(c.env, [
      sql`update ${schema.shop_reviews} set rating=${rating},content=${content},updated_at=${now} where id=${found.id} and reviewer_id=${user.id}`,
      sql`delete from ${schema.shop_review_images} where review_id=${found.id}`,
      sql`delete from ${schema.shop_review_menus} where review_id=${found.id}`,
      ...reviewAttachmentStatements(sql`${found.id}`, images, menus, now),
    ]);
    return c.body(null, 204);
  });
  app.delete('/shops/:shopId/reviews/:reviewId', async (c) => {
    const user = requirePrincipal(c, [...REVIEWER_ROLES]);
    const found = await review(c, integer(c.req.param('reviewId')));
    if (found.reviewer_id !== user.id) catalogError(401, 'UNAUTHORIZED_USER', '인증이 필요합니다.');
    await atomic(c.env, [
      sql`update ${schema.shop_reviews} set is_deleted=1,updated_at=${catalogNow()} where id=${found.id} and reviewer_id=${user.id}`,
    ]);
    return c.body(null, 204);
  });
  app.post('/shops/:shopId/reviews/:reviewId/reports', async (c) => {
    const user = requirePrincipal(c, [...REVIEWER_ROLES]);
    const found = await review(c, integer(c.req.param('reviewId')));
    const shopId = integer(c.req.param('shopId'));
    requireShopReview(found, shopId, `리뷰가 존재하지 않습니다. reviewId: ${found.id}`);
    const reported = await shop(c, shopId);
    const reports = array((await body(c)).reports, 'reports').map((value) => {
      const item = object(value);
      return { title: text(item.title, 'title'), content: text(item.content, 'content') };
    });
    const now = catalogNow();
    const job = { kind: 'commerce.catalog.review-reported', key: crypto.randomUUID() };
    await atomic(c.env, [
      ...reports.map(
        (report) =>
          sql`insert into ${schema.shop_review_reports} (review_id,user_id,title,content,status,created_at,updated_at) values (${found.id},${user.id},${report.title},${report.content},'UNHANDLED',${now},${now})`,
      ),
      outbox(job.kind, { shop: reported.name }, Date.now(), job.key),
    ]);
    signalCatalogJobs(c, [job]);
    return c.body(null, 204);
  });
}
