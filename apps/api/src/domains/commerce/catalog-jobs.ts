import { sql } from 'drizzle-orm';
import { createDatabase, executeAtomic, type Database } from '@api/db/client';
import { schema } from '@api/db/schema';
import { ApiError } from '@api/errors';
import { sendSlack } from '@api/integrations';
import type { Job } from '@api/jobs';
import type { Bindings } from '@api/runtime';
import { deliverNotification } from '@api/domains/misc/notifications';
import { integer, object, text, type JsonObject } from '@api/domains/commerce/catalog-shared';

type CatalogJob = typeof schema.native_catalog_outbox.$inferSelect;

const LEASE_MS = 120000;
const CRON_INTERVAL_MINUTES = 5;
const CRON_BATCH = 100;

async function deliverReviewPrompt(env: Bindings, db: Database, payload: JsonObject): Promise<void> {
  const shopId = integer(payload.shopId);
  const userId = integer(payload.userId);
  // 알림 문구는 상점의 첫 카테고리('전체보기' 제외)가 속한 상위 카테고리의 메시지를 쓴다.
  const [message] = await db.all<{ name: string; title: string; content: string }>(
    sql`select s.name,n.title,n.content from ${schema.shops} s join ${schema.shop_category_map} cm on cm.shop_id=s.id join ${schema.shop_categories} c on c.id=cm.shop_category_id join ${schema.shop_parent_categories} p on p.id=c.parent_category_id join ${schema.shop_notification_messages} n on n.id=p.notification_message_id where s.id=${shopId} and s.is_deleted=0 and c.id=(select min(c2.id) from ${schema.shop_category_map} cm2 join ${schema.shop_categories} c2 on c2.id=cm2.shop_category_id where cm2.shop_id=s.id and c2.name<>'전체보기')`,
  );
  if (!message) throw new ApiError(404, '', `알림 메시지가 존재하지 않습니다. shopId: ${shopId}`);
  await deliverNotification(env, {
    userId,
    title: `${message.name}${message.title}`,
    message: message.content,
    mobileAppPath: 'SHOP',
    schemeUri: `shop?id=${shopId}`,
    type: 'MESSAGE',
  });
}

async function deliverShopEvent(env: Bindings, payload: JsonObject): Promise<void> {
  const shopId = integer(payload.shopId);
  const userId = integer(payload.userId);
  await deliverNotification(env, {
    userId,
    title: `${text(payload.shopName, 'shopName')}의 이벤트가 추가되었어요 \uD83C\uDF89`,
    message: text(payload.title, 'title'),
    imageUrl: payload.imageUrl == null ? null : text(payload.imageUrl, 'imageUrl'),
    mobileAppPath: 'SHOP',
    schemeUri: `shop?id=${shopId}`,
    type: 'MESSAGE',
  });
}

async function notifyReviewSlack(env: Bindings, kind: string, payload: JsonObject): Promise<void> {
  if (!env.SLACK_KOIN_SHOP_REVIEW_NOTIFY_URL || !env.KOIN_ADMIN_REVIEW_URL) {
    throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', '상점 리뷰 알림 설정이 필요합니다.');
  }
  const shopName = text(payload.shop, 'shop');
  const link = `<${env.KOIN_ADMIN_REVIEW_URL}|Admin page 바로가기>`;
  const message =
    kind === 'commerce.catalog.review-created'
      ? `\`${shopName}에 새로운 리뷰가 등록되었습니다.\`\n내용: \`${text(payload.content, 'content', 0)}\`\n별점: \`${integer(payload.rating, 'rating')}\`\n${link}\n`
      : `\`${shopName}의 리뷰가 신고되었습니다.\`\n\`신고를 처리해주세요!!\`\n${link}\n`;
  await sendSlack(env, { webhook: env.SLACK_KOIN_SHOP_REVIEW_NOTIFY_URL, message });
}

async function deliverCatalogJob(env: Bindings, db: Database, record: CatalogJob): Promise<void> {
  const payload = object(JSON.parse(record.payload));
  switch (record.kind) {
    case 'commerce.catalog.review-prompt':
      return deliverReviewPrompt(env, db, payload);
    case 'commerce.catalog.shop-event':
      return deliverShopEvent(env, payload);
    case 'commerce.catalog.review-created':
    case 'commerce.catalog.review-reported':
      return notifyReviewSlack(env, record.kind, payload);
    default:
      throw new ApiError(500, 'UNKNOWN_CATALOG_JOB', `알 수 없는 상점 작업입니다: ${record.kind}`);
  }
}

/**
 * 아웃박스 행을 `due_at`을 임대 시각으로 밀어 선점한 뒤 전달한다. 실패하면 `due_at`을 지금으로 되돌려
 * 크론이 다시 집어 가게 하고, 성공하면 `delivered_at`을 기록한다. 두 갱신 모두 `due_at`이 아직 우리
 * 임대값일 때만 적용되므로 임대가 만료돼 다른 워커가 가져간 행은 건드리지 않는다.
 */
export async function handleCommerceCatalogJob(env: Bindings, job: Job): Promise<boolean> {
  if (!job.kind.startsWith('commerce.catalog.')) return false;
  const db = createDatabase(env.DB);
  const now = Date.now();
  const lease = now + LEASE_MS;
  const [claimed] = await executeAtomic(db, [
    sql`update ${schema.native_catalog_outbox} set due_at=${lease} where id=${job.key} and kind=${job.kind} and delivered_at is null and due_at<=${now} returning *`,
  ]);
  const record = claimed?.results[0] as unknown as CatalogJob | undefined;
  if (!record) return true;
  try {
    await deliverCatalogJob(env, db, record);
    await db.run(
      sql`update ${schema.native_catalog_outbox} set delivered_at=${Date.now()} where id=${record.id} and due_at=${lease} and delivered_at is null`,
    );
  } catch (error) {
    await db.run(
      sql`update ${schema.native_catalog_outbox} set due_at=${Date.now()} where id=${record.id} and due_at=${lease} and delivered_at is null`,
    );
    throw error;
  }
  return true;
}

export async function runCommerceCatalogCron(env: Bindings, scheduledTime: number): Promise<void> {
  if (Math.floor(scheduledTime / 60000) % CRON_INTERVAL_MINUTES !== 0) return;
  const db = createDatabase(env.DB);
  await db.run(sql`delete from ${schema.native_catalog_request_guard} where expires_at<=${scheduledTime}`);
  const due = await db.all<{ id: string; kind: string }>(
    sql`select id,kind from ${schema.native_catalog_outbox} where delivered_at is null and due_at<=${scheduledTime} order by due_at limit ${CRON_BATCH}`,
  );
  if (due.length) await env.JOBS.sendBatch(due.map((row) => ({ body: { kind: row.kind, key: row.id, payload: {} } })));
}
