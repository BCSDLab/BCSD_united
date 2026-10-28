import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Hono } from 'hono';
import type { ApiEnv } from '@api/runtime';
import { requirePrincipal } from '@api/auth';
import { executeAtomic } from '@api/db/client';
import { ApiError } from '@api/errors';
import { first, integer, pageResult, paging, rows } from '@api/domains/community/store';
import { replaceTitleIndex } from '@api/domains/community/search';
import { enqueueArticleAiSummary } from '@api/domains/community/summary';

const noticeBody = z.object({title: z.string().min(1).max(255), content: z.string()});
interface Notice { id: number; title: string; author: string; content: string | null; created_at: string; updated_at: string }
const projection = sql`a.id,a.title,a.content,COALESCE(u.name,'BCSD Lab') author,strftime('%Y-%m-%d %H:%M:%S',a.created_at,'+9 hours') created_at,strftime('%Y-%m-%d %H:%M:%S',a.updated_at,'+9 hours') updated_at`;
const noticeFrom = sql`FROM new_articles a LEFT JOIN koin_notice n ON n.article_id=a.id LEFT JOIN users u ON u.id=n.admin_id`;
export function registerCommunityNotices(app: Hono<ApiEnv>) {
  app.get('/admin/notice', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const deleted = z.enum(['true', 'false']).parse(c.req.query('is_deleted') ?? 'false') === 'true';
    const db = c.get('db');
    const total = (await first<{total: number}>(db, sql`SELECT count(*) total FROM new_articles WHERE board_id=9 AND is_deleted=${deleted ? 1 : 0}`))!.total;
    const p = paging(c, total);
    const notices = await rows<Notice>(db, sql`SELECT ${projection} ${noticeFrom} WHERE a.board_id=9 AND a.is_deleted=${deleted ? 1 : 0} ORDER BY a.id DESC LIMIT ${p.limit} OFFSET ${p.offset}`);
    const {articles: _articles, ...page} = pageResult(notices, total, p.page, p.limit);
    return c.json({...page, notices: notices.map(({content: _content, ...notice}) => notice)});
  });
  app.get('/admin/notice/:id', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const notice = await first<Notice>(c.get('db'), sql`SELECT ${projection} ${noticeFrom} WHERE a.id=${integer(c.req.param('id'))}`);
    if (!notice) throw new ApiError(404, '', '게시글이 존재하지 않습니다.');
    return c.json(notice);
  });
  app.post('/admin/notice', async (c) => {
    const admin = requirePrincipal(c, ['ADMIN']);
    const body = noticeBody.parse(await c.req.json());
    const db = c.get('db');
    if (!await first(db, sql`SELECT id FROM boards WHERE id=9 AND is_deleted=0`)) throw new ApiError(404, '', '게시판이 존재하지 않습니다.');
    const result = await executeAtomic(db, [
      sql`INSERT INTO new_articles(board_id,title,content,hit,is_notice,is_deleted) VALUES(9,${body.title},${body.content},0,1,0) RETURNING id`,
      sql`INSERT INTO koin_notice(article_id,admin_id,is_deleted) VALUES(last_insert_rowid(),${admin.id},0)`,
      ...replaceTitleIndex(sql`(SELECT max(id) FROM new_articles)`, body.title),
    ]);
    await enqueueArticleAiSummary(c.env, Number(result[0]!.results[0]!.id), body.content);
    return c.body(null, 201);
  });
  app.put('/admin/notice/:id', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const body = noticeBody.parse(await c.req.json());
    const id = integer(c.req.param('id'));
    const result = await executeAtomic(c.get('db'), [
      sql`UPDATE new_articles SET title=${body.title},content=${body.content},updated_at=CURRENT_TIMESTAMP WHERE id=${id}`,
      ...replaceTitleIndex(sql`(SELECT id FROM new_articles WHERE id=${id})`, body.title),
    ]);
    if (!result[0]!.meta.changes) throw new ApiError(404, '', '게시글이 존재하지 않습니다.');
    await enqueueArticleAiSummary(c.env, id, body.content);
    return c.body(null, 200);
  });
  app.delete('/admin/notice/:id', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const id = integer(c.req.param('id'));
    await executeAtomic(c.get('db'), [
      sql`UPDATE new_articles SET is_deleted=1,updated_at=CURRENT_TIMESTAMP WHERE id=${id} AND is_deleted=0`,
      sql`UPDATE koin_notice SET is_deleted=1,updated_at=CURRENT_TIMESTAMP WHERE article_id=${id}`,
      sql`UPDATE new_koin_articles SET is_deleted=1,updated_at=CURRENT_TIMESTAMP WHERE article_id=${id}`,
      sql`UPDATE new_koreatech_articles SET is_deleted=1,updated_at=CURRENT_TIMESTAMP WHERE article_id=${id}`,
      sql`UPDATE lost_item_articles SET is_deleted=1,updated_at=CURRENT_TIMESTAMP WHERE article_id=${id}`,
      sql`UPDATE lost_item_images SET is_deleted=1,updated_at=CURRENT_TIMESTAMP WHERE lost_item_id IN(SELECT id FROM lost_item_articles WHERE article_id=${id})`,
    ]);
    return c.body(null, 204);
  });
}
