import type { Hono } from 'hono';
import { and, asc, count, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { requirePrincipal } from '@api/auth';
import { schema } from '@api/db/schema';
import type { ApiEnv } from '@api/runtime';
import { criteria, kstTimestamp, notFound, nullableText, parse, sqlNow } from '@api/domains/misc/helpers';

const versionType = z.enum([
  'android',
  'ios',
  'android_owner',
  'timetable',
  'shuttle_bus_timetable',
  'city_bus_timetable',
  'express_bus_timetable',
]);
function resolveVersionType(value: string) {
  const parsed = versionType.safeParse(value.toLowerCase());
  if (!parsed.success) notFound('존재하지 않는 버전 타입입니다.');
  return parsed.data;
}
export function isPlatformVersion(type: string) {
  return type === 'android' || type === 'ios' || type === 'android_owner';
}
const versionRequest = z.object({
  version: z.string().max(50),
  title: nullableText(255),
  content: nullableText(65535),
});
function response(row: typeof schema.versions.$inferSelect, message = true, camel = false) {
  const created = kstTimestamp(row.created_at);
  const updated = kstTimestamp(row.updated_at)?.slice(0, 10) ?? null;
  return {
    id: row.id,
    type: row.type,
    version: row.version,
    ...(message ? { title: row.title, content: row.content } : {}),
    ...(camel ? { createdAt: created, updatedAt: updated } : { created_at: created, updated_at: updated }),
  };
}
export function registerVersions(app: Hono<ApiEnv>) {
  app.get('/versions/:type', async (c) => {
    const type = resolveVersionType(c.req.param('type'));
    const [row] = await c
      .get('db')
      .select()
      .from(schema.versions)
      .where(and(eq(schema.versions.type, type), eq(schema.versions.is_previous, false)));
    if (!row) notFound('버전 정보를 찾을 수 없습니다.');
    return c.json(response(row, false));
  });
  app.get('/version/:type', async (c) => {
    const type = resolveVersionType(c.req.param('type'));
    const [row] = await c
      .get('db')
      .select()
      .from(schema.versions)
      .where(and(eq(schema.versions.type, type), eq(schema.versions.is_previous, false)));
    if (!row) notFound('버전 정보를 찾을 수 없습니다.');
    return c.json(response(row));
  });
  app.get('/admin/version', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const where = eq(schema.versions.is_previous, false);
    const [total] = await c.get('db').select({ count: count() }).from(schema.versions).where(where);
    const { limit, offset, ...meta } = criteria(c, total!.count);
    const rows = await c
      .get('db')
      .select()
      .from(schema.versions)
      .where(where)
      .orderBy(asc(schema.versions.id))
      .limit(limit)
      .offset(offset);
    return c.json({ ...meta, current_count: rows.length, versions: rows.map((row) => response(row, true, true)) });
  });
  app.get('/admin/version/history/:type', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const type = resolveVersionType(c.req.param('type'));
    const where = eq(schema.versions.type, type);
    const [total] = await c.get('db').select({ count: count() }).from(schema.versions).where(where);
    const { limit, offset, ...meta } = criteria(c, total!.count);
    const rows = await c
      .get('db')
      .select()
      .from(schema.versions)
      .where(where)
      .orderBy(desc(schema.versions.version), asc(schema.versions.id))
      .limit(limit)
      .offset(offset);
    return c.json({ ...meta, current_count: rows.length, versions: rows.map((row) => response(row, true, true)) });
  });
  app.get('/admin/version/:type', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const type = resolveVersionType(c.req.param('type'));
    const [row] = await c
      .get('db')
      .select()
      .from(schema.versions)
      .where(and(eq(schema.versions.type, type), eq(schema.versions.is_previous, false)));
    if (!row) notFound('버전 정보를 찾을 수 없습니다.');
    return c.json(response(row));
  });
  app.post('/admin/version/:type', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const type = resolveVersionType(c.req.param('type'));
    const input = parse(versionRequest, await c.req.json());
    const db = c.get('db');
    const where = and(eq(schema.versions.type, type), eq(schema.versions.is_previous, false));
    const [row] = await db.select({ id: schema.versions.id }).from(schema.versions).where(where);
    if (!row) notFound('버전 정보를 찾을 수 없습니다.');
    if (isPlatformVersion(type)) {
      await db.batch([
        db.update(schema.versions).set({ is_previous: true, updated_at: sqlNow() }).where(where),
        db.insert(schema.versions).values({ ...input, type, is_previous: false, updated_at: sqlNow() }),
      ]);
    } else {
      await db
        .update(schema.versions)
        .set({ ...input, updated_at: sqlNow() })
        .where(where);
    }
    return c.body(null, 201);
  });
}
