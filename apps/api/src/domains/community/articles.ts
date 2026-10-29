import { sql, type SQL } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { executeAtomic, type Database } from '@api/db/client';
import type { ApiEnv } from '@api/runtime';
import { ApiError } from '@api/errors';
import { readArticleContent } from '@api/integrations';
import { getArticleAiSummary, prependArticleAiSummary } from '@api/domains/community/summary';
import { first, integer, kstDate, pageResult, paging, rows } from '@api/domains/community/store';
import { searchWeightExpression, titleSearch } from '@api/domains/community/search';

export interface ArticleRow {
  id: number;
  board_id: number;
  title: string;
  content: string | null;
  hit: number;
  is_notice: number;
  created_at: string;
  updated_at: string;
  publication: string;
  registered_at: string | null;
  portal_hit: number | null;
  url: string | null;
  author: string;
  board_notice: number;
  lost_id: number | null;
  author_id: number | null;
  type: string | null;
  category: string | null;
  found_place: string | null;
  found_date: string | null;
  is_found: number | null;
  is_council: number | null;
}
export const articleFrom = sql`FROM new_articles a JOIN boards b ON b.id=a.board_id AND b.is_deleted=0
 LEFT JOIN new_koreatech_articles k ON k.article_id=a.id AND k.is_deleted=0
 LEFT JOIN new_koin_articles ka ON ka.article_id=a.id AND ka.is_deleted=0 LEFT JOIN users ku ON ku.id=ka.user_id AND ku.is_deleted=0
 LEFT JOIN lost_item_articles l ON l.article_id=a.id AND l.is_deleted=0 LEFT JOIN users u ON u.id=l.author_id AND u.is_deleted=0`;
export const articleColumns = sql`a.*,COALESCE(k.registered_at,datetime(a.created_at,'+9 hours')) publication,k.registered_at,k.portal_hit,k.url,b.is_notice board_notice,
 CASE WHEN a.board_id=9 THEN 'BCSD Lab' WHEN ka.id IS NOT NULL THEN COALESCE(ku.name,'탈퇴한 사용자') WHEN k.id IS NOT NULL THEN COALESCE(k.author,'탈퇴한 사용자') WHEN u.id IS NOT NULL THEN COALESCE(u.nickname,'익명') ELSE '탈퇴한 사용자' END author,
 l.id lost_id,l.author_id,l.type,l.category,l.found_place,l.found_date,l.is_found,l.is_council`;
export const activeArticle = sql`a.is_deleted=0`;
export function boardFilter(board?: number): SQL {
  return board === undefined ? sql`a.board_id<>14` : board === 4 ? sql`a.is_notice=1` : sql`a.board_id=${board}`;
}
export async function articleById(db: Database, id: number): Promise<ArticleRow> {
  const article = await first<ArticleRow>(
    db,
    sql`SELECT ${articleColumns} ${articleFrom} WHERE a.id=${id} AND a.is_deleted=0`,
  );
  if (!article) throw new ApiError(404, '', '게시글이 존재하지 않습니다.');
  return article;
}
export function articleDates(article: ArticleRow) {
  return {
    registered_at: article.registered_at ? article.registered_at.slice(0, 10) : kstDate(article.created_at),
    updated_at: new Date(Date.parse(`${article.updated_at.replace(' ', 'T').replace(/Z$/, '')}Z`) + 9 * 3600000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19),
  };
}
export function articleSummary(article: ArticleRow) {
  return {
    id: article.id,
    board_id: article.board_id,
    title: article.title,
    author: article.author,
    hit: article.hit + (article.portal_hit ?? 0),
    ...articleDates(article),
  };
}
export async function reportedIds(db: Database, userId: number | undefined, ids: number[]): Promise<Set<number>> {
  if (userId === undefined || !ids.length) return new Set();
  const reports = await rows<{ article_id: number }>(
    db,
    sql`SELECT DISTINCT l.article_id FROM lost_item_reports r JOIN lost_item_articles l ON l.id=r.lost_id WHERE r.user_id=${userId} AND r.status='UNHANDLED' AND l.article_id IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`,`,
    )})`,
  );
  return new Set(reports.map((report) => report.article_id));
}
export async function neighbors(db: Database, article: ArticleRow, board?: number) {
  if (board !== undefined && board !== article.board_id && !(board === 4 && article.board_notice))
    throw new ApiError(400, '', '게시판 정보와 게시글 정보가 일치하지 않습니다.');
  const filter = boardFilter(board);
  const previous = await first<{ id: number }>(
    db,
    sql`SELECT a.id ${articleFrom} WHERE a.is_deleted=0 AND ${filter} AND (COALESCE(k.registered_at,datetime(a.created_at,'+9 hours')),a.id)<(${article.publication},${article.id}) ORDER BY COALESCE(k.registered_at,datetime(a.created_at,'+9 hours')) DESC,a.id DESC LIMIT 1`,
  );
  const next = await first<{ id: number }>(
    db,
    sql`SELECT a.id ${articleFrom} WHERE a.is_deleted=0 AND ${filter} AND (COALESCE(k.registered_at,datetime(a.created_at,'+9 hours')),a.id)>(${article.publication},${article.id}) ORDER BY COALESCE(k.registered_at,datetime(a.created_at,'+9 hours')) ASC,a.id ASC LIMIT 1`,
  );
  return { prev_id: previous?.id ?? null, next_id: next?.id ?? null };
}
export async function trackSearch(c: Context<ApiEnv>, query: string) {
  const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For')?.split(',')[0]?.trim();
  if (!ip) return;
  const writes: SQL[] = [];
  for (const keyword of query.split(/\s+/u).filter(Boolean)) {
    writes.push(
      sql`INSERT INTO native_article_search_count(public_ip,keyword,count) VALUES(${ip},${keyword},1) ON CONFLICT(public_ip,keyword) DO UPDATE SET count=count+1`,
    );
    writes.push(
      sql`INSERT INTO native_popular_keyword(keyword,weight) SELECT ${keyword},${searchWeightExpression(sql`count`)} FROM native_article_search_count WHERE public_ip=${ip} AND keyword=${keyword} ON CONFLICT(keyword) DO UPDATE SET weight=weight+excluded.weight`,
    );
  }
  if (writes.length) await executeAtomic(c.get('db'), writes);
}
async function listArticles(c: Context<ApiEnv>, search: boolean) {
  const db = c.get('db');
  const board = c.req.query('boardId') === undefined ? undefined : integer(c.req.query('boardId'));
  const query = c.req.query('query');
  if (search && query === undefined) throw new ApiError(400, 'ILLEGAL_ARGUMENT', '검색어를 입력해주세요.');
  const filter = sql`${activeArticle} AND ${boardFilter(board)}${search ? sql` AND ${titleSearch(query!)}` : sql``}`;
  const total = (await first<{ total: number }>(db, sql`SELECT count(*) total ${articleFrom} WHERE ${filter}`))!.total;
  const criteriaTotal = search
    ? undefined
    : (await first<{ total: number }>(
        db,
        sql`SELECT count(*) total FROM new_articles WHERE is_deleted=0 ${board === undefined ? sql`AND board_id<>14` : sql``}`,
      ))!.total;
  const p = paging(c, criteriaTotal);
  const articles = await rows<ArticleRow>(
    db,
    sql`SELECT ${articleColumns} ${articleFrom} WHERE ${filter} ORDER BY COALESCE(k.registered_at,datetime(a.created_at,'+9 hours')) DESC,a.id DESC LIMIT ${p.limit} OFFSET ${p.offset}`,
  );
  const reports = await reportedIds(
    db,
    c.get('principal')?.id,
    articles.map((a) => a.id),
  );
  if (search) await trackSearch(c, query!);
  return c.json(
    pageResult(
      articles.map((a) => ({ ...articleSummary(a), is_reported: reports.has(a.id) })),
      total,
      p.page,
      p.limit,
    ),
  );
}
async function detail(c: Context<ApiEnv>, v2: boolean) {
  const db = c.get('db');
  const id = integer(c.req.param('id'));
  const article = await articleById(db, id);
  const board = c.req.query('boardId') === undefined ? undefined : integer(c.req.query('boardId'));
  const adjacent = await neighbors(db, article, board);
  const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For')?.split(',')[0]?.trim() ?? '';
  const now = Date.now();
  const changed = await executeAtomic(db, [
    sql`INSERT INTO native_article_hit_user(article_id,public_ip,expires_at) VALUES(${id},${ip},${now + 3600000}) ON CONFLICT(article_id,public_ip) DO UPDATE SET expires_at=excluded.expires_at WHERE expires_at<=${now}`,
    sql`UPDATE new_articles SET hit=hit+1 WHERE id=${id} AND changes()>0 RETURNING hit`,
  ]);
  const incremented = changed[1]?.results?.[0] as { hit: number } | undefined;
  if (incremented) article.hit = incremented.hit;
  const content = await readArticleContent(c.env, article.content);
  const attachments = await rows<Record<string, unknown>>(
    db,
    sql`SELECT id,name,url,strftime('%Y-%m-%d %H:%M:%S',created_at,'+9 hours') created_at,strftime('%Y-%m-%d %H:%M:%S',updated_at,'+9 hours') updated_at FROM article_attachments WHERE article_id=${id} AND is_deleted=0 ORDER BY id`,
  );
  const result = { ...articleSummary(article), content, url: article.url, attachments, ...adjacent };
  return c.json(
    v2
      ? { ...result, ai_summary: await getArticleAiSummary(c.env, id, content) }
      : { ...result, content: await prependArticleAiSummary(c.env, id, content) },
  );
}
export function registerCommunityArticles(app: Hono<ApiEnv>) {
  app.get('/articles', (c) => listArticles(c, false));
  app.get('/articles/search', (c) => listArticles(c, true));
  app.get('/articles/hot', async (c) => {
    const db = c.get('db');
    const cached = await rows<ArticleRow>(
      db,
      sql`SELECT ${articleColumns} ${articleFrom} JOIN native_hot_article h ON h.article_id=a.id WHERE a.is_deleted=0 AND a.board_id<>14 ORDER BY h.score DESC LIMIT 10`,
    );
    if (cached.length < 10) {
      const fallback = await rows<ArticleRow>(
        db,
        sql`SELECT ${articleColumns} ${articleFrom} WHERE a.is_deleted=0 AND a.board_id<>14 AND COALESCE(k.registered_at,datetime(a.created_at,'+9 hours'))>datetime('now','+9 hours','start of day','-30 days') ORDER BY a.hit+COALESCE(k.portal_hit,0) DESC,a.id DESC LIMIT 10`,
      );
      const seen = new Set(cached.map((article) => article.id));
      for (const article of fallback)
        if (!seen.has(article.id) && cached.length < 10) {
          cached.push(article);
          seen.add(article.id);
        }
    }
    return c.json(cached.map(articleSummary));
  });
  app.get('/articles/hot/keyword', async (c) => {
    const count = integer(c.req.query('count'));
    if (count < 1) throw new ApiError(400, 'ILLEGAL_ARGUMENT', '개수는 1 이상이어야 합니다.');
    const db = c.get('db');
    const primary = await rows<{ keyword: string }>(
      db,
      sql`SELECT keyword FROM native_popular_keyword ORDER BY weight DESC,keyword DESC LIMIT ${count}`,
    );
    if (primary.length < count) {
      let backup = await rows<{ keyword: string }>(
        db,
        sql`SELECT keyword FROM article_search_keywords WHERE last_searched_at>=datetime('now','-7 days') ORDER BY weight DESC LIMIT ${count - primary.length}`,
      );
      if (!backup.length)
        backup = await rows<{ keyword: string }>(
          db,
          sql`SELECT keyword FROM article_search_keywords ORDER BY last_searched_at DESC LIMIT ${count - primary.length}`,
        );
      const seen = new Set(primary.map((entry) => entry.keyword));
      primary.push(...backup.filter((entry) => !seen.has(entry.keyword)));
    }
    return c.json({ keywords: primary.map((entry) => entry.keyword) });
  });
  app.get('/articles/:id', (c) => detail(c, false));
  app.get('/v2/articles/:id', (c) => detail(c, true));
}
