import { sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { schema } from '@api/db/schema';
import type { ApiEnv } from '@api/runtime';
import {
  body,
  catalogDate,
  catalogError,
  catalogNow,
  integer,
  invalid,
  rows,
  sqlList,
  type CatalogContext,
} from '@api/domains/commerce/catalog-shared';
import {
  adminPagination,
  adminQueryBoolean,
  catalogAdminAudit,
  catalogAdminWrite,
} from '@api/domains/commerce/catalog-admin';

type ReviewRow = typeof schema.shop_reviews.$inferSelect & {
  nickname: string | null;
  anonymous_nickname: string;
  shop_name: string;
};
type ReportRow = typeof schema.shop_review_reports.$inferSelect & { nickname: string | null };

const REPORT_STATUSES = ['UNHANDLED', 'DISMISSED', 'DELETED'];

async function requireReview(c: CatalogContext, id: number): Promise<void> {
  if (!(await rows(c, sql`select id from ${schema.shop_reviews} where id=${id}`)).length) {
    catalogError(404, '', `리뷰가 존재하지 않습니다. 해당 리뷰를 찾을 수 없습니다.: ${id}`);
  }
}

export function registerCommerceCatalogAdminReviews(app: Hono<ApiEnv>): void {
  app.get('/admin/shops/reviews', async (c) => {
    const shopId = c.req.query('shop_id');
    const reported = adminQueryBoolean(c, 'is_reported');
    const unhandled = adminQueryBoolean(c, 'has_unhandled_report');
    const hasReport = sql`exists(select 1 from ${schema.shop_review_reports} p where p.review_id=r.id)`;
    const where = sql.join(
      [
        sql`r.is_deleted=0`,
        ...(shopId === undefined ? [] : [sql`r.shop_id=${integer(shopId, 'shop_id')}`]),
        ...(reported === undefined ? [] : [reported ? hasReport : sql`not ${hasReport}`]),
        ...(unhandled
          ? [sql`exists(select 1 from ${schema.shop_review_reports} p where p.review_id=r.id and p.status='UNHANDLED')`]
          : []),
      ],
      sql` and `,
    );
    const [{ total }] = await rows<{ total: number }>(
      c,
      sql`select count(*) total from ${schema.shop_reviews} r where ${where}`,
    );
    const page = adminPagination(c, total);
    const reviews = await rows<ReviewRow>(
      c,
      sql`select r.*,u.nickname,u.anonymous_nickname,s.name shop_name from ${schema.shop_reviews} r join ${schema.users} u on u.id=r.reviewer_id join ${schema.shops} s on s.id=r.shop_id where ${where} order by r.id limit ${page.limit} offset ${page.offset}`,
    );
    const reviewIds = reviews.map((review) => review.id);
    const [images, menus, reports] = reviewIds.length
      ? await Promise.all([
          rows<{ review_id: number; image_urls: string }>(
            c,
            sql`select review_id,image_urls from ${schema.shop_review_images} where review_id in (${sqlList(reviewIds)}) order by id`,
          ),
          rows<{ review_id: number; menu_name: string }>(
            c,
            sql`select review_id,menu_name from ${schema.shop_review_menus} where review_id in (${sqlList(reviewIds)}) order by id`,
          ),
          rows<ReportRow>(
            c,
            sql`select p.*,u.nickname from ${schema.shop_review_reports} p join ${schema.users} u on u.id=p.user_id where p.review_id in (${sqlList(reviewIds)}) order by p.id`,
          ),
        ])
      : [[], [], []];
    return c.json({
      total_count: total,
      current_count: reviews.length,
      // 관리자 리뷰 목록만 0부터 시작하는 페이지 번호를 쓴다.
      current_page: page.current_page - 1,
      reviews: reviews.map((review) => {
        const reviewReports = reports.filter((report) => report.review_id === review.id);
        return {
          reviewId: review.id,
          rating: review.rating,
          nickName: review.nickname ?? review.anonymous_nickname,
          content: review.content,
          imageUrls: images.filter((image) => image.review_id === review.id).map((image) => image.image_urls),
          menuNames: menus.filter((menu) => menu.review_id === review.id).map((menu) => menu.menu_name),
          isModified: review.created_at !== review.updated_at,
          isHaveUnhandledReport: reviewReports.some((report) => report.status === 'UNHANDLED'),
          createdAt: review.created_at === null ? null : catalogDate(review.created_at),
          reports: reviewReports.map((report) => ({
            reportId: report.id,
            title: report.title,
            content: report.content,
            nickName: report.nickname,
            status: report.status,
          })),
          shop: { shopId: review.shop_id, shopName: review.shop_name },
        };
      }),
    });
  });
  app.put('/admin/shops/reviews/:id', async (c) => {
    const id = integer(c.req.param('id'));
    const request = await body(c);
    if (!REPORT_STATUSES.includes(String(request.report_status)))
      invalid('report_status', '변경하려는 상태는 필수입니다.');
    await requireReview(c, id);
    await catalogAdminWrite(c, [
      sql`update ${schema.shop_review_reports} set status=${request.report_status as string},updated_at=${catalogNow()} where review_id=${id} and status='UNHANDLED'`,
      catalogAdminAudit(c, 'REVIEWS', id, request),
    ]);
    return c.body(null, 200);
  });
  app.delete('/admin/shops/reviews/:id', async (c) => {
    const id = integer(c.req.param('id'));
    await requireReview(c, id);
    const now = catalogNow();
    await catalogAdminWrite(c, [
      sql`update ${schema.shop_review_reports} set status='DELETED',updated_at=${now} where review_id=${id}`,
      sql`update ${schema.shop_reviews} set is_deleted=1,updated_at=${now} where id=${id}`,
      catalogAdminAudit(c, 'REVIEWS', id),
    ]);
    return c.body(null, 204);
  });
}
