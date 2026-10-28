import type { Hono } from 'hono';
import { asc, count, eq } from 'drizzle-orm';
import { z } from 'zod';
import { requirePrincipal } from '@api/auth';
import { schema } from '@api/db/schema';
import { ApiError } from '@api/errors';
import type { ApiEnv } from '@api/runtime';
import { criteria, identifier, kstTimestamp, notFound, nullableText, parse, sqlNow } from '@api/domains/misc/helpers';

const primitiveBoolean = z.boolean().nullish().transform((value) => value ?? false);
const primitiveDouble = z.number().nullish().transform((value) => value ?? 0);
const landRequest = z.object({
  name: z.string().max(255).refine((value) => value.trim().length > 0),
  internal_name: nullableText(50), size: primitiveDouble, latitude: primitiveDouble, longitude: primitiveDouble,
  room_type: nullableText(20), phone: z.string().regex(/^[0-9]{3}-[0-9]{3,4}-[0-9]{4}$/).nullish(),
  image_urls: z.array(z.string()).nullish(), address: nullableText(65535), description: nullableText(65535),
  floor: z.number().int().nonnegative().nullish(), deposit: nullableText(255), monthly_fee: nullableText(255), charter_fee: nullableText(20), management_fee: nullableText(255),
  opt_refrigerator: primitiveBoolean, opt_closet: primitiveBoolean, opt_tv: primitiveBoolean, opt_microwave: primitiveBoolean,
  opt_gas_range: primitiveBoolean, opt_induction: primitiveBoolean, opt_water_purifier: primitiveBoolean, opt_air_conditioner: primitiveBoolean,
  opt_washer: primitiveBoolean, opt_bed: primitiveBoolean, opt_desk: primitiveBoolean, opt_shoe_closet: primitiveBoolean,
  opt_electronic_door_locks: primitiveBoolean, opt_bidet: primitiveBoolean, opt_veranda: primitiveBoolean, opt_elevator: primitiveBoolean,
});
type Land = typeof schema.lands.$inferSelect;
function doubleString(value: number) {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}
function detail(row: Land, admin: boolean) {
  const { created_at, updated_at, ...rest } = row;
  const base = { ...rest, size: admin ? (row.size === null ? null : Number(row.size)) : row.size === null ? 'null' : doubleString(Number(row.size)), latitude: row.latitude === null ? null : Number(row.latitude), longitude: row.longitude === null ? null : Number(row.longitude), image_urls: row.image_urls ? parse(z.array(z.string()), JSON.parse(row.image_urls)) : admin ? [] : null };
  return admin ? base : { ...base, created_at: kstTimestamp(created_at), updated_at: kstTimestamp(updated_at), permalink: encodeURIComponent(row.internal_name).replace(/%20/g, '+').replace(/[!'()~]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`) };
}
function values(input: z.infer<typeof landRequest>) {
  return { ...input, internal_name: input.name.trim().replaceAll(' ', '').toLowerCase(), size: doubleString(input.size), latitude: doubleString(input.latitude), longitude: doubleString(input.longitude), phone: input.phone ?? null, floor: input.floor ?? null, image_urls: input.image_urls?.length ? JSON.stringify(input.image_urls) : null, updated_at: sqlNow() };
}
export function registerLands(app: Hono<ApiEnv>) {
  app.get('/lands', async (c) => {
    const rows = await c.get('db').select().from(schema.lands);
    return c.json({ lands: rows.map((row) => ({ id: row.id, name: row.name, internal_name: row.internal_name, monthly_fee: row.monthly_fee, charter_fee: row.charter_fee, room_type: row.room_type, latitude: row.latitude === null ? null : Number(row.latitude), longitude: row.longitude === null ? null : Number(row.longitude) })) });
  });
  app.get('/lands/:id', async (c) => {
    const [row] = await c.get('db').select().from(schema.lands).where(eq(schema.lands.id, identifier(c)));
    if (!row) notFound('복덕방이 존재하지 않습니다.');
    return c.json(detail(row, false));
  });
  app.get('/admin/lands', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const deleted = parse(z.enum(['true', 'false']), c.req.query('is_deleted') ?? 'false') === 'true';
    const filter = eq(schema.lands.is_deleted, deleted);
    const [total] = await c.get('db').select({ count: count() }).from(schema.lands).where(filter);
    const pagination = criteria(c, total!.count);
    const rows = await c.get('db').select().from(schema.lands).where(filter).orderBy(asc(schema.lands.id)).limit(pagination.limit).offset(pagination.offset);
    const { limit, offset, ...meta } = pagination;
    return c.json({ ...meta, current_count: rows.length, lands: rows.map(({ id, name, room_type, monthly_fee, charter_fee, is_deleted }) => ({ id, name, room_type, monthly_fee, charter_fee, is_deleted })) });
  });
  app.get('/admin/lands/:id', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const [row] = await c.get('db').select().from(schema.lands).where(eq(schema.lands.id, identifier(c)));
    if (!row) notFound('복덕방이 존재하지 않습니다.');
    return c.json(detail(row, true));
  });
  app.post('/admin/lands', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const input = parse(landRequest, await c.req.json());
    const [duplicate] = await c.get('db').select({ id: schema.lands.id }).from(schema.lands).where(eq(schema.lands.name, input.name));
    if (duplicate) throw new ApiError(409, '', '매물명이 이미 존재합니다');
    await c.get('db').insert(schema.lands).values(values(input));
    return c.body(null, 201);
  });
  app.put('/admin/lands/:id', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const input = parse(landRequest, await c.req.json());
    const rows = await c.get('db').update(schema.lands).set(values(input)).where(eq(schema.lands.id, identifier(c))).returning({ id: schema.lands.id });
    if (!rows.length) notFound('복덕방이 존재하지 않습니다.');
    return c.body(null, 200);
  });
  app.delete('/admin/lands/:id', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const rows = await c.get('db').update(schema.lands).set({ is_deleted: true, updated_at: sqlNow() }).where(eq(schema.lands.id, identifier(c))).returning({ id: schema.lands.id });
    if (!rows.length) notFound('복덕방이 존재하지 않습니다.');
    return c.body(null, 200);
  });
  app.post('/admin/lands/:id/undelete', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const rows = await c.get('db').update(schema.lands).set({ is_deleted: false, updated_at: sqlNow() }).where(eq(schema.lands.id, identifier(c))).returning({ id: schema.lands.id });
    if (!rows.length) notFound('복덕방이 존재하지 않습니다.');
    return c.body(null, 200);
  });
}
