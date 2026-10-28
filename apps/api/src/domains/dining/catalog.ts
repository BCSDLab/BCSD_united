import { sql } from 'drizzle-orm';
import { zipSync } from 'fflate';
import type { Hono } from 'hono';
import type { ApiEnv, Bindings } from '@api/runtime';
import type { Database } from '@api/db/client';
import { ApiError } from '@api/errors';
import { requirePrincipal } from '@api/auth';
import { extractFileKey, getFile } from '@api/integrations';
import { atomicDining, outboxStatement } from '@api/domains/dining/store';
import { cafeteriaOpened, diningNames } from '@api/domains/dining/coopshop';
import { changeSoldout, getDining } from '@api/domains/dining/reports';
import { diningWorkbook } from '@api/domains/dining/spreadsheets';
import { fail, integer, kstDate, kstTimestamp, menuItems, pageWindow, parseDate, requestObject, utcSql, type DiningRow } from '@api/domains/dining/protocol';

export function diningResponse(dining: DiningRow, liked: boolean) {
  return { id: dining.id, date: dining.date, type: dining.type, place: dining.place, price_card: dining.price_card, price_cash: dining.price_cash, kcal: dining.kcal ?? 0, menu: menuItems(dining.menu), image_url: dining.image_url, created_at: kstTimestamp(dining.created_at), updated_at: kstTimestamp(dining.updated_at), soldout_at: kstTimestamp(dining.sold_out), changed_at: kstTimestamp(dining.is_changed), likes: dining.likes, is_liked: liked };
}
async function likeDining(db: Database, userId: number, diningId: number, like: boolean): Promise<void> {
  await atomicDining(db, async () => {
    const existing = await db.get(sql`SELECT id FROM dining_likes WHERE dining_id = ${diningId} AND user_id = ${userId}`);
    if (like && existing) throw new ApiError(409, 'DUPLICATE_DATA', '이미 좋아요를 누른 식단입니다!');
    if (!like && !existing) throw new ApiError(404, 'NOT_FOUND_DATA', '좋아요를 누른적이 없는 식단입니다!');
    await getDining(db, diningId);
    return { statements: [
      like ? sql`INSERT INTO dining_likes (dining_id, user_id) VALUES (${diningId}, ${userId})` : sql`DELETE FROM dining_likes WHERE dining_id = ${diningId} AND user_id = ${userId}`,
      sql`UPDATE dining_menus SET likes = likes + ${like ? 1 : -1}, updated_at = ${utcSql(new Date())} WHERE id = ${diningId}`,
    ], value: undefined };
  });
}
export async function setDiningImage(db: Database, id: number, image: string, env?: Bindings): Promise<void> {
  await atomicDining(db, async () => {
    const dining = await getDining(db, id);
    const exists = await db.get(sql`SELECT 1 FROM dining_menus WHERE date = ${dining.date} AND type = ${dining.type} AND image_url IS NOT NULL LIMIT 1`);
    const now = new Date();
    const opened = await cafeteriaOpened(db, now, dining.type, true);
    const statements = [sql`UPDATE dining_menus SET image_url = ${image}, updated_at = ${utcSql(now)} WHERE id = ${id}`];
    const outboxIds: string[] = [];
    if (opened && !exists) {
      const eventId = crypto.randomUUID();
      outboxIds.push(eventId);
      statements.push(outboxStatement('dining.image', { dining_id: id, image_url: dining.image_url }, now.toISOString(), eventId));
    }
    return { statements, outboxIds, value: undefined };
  }, env);
}
function exportDates(start: string | undefined, end: string | undefined, now = new Date()) {
  const from = parseDate(start ?? '');
  const to = parseDate(end ?? '');
  if (from < '2022-11-29' || to < '2022-11-29') throw new ApiError(400, 'ILLEGAL_ARGUMENT', '2022/11/29 식단부터 다운받을 수 있어요.');
  if (from > kstDate(now) || to > kstDate(now)) throw new ApiError(400, 'ILLEGAL_ARGUMENT', '오늘 날짜 이후 기간은 설정할 수 없어요.');
  if (from > to) throw new ApiError(400, 'ILLEGAL_ARGUMENT', '시작일은 종료일 이전으로 설정해주세요.');
  return { from, to };
}
async function throttleExport(db: Database, from: string, to: string) {
  const key = `excel:${from}${to}`;
  await atomicDining(db, async () => {
    const now = new Date();
    const existing = await db.get(sql`SELECT 1 FROM native_dining_rate_limit WHERE key = ${key} AND expires_at > ${now.toISOString()}`);
    if (existing) throw new ApiError(409, 'DUPLICATE_DATA', '동일한 요청을 30초 안에 다시 보낼 수 없습니다!');
    return { statements: [sql`INSERT INTO native_dining_rate_limit (key, expires_at) VALUES (${key}, ${new Date(now.getTime() + 30_000).toISOString()}) ON CONFLICT(key) DO UPDATE SET expires_at = excluded.expires_at`], value: undefined };
  });
}
export function registerDiningCatalog(app: Hono<ApiEnv>): void {
  app.get('/dinings', async (c) => {
    const query = c.req.query('date');
    const date = query === undefined ? kstDate(new Date()) : /^\d{6}$/.test(query) ? parseDate(`20${query.slice(0, 2)}-${query.slice(2, 4)}-${query.slice(4, 6)}`) : fail('ILLEGAL_ARGUMENT');
    const db = c.get('db');
    const viewer = c.get('principal');
    const rows = await db.all<DiningRow>(sql`SELECT * FROM dining_menus WHERE date = ${date} ORDER BY id`);
    const likes = viewer ? await db.all<{ dining_id: number }>(sql`SELECT dining_id FROM dining_likes WHERE user_id = ${viewer.id} AND dining_id IN (SELECT id FROM dining_menus WHERE date = ${date})`) : [];
    const ids = new Set(likes.map((like) => like.dining_id));
    return c.json(rows.map((row) => diningResponse(row, ids.has(row.id))));
  });
  app.patch('/dining/like', async (c) => {
    const viewer = requirePrincipal(c, ['GENERAL', 'STUDENT', 'COOP', 'COUNCIL']);
    await likeDining(c.get('db'), viewer.id, integer(c.req.query('diningId')), true);
    return c.body(null, 200);
  });
  app.patch('/dining/like/cancel', async (c) => {
    const viewer = requirePrincipal(c, ['GENERAL', 'STUDENT', 'COOP', 'COUNCIL']);
    await likeDining(c.get('db'), viewer.id, integer(c.req.query('diningId')), false);
    return c.body(null, 200);
  });
  app.get('/dinings/search', async (c) => {
    requirePrincipal(c, ['COOP']);
    const db = c.get('db');
    const keyword = c.req.query('keyword');
    if (keyword === undefined) fail('ILLEGAL_ARGUMENT');
    const mapping: Record<string, string> = { A코너: 'A코너', B코너: 'B코너', C코너: 'C코너', 능수관: '능수관', 캠퍼스2: '2캠퍼스' };
    const filter = (c.req.queries('filter') ?? []).flatMap((value) => value.split(',')).filter(Boolean);
    if (filter.some((value) => !mapping[value])) fail('ILLEGAL_ARGUMENT');
    const places = filter.length ? filter.map((place) => mapping[place]!) : Object.values(mapping);
    const pattern = `%${keyword.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
    const predicate = sql`menu LIKE ${pattern} ESCAPE '\' AND place IN (${sql.join(places.map((place) => sql`${place}`), sql`, `)})`;
    const count = (await db.get<{ total: number }>(sql`SELECT count(*) AS total FROM dining_menus WHERE ${predicate}`))!.total;
    const all = (await db.get<{ total: number }>(sql`SELECT count(*) AS total FROM dining_menus`))!.total;
    const page = pageWindow(integer(c.req.query('page') ?? 1), integer(c.req.query('limit') ?? 10), all);
    const rows = await db.all<DiningRow>(sql`SELECT * FROM dining_menus WHERE ${predicate} ORDER BY id DESC LIMIT ${page.size} OFFSET ${page.offset}`);
    const dinings = rows.map((row) => ({
      id: row.id,
      date: row.date,
      type: row.type,
      place: row.place,
      kcal: row.kcal,
      menu: menuItems(row.menu),
      image_url: row.image_url,
      created_at: kstTimestamp(row.created_at),
      // 검색 응답은 품절·변경 시각 자리에도 생성 시각을 내려준다. 바꾸면 응답 계약이 달라진다.
      soldout_at: kstTimestamp(row.created_at),
      changed_at: kstTimestamp(row.created_at),
      likes: row.likes,
    }));
    return c.json({ total_count: count, current_count: rows.length, total_page: Math.ceil(count / page.size), current_page: page.currentPage, dinings });
  });
  app.patch('/coop/dining/soldout', async (c) => {
    requirePrincipal(c, ['COOP']);
    const body = requestObject(await c.req.json());
    if (typeof body.sold_out !== 'boolean') fail('INVALID_REQUEST_BODY');
    await changeSoldout(c.get('db'), integer(body.menu_id), body.sold_out, undefined, c.env);
    return c.body(null, 200);
  });
  app.patch('/coop/dining/image', async (c) => {
    requirePrincipal(c, ['COOP']);
    const body = requestObject(await c.req.json());
    if (typeof body.image_url !== 'string' || !body.image_url.length) fail('INVALID_REQUEST_BODY');
    await setDiningImage(c.get('db'), integer(body.menu_id), body.image_url, c.env);
    return c.body(null, 200);
  });
  app.get('/coop/dining/excel', async (c) => {
    requirePrincipal(c, ['COOP']);
    const db = c.get('db');
    const from = parseDate(c.req.query('startDate') ?? '');
    const to = parseDate(c.req.query('endDate') ?? '');
    await throttleExport(db, from, to);
    exportDates(from, to);
    const cafeteria = c.req.query('isCafeteria') === 'true';
    const rows = await db.all<DiningRow>(sql`SELECT * FROM dining_menus WHERE date BETWEEN ${from} AND ${to} ${cafeteria ? sql`AND place IN ('A코너', 'B코너', 'C코너')` : sql``} ORDER BY date, id`);
    c.header('Content-Disposition', `attachment; filename=${from} ~ ${to} menu.xlsx`);
    c.header('Content-Type', 'application/octet-stream');
    return c.body(diningWorkbook(rows, cafeteria));
  });
  app.get('/coop/dining/image', async (c) => {
    requirePrincipal(c, ['COOP']);
    const { from, to } = exportDates(c.req.query('startDate'), c.req.query('endDate'));
    const cafeteria = c.req.query('isCafeteria') === 'true';
    const rows = await c.get('db').all<DiningRow>(sql`SELECT * FROM dining_menus WHERE date BETWEEN ${from} AND ${to} AND image_url IS NOT NULL ${cafeteria ? sql`AND place IN ('A코너', 'B코너', 'C코너')` : sql``} ORDER BY date, id`);
    const files: Record<string, Uint8Array> = {};
    for (const row of rows) {
      if (!row.image_url) continue;
      let rawKey: string;
      try { rawKey = extractFileKey(c.env, row.image_url); } catch { continue; }
      let key: string;
      try { key = decodeURIComponent(rawKey.replace(/\+/g, ' ')); } catch { throw new ApiError(400, 'ILLEGAL_ARGUMENT', '이미지 URL을 읽을 수 없습니다.'); }
      const file = await getFile(c.env, key);
      if (!file) throw new ApiError(404, 'NOT_FOUND_DATA', '식단 이미지 파일을 찾을 수 없습니다.');
      const extensionIndex = key.lastIndexOf('.');
      if (extensionIndex < 0) throw new ApiError(400, 'ILLEGAL_STATE', '이미지 확장자가 없습니다.');
      const extension = key.slice(extensionIndex);
      const [year, month, day] = row.date.split('-').map(Number);
      files[`dining_images/${year}-${month}-${day}-${diningNames[row.type]}-${row.place}${extension}`] = new Uint8Array(await file.arrayBuffer());
    }
    c.header('Content-Disposition', 'attachment; filename="dining_images.zip"');
    c.header('Content-Type', 'application/octet-stream');
    return c.body(zipSync(files, { level: 0 }));
  });
}
