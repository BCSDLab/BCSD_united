import { sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Context, Hono } from 'hono';
import type { ApiEnv } from '@api/runtime';
import { ApiError } from '@api/errors';
import { requirePrincipal } from '@api/auth';
import { executeAtomic } from '@api/db/client';
import {
  articleById,
  articleColumns,
  articleDates,
  articleFrom,
  neighbors,
  reportedIds,
  trackSearch,
  type ArticleRow,
} from '@api/domains/community/articles';
import {
  enumValue,
  first,
  integer,
  outbox,
  pageResult,
  paging,
  rows,
  signalOutbox,
} from '@api/domains/community/store';
import { replaceTitleIndex, titleSearch } from '@api/domains/community/search';
import { keywordNotifications } from '@api/domains/community/keywords';

const memberRoles = ['GENERAL', 'STUDENT', 'COUNCIL'] as const;
const localDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
const fields = {
  category: z.string().max(255),
  found_place: z.string().max(255),
  found_date: localDate,
  content: z.string().max(1000).nullish(),
};
const createBody = z.object({
  articles: z
    .array(z.object({ ...fields, type: z.string().max(100), images: z.array(z.string().max(255)).max(10) }))
    .min(1),
});
const updateBody = z.object({
  ...fields,
  new_images: z.array(z.string().max(255)).max(10).nullish(),
  delete_image_ids: z.array(z.number().int()).nullish(),
});
export function lostItemTitle(category: string, place: string, date: string): string {
  return `${category} | ${place} | ${date.slice(2).replaceAll('-', '.')}`;
}
export function assertLostItemOwner(authorId: number | null, userId: number) {
  if (authorId !== userId) throw new ApiError(403, 'FORBIDDEN_AUTHOR', '게시글 접근 권한이 없습니다.');
}
export function assertLostItemEditable(isFound: boolean) {
  if (isFound) throw new ApiError(400, 'CANNOT_UPDATE_FOUND_ITEM', '이미 찾은 물건의 정보를 수정할 수 없습니다');
}
async function lostArticle(c: Context<ApiEnv>, id: number) {
  const article = await articleById(c.get('db'), id);
  if (article.board_id !== 14) throw new ApiError(400, '', '게시판 정보와 게시글 정보가 일치하지 않습니다.');
  if (article.lost_id === null) throw new ApiError(404, '', '게시글이 존재하지 않습니다.');
  return article;
}
function lostSummary(article: ArticleRow, isReported: boolean) {
  return {
    id: article.id,
    board_id: article.board_id,
    type: article.type,
    category: article.category,
    found_place: article.found_place,
    found_date: article.found_date,
    content: article.content,
    author: article.author,
    registered_at: articleDates(article).registered_at,
    is_reported: isReported,
    is_found: Boolean(article.is_found),
  };
}
async function lostDetail(c: Context<ApiEnv>, article: ArticleRow, version2 = false, adjacent = true) {
  const db = c.get('db');
  const images = await rows<{ id: number; image_url: string }>(
    db,
    sql`SELECT id,image_url FROM lost_item_images WHERE lost_item_id=${article.lost_id} AND is_deleted=0 ORDER BY id`,
  );
  const summary = lostSummary(article, false);
  const { is_reported: _reported, ...result } = summary;
  const organization =
    version2 && article.author_id !== null
      ? await first<{ name: string; location: string }>(
          db,
          sql`SELECT name,location FROM organizations WHERE user_id=${article.author_id} AND is_deleted=0`,
        )
      : undefined;
  return {
    ...result,
    is_mine: article.author_id !== null && article.author_id === c.get('principal')?.id,
    ...(version2 ? { organization: organization ?? null } : { is_council: Boolean(article.is_council) }),
    images,
    ...(adjacent ? await neighbors(db, article, 14) : { prev_id: null, next_id: null }),
    updated_at: articleDates(article).updated_at.replace(' ', 'T'),
  };
}
async function list(c: Context<ApiEnv>, mode: 'legacy' | 'v2' | 'search') {
  const db = c.get('db');
  const filters: SQL[] = [sql`a.is_deleted=0 AND a.board_id=14 AND l.id IS NOT NULL`];
  const type = c.req.query('type');
  if (type !== undefined && (mode !== 'v2' || type.trim())) filters.push(sql`l.type=${type}`);
  if (mode === 'search') {
    const query = c.req.query('query');
    if (query === undefined) throw new ApiError(400, 'ILLEGAL_ARGUMENT', '검색어를 입력해주세요.');
    filters.push(titleSearch(query));
  }
  let oldest = false;
  if (mode === 'v2') {
    const found = enumValue(c.req.query('foundStatus'), ['ALL', 'FOUND', 'NOT_FOUND'], 'ALL');
    if (found !== 'ALL') filters.push(sql`l.is_found=${found === 'FOUND' ? 1 : 0}`);
    const author = enumValue(c.req.query('author'), ['ALL', 'MY'], 'ALL');
    if (author === 'MY') filters.push(sql`l.author_id=${requirePrincipal(c, [...memberRoles]).id}`);
    oldest = enumValue(c.req.query('sort'), ['LATEST', 'OLDEST'], 'LATEST') === 'OLDEST';
    const categories = (c.req.queries('category') ?? []).flatMap((entry) => entry.split(','));
    const categoryNames = {
      ALL: '',
      CARD: '카드',
      ID: '신분증',
      WALLET: '지갑',
      ELECTRONICS: '전자제품',
      ETC: '기타',
    } as const;
    const selected = categories.map(
      (value) => categoryNames[enumValue(value, Object.keys(categoryNames) as (keyof typeof categoryNames)[], 'ALL')],
    );
    if (selected.length && !selected.includes(''))
      filters.push(
        sql`l.category IN (${sql.join(
          selected.map((value) => sql`${value}`),
          sql`,`,
        )})`,
      );
    const title = c.req.query('title')?.trim();
    if (title) filters.push(sql`instr(lower(a.title),lower(${title}))>0`);
  }
  const filter = sql.join(filters, sql` AND `);
  const total = (await first<{ total: number }>(db, sql`SELECT count(*) total ${articleFrom} WHERE ${filter}`))!.total;
  const criteriaTotal =
    mode === 'search'
      ? undefined
      : mode === 'v2'
        ? total
        : (await first<{ total: number }>(db, sql`SELECT count(*) total FROM new_articles WHERE is_deleted=0`))!.total;
  const p = paging(c, criteriaTotal);
  const order =
    mode === 'v2'
      ? oldest
        ? sql`a.created_at ASC,a.id ASC`
        : sql`a.created_at DESC,a.id DESC`
      : mode === 'search' || !type
        ? sql`COALESCE(k.registered_at,datetime(a.created_at,'+9 hours')) DESC,a.id DESC`
        : sql`a.id DESC`;
  const articles = await rows<ArticleRow>(
    db,
    sql`SELECT ${articleColumns} ${articleFrom} WHERE ${filter} ORDER BY ${order} LIMIT ${p.limit} OFFSET ${p.offset}`,
  );
  const reports = await reportedIds(
    db,
    c.get('principal')?.id,
    articles.map((article) => article.id),
  );
  if (mode === 'search') await trackSearch(c, c.req.query('query')!);
  return c.json(
    pageResult(
      articles.map((article) => lostSummary(article, reports.has(article.id))),
      total,
      p.page,
      p.limit,
    ),
  );
}
export function registerCommunityLostItems(app: Hono<ApiEnv>) {
  app.get('/articles/lost-item/search', (c) => list(c, 'search'));
  app.get('/articles/lost-item/v2', (c) => list(c, 'v2'));
  app.get('/articles/lost-item', (c) => list(c, 'legacy'));
  app.get('/articles/lost-item/stats', async (c) => {
    const result = await first<{ found_count: number; not_found_count: number }>(
      c.get('db'),
      sql`SELECT COALESCE(sum(is_found=1),0) found_count,COALESCE(sum(is_found=0),0) not_found_count FROM lost_item_articles WHERE is_deleted=0 AND author_id IS NOT NULL`,
    );
    return c.json(result!);
  });
  app.get('/articles/lost-item/v2/:id', async (c) =>
    c.json(await lostDetail(c, await lostArticle(c, integer(c.req.param('id'))), true)),
  );
  app.get('/articles/lost-item/:id', async (c) =>
    c.json(await lostDetail(c, await lostArticle(c, integer(c.req.param('id'))))),
  );
  app.post('/articles/lost-item', async (c) => {
    const user = requirePrincipal(c, [...memberRoles]);
    const body = createBody.parse(await c.req.json());
    const db = c.get('db');
    if (!(await first(db, sql`SELECT id FROM boards WHERE id=14 AND is_deleted=0`)))
      throw new ApiError(404, '', '게시판이 존재하지 않습니다.');
    const statements: SQL[] = [];
    for (const article of body.articles) {
      const place = article.found_place.trim() ? article.found_place : '장소 미상';
      const title = lostItemTitle(article.category, place, article.found_date);
      if (title.length > 255) throw new ApiError(400, 'INVALID_REQUEST', '제목은 255자 이하여야 합니다.');
      statements.push(
        sql`INSERT INTO new_articles(board_id,title,content,hit,is_notice,is_deleted) VALUES(14,${title},${article.content ?? null},0,0,0) RETURNING id`,
      );
      statements.push(
        sql`INSERT INTO lost_item_articles(article_id,author_id,type,category,found_place,found_date,is_council,is_found,is_deleted) VALUES(last_insert_rowid(),${user.id},${article.type},${article.category},${place},${article.found_date},${user.userType === 'COUNCIL' ? 1 : 0},0,0)`,
      );
      for (const image of article.images)
        statements.push(
          sql`INSERT INTO lost_item_images(lost_item_id,image_url,is_deleted) SELECT l.id,${image},0 FROM lost_item_articles l WHERE l.article_id=(SELECT max(id) FROM new_articles)`,
        );
      statements.push(keywordNotifications(sql`(SELECT max(id) FROM new_articles)`, 'LOST_ITEM', user.id));
      statements.push(...replaceTitleIndex(sql`(SELECT max(id) FROM new_articles)`, title));
    }
    const result = await executeAtomic(db, statements);
    c.executionCtx.waitUntil(signalOutbox(c.env, result));
    const inserted = result[0]?.results[0];
    if (
      typeof inserted !== 'object' ||
      inserted === null ||
      !('id' in inserted) ||
      typeof inserted.id !== 'number' ||
      !Number.isSafeInteger(inserted.id) ||
      inserted.id <= 0
    )
      throw new TypeError('Lost item insert did not return an integer article ID');
    const id = inserted.id;
    return c.json(await lostDetail(c, await lostArticle(c, id), false, false), 201);
  });
  app.put('/articles/lost-item/:id', async (c) => {
    const user = requirePrincipal(c, [...memberRoles]);
    const id = integer(c.req.param('id'));
    const body = updateBody.parse(await c.req.json());
    const article = await lostArticle(c, id);
    assertLostItemOwner(article.author_id, user.id);
    assertLostItemEditable(Boolean(article.is_found));
    const title = lostItemTitle(body.category, body.found_place, body.found_date);
    if (title.length > 255) throw new ApiError(400, 'INVALID_REQUEST', '제목은 255자 이하여야 합니다.');
    const db = c.get('db');
    const deletion = body.delete_image_ids ?? [];
    if (deletion.length) {
      const available = await rows<{ id: number }>(
        db,
        sql`SELECT id FROM lost_item_images WHERE lost_item_id=${article.lost_id} AND is_deleted=0`,
      );
      if (deletion.some((image) => !available.some((candidate) => candidate.id === image)))
        throw new ApiError(404, 'NOT_FOUND_IMAGE', '이미지를 찾을 수 없습니다');
    }
    const guard = sql`EXISTS(SELECT 1 FROM lost_item_articles WHERE id=${article.lost_id} AND author_id=${user.id} AND is_found=0 AND is_deleted=0)`;
    const statements: SQL[] = [
      sql`UPDATE new_articles SET title=${title},content=COALESCE(${body.content ?? null},content),updated_at=CURRENT_TIMESTAMP WHERE id=${id} AND ${guard}`,
    ];
    for (const image of deletion)
      statements.push(
        sql`UPDATE lost_item_images SET is_deleted=1,updated_at=CURRENT_TIMESTAMP WHERE id=${image} AND lost_item_id=${article.lost_id} AND ${guard}`,
      );
    for (const image of body.new_images ?? [])
      statements.push(
        sql`INSERT INTO lost_item_images(lost_item_id,image_url,is_deleted) SELECT ${article.lost_id},${image},0 WHERE ${guard}`,
      );
    statements.push(...replaceTitleIndex(sql`(SELECT id FROM new_articles WHERE id=${id} AND ${guard})`, title));
    statements.push(
      sql`UPDATE lost_item_articles SET category=${body.category},found_place=${body.found_place},found_date=${body.found_date},updated_at=CURRENT_TIMESTAMP WHERE id=${article.lost_id} AND author_id=${user.id} AND is_found=0 AND is_deleted=0`,
    );
    const result = await executeAtomic(db, statements);
    if (!result[0]!.meta.changes) assertLostItemEditable(true);
    return c.json(await lostDetail(c, await lostArticle(c, id), false, false));
  });
  app.post('/articles/lost-item/:id/found', async (c) => {
    const user = requirePrincipal(c, [...memberRoles]);
    const article = await lostArticle(c, integer(c.req.param('id')));
    assertLostItemOwner(article.author_id, user.id);
    const result = await c
      .get('db')
      .run(
        sql`UPDATE lost_item_articles SET is_found=1,found_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=${article.lost_id} AND author_id=${user.id} AND is_found=0 AND is_deleted=0`,
      );
    if (!result.meta.changes)
      throw new ApiError(409, 'DUPLICATE_FOUND_STATUS', '이미 찾음 처리된 분실물 게시글입니다.');
    return c.body(null, 204);
  });
  app.delete('/articles/lost-item/:id', async (c) => {
    const user = requirePrincipal(c, [...memberRoles]);
    const article = await lostArticle(c, integer(c.req.param('id')));
    if (article.author_id !== user.id) throw new ApiError(403, '', '접근 권한이 없습니다.');
    await executeAtomic(c.get('db'), [
      sql`UPDATE new_articles SET is_deleted=1,updated_at=CURRENT_TIMESTAMP WHERE id=${article.id}`,
      sql`UPDATE lost_item_articles SET is_deleted=1,updated_at=CURRENT_TIMESTAMP WHERE id=${article.lost_id} AND author_id=${user.id}`,
      sql`UPDATE lost_item_images SET is_deleted=1,updated_at=CURRENT_TIMESTAMP WHERE lost_item_id=${article.lost_id}`,
    ]);
    return c.body(null, 204);
  });
  app.post('/articles/lost-item/:id/reports', async (c) => {
    const user = requirePrincipal(c, ['STUDENT', 'COUNCIL']);
    const body = z
      .object({
        reports: z
          .array(z.object({ title: z.string().trim().min(1).max(50), content: z.string().trim().min(1).max(255) }))
          .min(1),
      })
      .parse(await c.req.json());
    const article = await lostArticle(c, integer(c.req.param('id')));
    const result = await executeAtomic(c.get('db'), [
      ...body.reports.map(
        (report) =>
          sql`INSERT INTO lost_item_reports(lost_id,title,content,user_id,status) VALUES(${article.lost_id},${report.title},${report.content},${user.id},'UNHANDLED')`,
      ),
      outbox('community.lost-report', { articleId: article.id }),
    ]);
    c.executionCtx.waitUntil(signalOutbox(c.env, result));
    return c.body(null, 204);
  });
  app.get('/admin/articles/lost-item', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const db = c.get('db');
    const total = (await first<{ total: number }>(
      db,
      sql`SELECT count(*) total FROM lost_item_articles WHERE is_deleted=0`,
    ))!.total;
    const p = paging(c, total);
    const articles = await rows<ArticleRow>(
      db,
      sql`SELECT ${articleColumns} ${articleFrom} WHERE a.is_deleted=0 AND l.id IS NOT NULL ORDER BY l.id ASC LIMIT ${p.limit} OFFSET ${p.offset}`,
    );
    const values = await Promise.all(
      articles.map(async (article) => {
        const reports = await rows<{
          reportId: number;
          title: string;
          content: string;
          nickName: string;
          status: string;
        }>(
          db,
          sql`SELECT r.id reportId,r.title,r.content,u.nickname nickName,r.status FROM lost_item_reports r JOIN users u ON u.id=r.user_id WHERE r.lost_id=${article.lost_id} AND r.status='UNHANDLED' ORDER BY r.id`,
        );
        const { type: _type, is_found: _found, ...value } = lostSummary(article, reports.length > 0);
        return { ...value, unhandled_reports: reports };
      }),
    );
    return c.json(pageResult(values, total, p.page, p.limit));
  });
  app.put('/admin/articles/lost-item/reports/:id', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const body = z.object({ report_status: z.enum(['UNHANDLED', 'DISMISSED', 'DELETED']) }).parse(await c.req.json());
    const article = await lostArticle(c, integer(c.req.param('id')));
    await c
      .get('db')
      .run(
        sql`UPDATE lost_item_reports SET status=${body.report_status},updated_at=CURRENT_TIMESTAMP WHERE lost_id=${article.lost_id} AND status='UNHANDLED'`,
      );
    return c.body(null, 200);
  });
  app.delete('/admin/articles/lost-item/:id', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const article = await lostArticle(c, integer(c.req.param('id')));
    await executeAtomic(c.get('db'), [
      sql`UPDATE lost_item_reports SET status='DELETED',updated_at=CURRENT_TIMESTAMP WHERE lost_id=${article.lost_id}`,
      sql`UPDATE lost_item_articles SET is_deleted=1,updated_at=CURRENT_TIMESTAMP WHERE id=${article.lost_id}`,
      sql`UPDATE lost_item_images SET is_deleted=1,updated_at=CURRENT_TIMESTAMP WHERE lost_item_id=${article.lost_id}`,
    ]);
    return c.body(null, 204);
  });
}
