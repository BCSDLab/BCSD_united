import type { Hono } from 'hono';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { requirePrincipal } from '@api/auth';
import { schema } from '@api/db/schema';
import { executeAtomic, type Database } from '@api/db/client';
import { ApiError } from '@api/errors';
import type { ApiEnv } from '@api/runtime';
import { criteria, identifier, kstTimestamp, notFound, nullableText, parse, sqlNow } from '@api/domains/misc/helpers';

const optionalLink = (pattern: RegExp) => z.string().max(255).regex(pattern).nullish().transform((value) => value ?? null);
const optionalVersion = z.string().max(50).regex(/^[0-9.]+$/).nullish().transform((value) => value ?? null);
const bannerFields = z.object({
  title: z.string().max(255).refine((value) => value.trim().length > 0), image_url: z.string().max(255).refine((value) => value.trim().length > 0),
  is_web_released: z.boolean(), web_redirect_link: optionalLink(/^https:\/\/[\w\-_.:/?=&%]+$/),
  is_android_released: z.boolean(), android_redirect_link: optionalLink(/^koin:\/\/[\w\-_.:/?=&%]+$/), android_minimum_version: optionalVersion,
  is_ios_released: z.boolean(), ios_redirect_link: nullableText(255), ios_minimum_version: optionalVersion,
});
export function validateBannerRelease(input: z.infer<typeof bannerFields>) {
  for (const [released, link, version] of [[input.is_android_released, input.android_redirect_link, input.android_minimum_version], [input.is_ios_released, input.ios_redirect_link, input.ios_minimum_version]]) {
    if (released && (link !== null) !== (version !== null)) throw new ApiError(400, '', '모바일 배포가 활성화된 경우, 리다이렉션 링크와 최소 버전은 모두 존재하거나 모두 없어야 합니다.');
    if (!released && (link !== null || version !== null)) throw new ApiError(400, '', '모바일 배포가 비활성화된 경우, 리다이렉션 링크와 최소버전을 설정할 수 없습니다.');
  }
  if (!input.is_web_released && input.web_redirect_link !== null) throw new ApiError(400, '', '웹 배포여부가 비활성화된 경우, 리다이렉션 링크는 존재하면 안됩니다.');
}
async function getBanner(db: Database, id: number) {
  const [row] = await db.select({ banner: schema.banners, category: schema.banner_categories }).from(schema.banners).innerJoin(schema.banner_categories, eq(schema.banners.banner_category_id, schema.banner_categories.id)).where(eq(schema.banners.id, id));
  if (!row) notFound('해당 ID의 배너가 존재하지 않습니다.');
  return row;
}
function dto(row: { banner: typeof schema.banners.$inferSelect; category: typeof schema.banner_categories.$inferSelect }) {
  const { updated_at, created_at, ...banner } = row.banner;
  return { ...banner, banner_category: row.category.name, created_at: kstTimestamp(created_at)?.slice(2, 10).replaceAll('-', '.') ?? null };
}
function activation(id: number, active: boolean) {
  return sql`UPDATE ${schema.banners} SET priority = CASE WHEN ${active} = 0 THEN NULL WHEN is_active = 1 THEN priority ELSE (SELECT COALESCE(MAX(b.priority), -1) + 1 FROM banners b WHERE b.banner_category_id = banners.banner_category_id AND b.is_active = 1) END, is_active = ${active}, updated_at = ${sqlNow()} WHERE id = ${id}`;
}
export function registerBanners(app: Hono<ApiEnv>) {
  app.get('/banner-categories', async (c) => c.json({ banner_categories: await c.get('db').select({ id: schema.banner_categories.id, name: schema.banner_categories.name }).from(schema.banner_categories) }));
  app.get('/banners/:categoryId', async (c) => {
    const parsedPlatform = z.enum(['WEB', 'ANDROID', 'IOS']).safeParse(c.req.query('platform')?.toUpperCase());
    if (!parsedPlatform.success) notFound('해당 플랫폼타입이 존재하지 않습니다.');
    const platform = parsedPlatform.data;
    const release = platform === 'WEB' ? schema.banners.is_web_released : platform === 'ANDROID' ? schema.banners.is_android_released : schema.banners.is_ios_released;
    const rows = await c.get('db').select().from(schema.banners).where(and(eq(schema.banners.banner_category_id, identifier(c, 'categoryId')), eq(schema.banners.is_active, true), eq(release, true))).orderBy(asc(schema.banners.priority));
    const banners = rows.map((row) => ({ id: row.id, title: row.title, image_url: row.image_url, redirect_link: platform === 'WEB' ? row.web_redirect_link : platform === 'ANDROID' ? row.android_redirect_link : row.ios_redirect_link, version: platform === 'WEB' ? null : platform === 'ANDROID' ? row.android_minimum_version : row.ios_minimum_version }));
    return c.json({ count: banners.length, banners });
  });
  app.get('/admin/banner-categories', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    return c.json({ banner_categories: await c.get('db').select({ id: schema.banner_categories.id, name: schema.banner_categories.name, description: schema.banner_categories.description }).from(schema.banner_categories) });
  });
  app.patch('/admin/banner-categories/:id', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const input = parse(z.object({ description: z.string().max(50) }), await c.req.json());
    const [row] = await c.get('db').update(schema.banner_categories).set({ ...input, updated_at: sqlNow() }).where(eq(schema.banner_categories.id, identifier(c))).returning({ id: schema.banner_categories.id, name: schema.banner_categories.name, description: schema.banner_categories.description });
    if (!row) notFound('배너 카테고리가 존재하지 않습니다.');
    return c.json(row);
  });
  app.get('/admin/banners', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const name = parse(z.string(), c.req.query('banner_category_name'));
    const db = c.get('db');
    const [category] = await db.select().from(schema.banner_categories).where(eq(schema.banner_categories.name, name));
    if (!category) notFound('배너 카테고리가 존재하지 않습니다.');
    const active = c.req.query('is_active');
    const filter = and(eq(schema.banners.banner_category_id, category.id), active === undefined ? undefined : eq(schema.banners.is_active, parse(z.enum(['true', 'false']), active) === 'true'));
    const [total] = await db.select({ count: count() }).from(schema.banners).where(filter);
    const { limit, offset, ...meta } = criteria(c, total!.count);
    const rows = await db.select().from(schema.banners).where(filter).orderBy(asc(active === undefined ? schema.banners.created_at : schema.banners.priority)).limit(limit).offset(offset);
    return c.json({ ...meta, current_count: rows.length, banners: rows.map((banner) => dto({ banner, category })) });
  });
  app.get('/admin/banners/:id', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    return c.json(dto(await getBanner(c.get('db'), identifier(c))));
  });
  app.post('/admin/banners', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const input = parse(bannerFields.extend({ banner_category_id: z.number().int() }), await c.req.json());
    validateBannerRelease(input);
    const [category] = await c.get('db').select({ id: schema.banner_categories.id }).from(schema.banner_categories).where(eq(schema.banner_categories.id, input.banner_category_id));
    if (!category) notFound('배너 카테고리가 존재하지 않습니다.');
    await c.get('db').insert(schema.banners).values({ ...input, is_active: false });
    return c.body(null, 201);
  });
  app.put('/admin/banners/:id', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const id = identifier(c);
    const input = parse(bannerFields.extend({ is_active: z.boolean() }), await c.req.json());
    validateBannerRelease(input);
    await getBanner(c.get('db'), id);
    const { is_active, ...fields } = input;
    await executeAtomic(c.get('db'), [c.get('db').update(schema.banners).set({ ...fields, updated_at: sqlNow() }).where(eq(schema.banners.id, id)).getSQL(), activation(id, is_active)]);
    return c.body(null, 200);
  });
  app.patch('/admin/banners/:id/active', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const id = identifier(c);
    const input = parse(z.object({ is_active: z.boolean() }), await c.req.json());
    await getBanner(c.get('db'), id);
    await c.get('db').run(activation(id, input.is_active));
    return c.body(null, 200);
  });
  app.patch('/admin/banners/:id/priority', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const id = identifier(c);
    const { change_type } = parse(z.object({ change_type: z.enum(['UP', 'DOWN']) }), await c.req.json());
    const db = c.get('db');
    const { banner } = await getBanner(db, id);
    if (!banner.is_active) throw new ApiError(500, '', `비활성화된 배너에 대한 우선순위 변경 요청입니다. bannerId: ${id}`);
    if (banner.priority === null) throw new ApiError(500, '', `활성화되었지만 우선순위가 설정되지 않은 배너입니다. bannerId: ${id}`);
    const targetPriority = banner.priority + (change_type === 'UP' ? -1 : 1);
    const [maximum] = await db.select({ maximum: sql<number | null>`MAX(${schema.banners.priority})` }).from(schema.banners).where(and(eq(schema.banners.banner_category_id, banner.banner_category_id), eq(schema.banners.is_active, true)));
    if (targetPriority < 0 || targetPriority > (maximum?.maximum ?? 0)) return c.body(null, 200);
    const [target] = await db.select({ id: schema.banners.id }).from(schema.banners).where(and(eq(schema.banners.banner_category_id, banner.banner_category_id), eq(schema.banners.is_active, true), eq(schema.banners.priority, targetPriority)));
    if (!target) throw new ApiError(500, '', `우선순위 변경 대상 배너가 존재하지 않습니다. bannerId: ${id}`);
    await db.run(sql`UPDATE ${schema.banners} SET priority = CASE id WHEN ${id} THEN ${targetPriority} ELSE ${banner.priority} END, updated_at = ${sqlNow()} WHERE id IN (${id}, ${target.id}) AND EXISTS (SELECT 1 FROM banners a WHERE a.id = ${id} AND a.priority = ${banner.priority} AND a.is_active = 1) AND EXISTS (SELECT 1 FROM banners b WHERE b.id = ${target.id} AND b.priority = ${targetPriority} AND b.is_active = 1)`);
    return c.body(null, 200);
  });
  app.delete('/admin/banners/:id', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const id = identifier(c);
    const db = c.get('db');
    await getBanner(db, id);
    await executeAtomic(db, [
      sql`UPDATE ${schema.banners} SET priority = priority - 1, updated_at = ${sqlNow()} WHERE is_active = 1 AND banner_category_id = (SELECT banner_category_id FROM banners WHERE id = ${id} AND is_active = 1) AND priority > (SELECT priority FROM banners WHERE id = ${id})`,
      db.delete(schema.banners).where(eq(schema.banners.id, id)).getSQL(),
    ]);
    return c.body(null, 204);
  });
}
