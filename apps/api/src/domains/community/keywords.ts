import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Context, Hono } from 'hono';
import type { ApiEnv } from '@api/runtime';
import { ApiError } from '@api/errors';
import { requirePrincipal } from '@api/auth';
import { executeAtomic } from '@api/db/client';
import { enumValue, first, integer, rows, signalOutbox } from '@api/domains/community/store';

export type KeywordCategory = 'KOREATECH' | 'LOST_ITEM';
function category(c: Context<ApiEnv>): KeywordCategory {
  return enumValue(c.req.query('type'), ['KOREATECH', 'LOST_ITEM'], 'KOREATECH');
}
export function normalizeKeyword(keyword: string): string {
  if (keyword.includes(' ') || keyword.includes('\n'))
    throw new ApiError(400, '', '키워드에 공백을 포함할 수 없습니다.');
  return keyword.trim().toLowerCase();
}
export function keywordNotifications(
  articleId: number | SQL,
  type: KeywordCategory,
  authorId: number | null = null,
): SQL {
  const lost = type === 'LOST_ITEM';
  return sql`INSERT INTO native_community_outbox(id,kind,payload,created_at)
    SELECT ${crypto.randomUUID()} || ':' || user_id,'community.push',
      json_object('userId',user_id,'title',title,'message','방금 등록된 ' || keyword || ${lost ? ' 분실물 게시물을 확인해보세요!' : ' 공지를 확인해보세요!'},
        'mobileAppPath',${lost ? 'LOST_ITEM' : 'KEYWORD'},'schemeUri',${lost ? 'lost-item?id=' : 'keyword?id='} || article_id || '&keyword=' || keyword || ${lost ? '' : '&board-id='} || ${lost ? sql`''` : sql`board_id`},'type','MESSAGE'),${Date.now()}
    FROM (SELECT m.user_id,k.keyword,a.title,a.id article_id,a.board_id,
      row_number() OVER(PARTITION BY m.user_id ORDER BY length(k.keyword) DESC,m.id ASC) ranking
      FROM new_articles a JOIN article_keywords k ON k.category=${type} AND instr(a.title,k.keyword)>0 AND k.is_deleted=0
      JOIN article_keyword_user_map m ON m.keyword_id=k.id AND m.is_deleted=0
      JOIN users u ON u.id=m.user_id AND u.is_deleted=0 AND u.device_token IS NOT NULL
      WHERE a.id=${articleId} AND a.is_deleted=0 AND (${authorId} IS NULL OR m.user_id<>${authorId})
      AND EXISTS(SELECT 1 FROM notification_subscribe n WHERE n.user_id=u.id AND n.subscribe_type=${lost ? 'LOST_ITEM_KEYWORD' : 'ARTICLE_KEYWORD'} AND n.detail_type IS NULL)) WHERE ranking=1 RETURNING id,kind`;
}
export function registerCommunityKeywords(app: Hono<ApiEnv>) {
  app.post('/articles/keyword', async (c) => {
    const user = requirePrincipal(c, ['STUDENT', 'COUNCIL']);
    const input = z
      .object({
        keyword: z
          .string()
          .min(2)
          .max(20)
          .refine((value) => value.trim().length > 0),
      })
      .parse(await c.req.json());
    const keyword = normalizeKeyword(input.keyword);
    const type = category(c);
    const db = c.get('db');
    const allowed = sql`(SELECT count(*) FROM article_keyword_user_map m JOIN article_keywords k ON k.id=m.keyword_id WHERE m.user_id=${user.id} AND m.is_deleted=0 AND k.is_deleted=0 AND k.category=${type})<10`;
    const notDuplicate = sql`NOT EXISTS(SELECT 1 FROM article_keyword_user_map m JOIN article_keywords k ON k.id=m.keyword_id WHERE m.user_id=${user.id} AND m.is_deleted=0 AND k.keyword=${keyword} AND k.category=${type})`;
    const results = await executeAtomic(db, [
      sql`INSERT INTO article_keywords(keyword,category,last_used_at,is_deleted,is_filtered) SELECT ${keyword},${type},CURRENT_TIMESTAMP,0,0 WHERE ${allowed} AND ${notDuplicate} ON CONFLICT(keyword,category) DO UPDATE SET is_deleted=0,last_used_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE ${allowed} AND ${notDuplicate}`,
      sql`INSERT INTO article_keyword_user_map(keyword_id,user_id,is_deleted) SELECT id,${user.id},0 FROM article_keywords WHERE keyword=${keyword} AND category=${type} AND ${allowed} ON CONFLICT(keyword_id,user_id) DO UPDATE SET is_deleted=0,updated_at=CURRENT_TIMESTAMP WHERE article_keyword_user_map.is_deleted=1 AND ${allowed} RETURNING id`,
    ]);
    const result = results[1]!.results[0] as { id: number } | undefined;
    if (!result) {
      const count = await first<{ total: number }>(
        db,
        sql`SELECT count(*) total FROM article_keyword_user_map m JOIN article_keywords k ON k.id=m.keyword_id WHERE m.user_id=${user.id} AND m.is_deleted=0 AND k.is_deleted=0 AND k.category=${type}`,
      );
      if ((count?.total ?? 0) >= 10) throw new ApiError(400, '', '저장할 수 있는 최대 키워드 수를 초과 했습니다.');
      throw new ApiError(409, '', '해당 키워드는 이미 등록되었습니다.');
    }
    return c.json({ id: result.id, keyword });
  });
  app.delete('/articles/keyword/:id', async (c) => {
    const user = requirePrincipal(c, ['STUDENT', 'COUNCIL']);
    const db = c.get('db');
    const id = integer(c.req.param('id'));
    const mapping = await first<{ user_id: number; keyword_id: number }>(
      db,
      sql`SELECT user_id,keyword_id FROM article_keyword_user_map WHERE id=${id} AND is_deleted=0`,
    );
    if (!mapping) throw new ApiError(404, '', '존재하지 않는 키워드 입니다.');
    if (mapping.user_id !== user.id) throw new ApiError(403, '', '접근 권한이 없습니다.');
    await executeAtomic(db, [
      sql`UPDATE article_keyword_user_map SET is_deleted=1,updated_at=CURRENT_TIMESTAMP WHERE id=${id} AND user_id=${user.id}`,
      sql`UPDATE article_keywords SET is_deleted=1,updated_at=CURRENT_TIMESTAMP WHERE id=${mapping.keyword_id} AND NOT EXISTS(SELECT 1 FROM article_keyword_user_map WHERE keyword_id=${mapping.keyword_id} AND is_deleted=0)`,
    ]);
    return c.body(null, 204);
  });
  app.get('/articles/keyword/me', async (c) => {
    const user = requirePrincipal(c, ['GENERAL', 'STUDENT', 'COUNCIL']);
    const values = await rows<{ id: number; keyword: string }>(
      c.get('db'),
      sql`SELECT m.id,k.keyword FROM article_keyword_user_map m JOIN article_keywords k ON k.id=m.keyword_id WHERE m.user_id=${user.id} AND m.is_deleted=0 AND k.is_deleted=0 AND k.category=${category(c)} ORDER BY m.id`,
    );
    return c.json({ count: values.length, keywords: values });
  });
  app.get('/articles/keyword/suggestions', async (c) => {
    const values = await rows<{ keyword: string }>(
      c.get('db'),
      sql`SELECT keyword FROM native_article_keyword_suggestion WHERE category=${category(c)} ORDER BY count DESC,keyword_id ASC LIMIT 15`,
    );
    return c.json({ keywords: values.map((entry) => entry.keyword) });
  });
  app.post('/articles/keyword/notification', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const body = z.object({ update_notification: z.array(z.number().int()) }).parse(await c.req.json());
    const statements = [...new Set(body.update_notification)].map((articleId) =>
      keywordNotifications(articleId, 'KOREATECH'),
    );
    if (statements.length) {
      const result = await executeAtomic(c.get('db'), statements);
      c.executionCtx.waitUntil(signalOutbox(c.env, result));
    }
    return c.body(null, 200);
  });
  app.post('/admin/articles/keyword/filter', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const body = z.object({ keyword: z.string().min(1), is_filtered: z.boolean() }).parse(await c.req.json());
    const type = category(c);
    const db = c.get('db');
    const keyword = await first<{ id: number; is_filtered: number }>(
      db,
      sql`SELECT id,is_filtered FROM article_keywords WHERE keyword=${body.keyword} AND category=${type} AND is_deleted=0`,
    );
    if (!keyword) throw new ApiError(404, '', '존재하지 않는 키워드 단어 입니다.');
    if (Boolean(keyword.is_filtered) === body.is_filtered)
      throw new ApiError(
        400,
        '',
        `이미 ${body.is_filtered ? '필터링 된' : '필터링이 취소된'} 키워드입니다: ${body.keyword}, category: ${type}`,
      );
    await db.run(
      sql`UPDATE article_keywords SET is_filtered=${body.is_filtered ? 1 : 0},updated_at=CURRENT_TIMESTAMP WHERE id=${keyword.id}`,
    );
    return c.body(null, 200);
  });
  app.get('/admin/articles/keyword/filtered', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const keywords = await rows<{ keyword: string }>(
      c.get('db'),
      sql`SELECT keyword FROM article_keywords WHERE is_filtered=1 AND is_deleted=0 AND category=${category(c)} ORDER BY id`,
    );
    return c.json({ keywords });
  });
}
