import { sql, type SQL } from 'drizzle-orm';
import { createDatabase, executeAtomic, type Database } from '@api/db/client';
import type { Bindings } from '@api/runtime';
import type { Job } from '@api/jobs';
import { ApiError } from '@api/errors';
import { sendSlack } from '@api/integrations';
import { deliverNotification, type NotificationDelivery } from '@api/domains/misc/notifications';
import { first, rows } from '@api/domains/community/store';

interface CommunityOutbox {
  id: string;
  kind: string;
  payload: string;
  lease_until: number | null;
  attempts: number;
}
export async function handleCommunityOutboxJob(env: Bindings, job: Job): Promise<boolean> {
  if (!['community.push', 'community.lost-report'].includes(job.kind)) return false;
  const db = createDatabase(env.DB);
  const now = Date.now();
  const lease = now + 120000;
  const claimed = await rows<CommunityOutbox>(
    db,
    sql`UPDATE native_community_outbox SET lease_until=${lease},attempts=attempts+1 WHERE id=${job.key} AND kind=${job.kind} AND delivered_at IS NULL AND (lease_until IS NULL OR lease_until<=${now}) RETURNING *`,
  );
  const event = claimed[0];
  if (!event) {
    if (await first(db, sql`SELECT id FROM native_community_outbox WHERE id=${job.key} AND delivered_at IS NULL`))
      throw new ApiError(409, 'OUTBOX_LEASE_BUSY', '알림 전송을 재시도합니다.');
    return true;
  }
  try {
    if (event.kind === 'community.push') {
      const delivery = JSON.parse(event.payload) as NotificationDelivery;
      const live = await first<{ device_token: string | null }>(
        db,
        sql`SELECT device_token FROM users WHERE id=${delivery.userId} AND is_deleted=0`,
      );
      if (live?.device_token !== null && live !== undefined) await deliverNotification(env, delivery);
    } else {
      if (!env.SLACK_LOST_ITEM_WEBHOOK || !env.ADMIN_SHOP_URL)
        throw new ApiError(503, 'INTEGRATION_CONFIGURATION_ERROR', '분실물 신고 Slack 설정이 없습니다.');
      const payload = JSON.parse(event.payload) as { articleId: number };
      await sendSlack(env, {
        webhook: env.SLACK_LOST_ITEM_WEBHOOK,
        message: `\`${payload.articleId}번 분실물 게시글이 신고되었습니다.\`\n\`신고를 처리해주세요!!\`\n<${env.ADMIN_SHOP_URL}|Admin page 바로가기>\n`,
      });
    }
    await db.run(
      sql`UPDATE native_community_outbox SET delivered_at=${Date.now()},lease_until=NULL WHERE id=${event.id} AND lease_until=${lease}`,
    );
  } catch (error) {
    await db.run(
      sql`UPDATE native_community_outbox SET lease_until=${Date.now() + Math.min(3600000, 1000 * 2 ** Math.min(event.attempts, 12))} WHERE id=${event.id} AND lease_until=${lease}`,
    );
    throw error;
  }
  return true;
}
function due(name: string, period: number): SQL {
  return sql`NOT EXISTS(SELECT 1 FROM native_community_schedule WHERE name=${name} AND scheduled_at>=${period})`;
}
function mark(name: string, period: number): SQL {
  return sql`INSERT INTO native_community_schedule(name,scheduled_at) VALUES(${name},${period}) ON CONFLICT(name) DO UPDATE SET scheduled_at=max(scheduled_at,excluded.scheduled_at)`;
}
async function refreshHourly(db: Database, time: number) {
  const period = Math.floor(time / 3600000) * 3600000;
  const guard = due('hourly', period);
  const writes: SQL[] = [sql`DELETE FROM native_article_keyword_suggestion WHERE ${guard}`];
  for (const category of ['KOREATECH', 'LOST_ITEM'] as const) {
    const recent = sql`SELECT k.id keyword_id,k.keyword,k.category,count(m.id) count FROM article_keywords k JOIN article_keyword_user_map m ON m.keyword_id=k.id AND m.is_deleted=0 WHERE k.is_deleted=0 AND k.is_filtered=0 AND k.category=${category} AND k.last_used_at>=datetime('now','-7 days') GROUP BY k.id ORDER BY count(m.id) DESC LIMIT 15`;
    writes.push(
      sql`INSERT INTO native_article_keyword_suggestion(keyword_id,keyword,category,count) SELECT keyword_id,keyword,category,count FROM (${recent}) WHERE ${guard} AND (SELECT count(*) FROM (${recent}))>=15`,
    );
    writes.push(
      sql`INSERT INTO native_article_keyword_suggestion(keyword_id,keyword,category,count) SELECT k.id,k.keyword,k.category,count(m.id) FROM article_keywords k LEFT JOIN article_keyword_user_map m ON m.keyword_id=k.id AND m.is_deleted=0 WHERE k.is_deleted=0 AND k.is_filtered=0 AND k.category=${category} AND ${guard} AND (SELECT count(*) FROM (${recent}))<15 GROUP BY k.id ORDER BY k.created_at DESC LIMIT 15`,
    );
  }
  writes.push(
    sql`INSERT INTO native_transport_cache(id,payload,expires_at,updated_at) SELECT 'busNoticeArticle',json_object('id',id,'title',title),NULL,${time} FROM (SELECT id,title,created_at FROM new_articles WHERE is_deleted=0 AND is_notice=1 AND (title LIKE '%통학버스%' OR title LIKE '%등교버스%' OR title LIKE '%셔틀버스%' OR title LIKE '%하교버스%') ORDER BY created_at DESC LIMIT 5) WHERE ${guard} AND date(created_at)=date((SELECT max(created_at) FROM new_articles WHERE is_deleted=0 AND is_notice=1 AND (title LIKE '%통학버스%' OR title LIKE '%등교버스%' OR title LIKE '%셔틀버스%' OR title LIKE '%하교버스%'))) ORDER BY (instr(title,'사과')>0)-(instr(title,'긴급')>0),created_at DESC LIMIT 1 ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at,expires_at=NULL`,
  );
  writes.push(mark('hourly', period));
  await executeAtomic(db, writes);
}
async function refreshHotArticles(db: Database, time: number) {
  const period = Math.floor((time + 3 * 3600000) / 86400000) * 86400000 - 3 * 3600000;
  const guard = due('hot-articles', period);
  const recent = sql`a.is_deleted=0 AND a.board_id<>14 AND COALESCE(k.registered_at,datetime(a.created_at,'+9 hours'))>datetime(${new Date(time).toISOString()},'+9 hours','start of day','-30 days')`;
  await executeAtomic(db, [
    sql`DELETE FROM native_hot_article WHERE ${guard}`,
    sql`INSERT INTO native_hot_article(article_id,score) SELECT a.id,a.hit+COALESCE(k.portal_hit,0)-COALESCE(s.hit,0) score FROM new_articles a LEFT JOIN new_koreatech_articles k ON k.article_id=a.id AND k.is_deleted=0 LEFT JOIN native_article_hit_snapshot s ON s.article_id=a.id WHERE ${recent} AND ${guard} AND a.hit+COALESCE(k.portal_hit,0)-COALESCE(s.hit,0)>0 ORDER BY score DESC LIMIT 10`,
    sql`DELETE FROM native_article_hit_snapshot WHERE ${guard}`,
    sql`INSERT INTO native_article_hit_snapshot(article_id,hit) SELECT a.id,a.hit+COALESCE(k.portal_hit,0) FROM new_articles a LEFT JOIN new_koreatech_articles k ON k.article_id=a.id AND k.is_deleted=0 WHERE ${recent} AND ${guard}`,
    mark('hot-articles', period),
  ]);
}
async function syncSearchCounts(db: Database, time: number) {
  const period = Math.floor((time + 9 * 3600000) / (6 * 3600000)) * (6 * 3600000) - 9 * 3600000;
  const guard = due('search-counts', period);
  await executeAtomic(db, [
    sql`UPDATE article_search_keywords SET weight=1.0,updated_at=CURRENT_TIMESTAMP WHERE updated_at BETWEEN datetime('now','-390 minutes') AND CURRENT_TIMESTAMP AND ${guard}`,
    sql`UPDATE article_search_keyword_ip_map SET search_count=0,updated_at=CURRENT_TIMESTAMP WHERE updated_at BETWEEN datetime('now','-390 minutes') AND CURRENT_TIMESTAMP AND ${guard}`,
    sql`INSERT INTO article_search_keyword_ip_map(keyword_id,ip_address,search_count) SELECT k.id,c.public_ip,c.count FROM native_article_search_count c JOIN article_search_keywords k ON k.keyword=c.keyword WHERE c.count>0 AND ${guard} ON CONFLICT(keyword_id,ip_address) DO UPDATE SET search_count=search_count+excluded.search_count,updated_at=CURRENT_TIMESTAMP`,
    sql`DELETE FROM native_article_search_count WHERE ${guard}`,
    sql`DELETE FROM native_popular_keyword WHERE ${guard}`,
    mark('search-counts', period),
  ]);
}
export async function runCommunityMaintenanceCron(env: Bindings, scheduledTime: number) {
  const clock = new Date(scheduledTime + 9 * 3600000);
  const minute = clock.getUTCMinutes();
  if (minute % 5 !== 0) return;
  const db = createDatabase(env.DB);
  if (minute === 0) {
    await refreshHourly(db, scheduledTime);
    if (clock.getUTCHours() === 6) await refreshHotArticles(db, scheduledTime);
    if (clock.getUTCHours() % 6 === 0) await syncSearchCounts(db, scheduledTime);
    await db.run(sql`DELETE FROM native_article_hit_user WHERE expires_at<=${scheduledTime}`);
  }
  const pending = await rows<CommunityOutbox>(
    db,
    sql`SELECT * FROM native_community_outbox WHERE delivered_at IS NULL AND (lease_until IS NULL OR lease_until<=${scheduledTime}) ORDER BY created_at,id LIMIT 100`,
  );
  if (pending.length)
    await env.JOBS.sendBatch(pending.map((event) => ({ body: { kind: event.kind, key: event.id, payload: {} } })));
}
