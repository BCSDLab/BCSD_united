import { and, asc, count, desc, eq, gt, sql } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { requirePrincipal } from '@api/auth';
import { executeAtomic, type Database } from '@api/db/client';
import { schema } from '@api/db/schema';
import type { ApiEnv } from '@api/runtime';
import { bool, integer, invalid, localDateTime, sqlNow, text, validateClub } from '@api/domains/clubs/behavior';
import { body, clubId, contactsSql, createClub, getCategory, getClub, getUser, managersByLogin, missing, snsLabels, type Club } from '@api/domains/clubs/shared';

function pagination(c: Context<ApiEnv>, total: number) {
  const limit = Math.max(1, Math.min(50, integer(c.req.query('limit') ?? '10', 'limit')));
  const totalPage = Math.ceil(total / limit);
  const page = Math.max(1, Math.min(Math.max(1, totalPage), integer(c.req.query('page') ?? '1', 'page')));
  return { limit, offset: (page - 1) * limit, page, totalPage };
}

async function adminClub(db: Database, club: Club, detail = false) {
  const category = await getCategory(db, club.club_category_id);
  const managers = await db.select({ user: schema.users }).from(schema.club_manager).innerJoin(schema.users, and(eq(schema.club_manager.user_id, schema.users.id), eq(schema.users.is_deleted, false))).where(eq(schema.club_manager.club_id, club.id));
  const result = { id: club.id, name: club.name, image_url: club.image_url,
    club_managers: managers.map(({ user }) => ({ name: user.name ?? '동아리 관리자', user_id: user.user_id, phone_number: user.phone_number })),
    club_category_name: category.name, created_at: localDateTime(club.created_at).slice(2, 10).replaceAll('-', '.'), is_active: club.is_active };
  if (!detail) return result;
  const contacts = await db.select().from(schema.club_sns).where(eq(schema.club_sns.club_id, club.id));
  return { ...result, likes: club.likes, description: club.description, location: club.location, sns_contacts: contacts.map(contact => ({ sns_type: snsLabels[contact.sns_type], contact: contact.contact })) };
}

async function pending(db: Database, name: string) {
  const [request] = await db.select().from(schema.native_club_requests).where(and(eq(schema.native_club_requests.name, name), gt(schema.native_club_requests.expires_at, sqlNow())));
  if (!request) missing('동아리가 존재하지 않습니다.');
  return { record: request, data: JSON.parse(request.payload) as Record<string, unknown> };
}

export function registerAdminClubs(app: Hono<ApiEnv>): void {
  app.get('/admin/clubs/categories', async c => {
    requirePrincipal(c, ['ADMIN']);
    return c.json({ club_categories: await c.get('db').select().from(schema.club_category) });
  });

  app.get('/admin/clubs/managers', async c => {
    requirePrincipal(c, ['ADMIN']);
    const db = c.get('db');
    const [{ total }] = await db.select({ total: count() }).from(schema.club_manager);
    const page = pagination(c, total);
    const sort = c.req.query('sort') ?? 'CREATED_AT_DESC';
    if (!['CREATED_AT_ASC', 'CREATED_AT_DESC'].includes(sort)) invalid('sort', '지원하지 않는 정렬 방식입니다.');
    const rows = await db.select({ club: schema.club, user: schema.users }).from(schema.club_manager)
      .innerJoin(schema.club, eq(schema.club_manager.club_id, schema.club.id)).innerJoin(schema.users, and(eq(schema.club_manager.user_id, schema.users.id), eq(schema.users.is_deleted, false)))
      .orderBy(sort === 'CREATED_AT_ASC' ? asc(schema.club.created_at) : desc(schema.club.created_at)).limit(page.limit).offset(page.offset);
    return c.json({ total_count: total, current_count: rows.length, total_page: page.totalPage, current_page: page.page,
      clubs: rows.map(({ club, user }, index) => ({ index: page.offset + index + 1, club_id: club.id, club_manager_id: user.id,
        club_manager_name: user.name ?? '동아리 관리자', phone_number: user.phone_number, created_at: localDateTime(club.created_at).slice(2, 10).replaceAll('-', '.'), club_name: club.name })) });
  });

  app.get('/admin/clubs/pending', async c => {
    requirePrincipal(c, ['ADMIN']);
    const db = c.get('db');
    const valid = gt(schema.native_club_requests.expires_at, sqlNow());
    const [{ total }] = await db.select({ total: count() }).from(schema.native_club_requests).where(valid);
    const page = pagination(c, total);
    const sort = c.req.query('sort') ?? 'CREATED_AT_DESC';
    if (!['CREATED_AT_ASC', 'CREATED_AT_DESC'].includes(sort)) invalid('sort', '지원하지 않는 정렬 방식입니다.');
    const requests = await db.select().from(schema.native_club_requests).where(valid)
      .orderBy(sort === 'CREATED_AT_ASC' ? asc(schema.native_club_requests.created_at) : desc(schema.native_club_requests.created_at)).limit(page.limit).offset(page.offset);
    const clubs = [];
    for (let index = 0; index < requests.length; index++) {
      const request = requests[index]!;
      const [user] = await db.select().from(schema.users).where(and(eq(schema.users.id, request.requester_id), eq(schema.users.is_deleted, false)));
      if (!user) continue;
      clubs.push({ index: page.offset + index + 1, club_id: null, club_manager_id: user.id, club_manager_name: user.name, phone_number: user.phone_number,
        created_at: localDateTime(request.created_at).slice(2, 10).replaceAll('-', '.'), club_name: request.name });
    }
    return c.json({ total_count: total, current_count: clubs.length, total_page: page.totalPage, current_page: page.page, clubs });
  });

  app.post('/admin/clubs/pending', async c => {
    requirePrincipal(c, ['ADMIN']);
    const name = text(await body(c), 'club_name', 20, true)!;
    const db = c.get('db');
    const { record, data } = await pending(db, name);
    const user = await getUser(db, record.requester_id);
    const category = await getCategory(db, integer(data.club_category_id, 'club_category_id'));
    return c.json({ name: record.name, requester_phone_number: user.phone_number, requester_name: user.name ?? '동아리 관리자', club_category: category.name,
      location: data.location, image_url: data.image_url, description: data.description ?? null, instagram: data.instagram ?? null, google_form: data.google_form ?? null,
      open_chat: data.open_chat ?? null, phone_number: data.phone_number ?? null, role: data.role });
  });

  app.post('/admin/clubs/decision', async c => {
    requirePrincipal(c, ['ADMIN']);
    const request = await body(c);
    const name = text(request, 'club_name', 20, true)!;
    const accept = bool(request, 'is_accept');
    const db = c.get('db');
    const { record, data } = await pending(db, name);
    if (accept) {
      await getUser(db, record.requester_id);
      await createClub(db, validateClub(data, 'request'), [record.requester_id], false, [sql`DELETE FROM ${schema.native_club_requests} WHERE name=${name}`]);
    } else {
      await db.delete(schema.native_club_requests).where(eq(schema.native_club_requests.name, name));
    }
    return c.body(null, 200);
  });

  app.get('/admin/clubs', async c => {
    requirePrincipal(c, ['ADMIN']);
    const db = c.get('db');
    const category = c.req.query('club_category_id');
    const id = category === undefined ? undefined : integer(category, 'club_category_id');
    if (id !== undefined) await getCategory(db, id);
    const condition = id === undefined ? undefined : eq(schema.club.club_category_id, id);
    const [{ total }] = await db.select({ total: count() }).from(schema.club).where(condition);
    const page = pagination(c, total);
    const clubs = await db.select().from(schema.club).where(condition).orderBy(desc(schema.club.created_at)).limit(page.limit).offset(page.offset);
    return c.json({ total_count: total, current_count: clubs.length, total_page: page.totalPage, current_page: page.page, clubs: await Promise.all(clubs.map(club => adminClub(db, club))) });
  });

  app.post('/admin/clubs', async c => {
    requirePrincipal(c, ['ADMIN']);
    const request = await body(c);
    const data = validateClub(request, 'admin-create');
    const db = c.get('db');
    await createClub(db, data, await managersByLogin(db, request.club_managers), true);
    return c.body(null, 200);
  });

  app.get('/admin/clubs/:clubId', async c => {
    requirePrincipal(c, ['ADMIN']);
    return c.json(await adminClub(c.get('db'), await getClub(c.get('db'), clubId(c)), true));
  });

  app.put('/admin/clubs/:clubId', async c => {
    requirePrincipal(c, ['ADMIN']);
    const request = await body(c);
    const data = validateClub(request, 'admin-update');
    const active = bool(request, 'is_active');
    const db = c.get('db');
    const club = await getClub(db, clubId(c));
    await getCategory(db, data.club_category_id);
    const managers = await managersByLogin(db, request.club_managers);
    await executeAtomic(db, [
      sql`UPDATE ${schema.club} SET name=${data.name},normalized_name=${data.normalized_name},image_url=${data.image_url},club_category_id=${data.club_category_id},location=${data.location},description=${data.description},is_active=${active},updated_at=${sqlNow()} WHERE id=${club.id}`,
      sql`DELETE FROM ${schema.club_sns} WHERE club_id=${club.id}`,
      ...contactsSql(club.id, data.contacts, false),
      sql`DELETE FROM ${schema.club_manager} WHERE club_id=${club.id}`,
      ...managers.map(user => sql`INSERT INTO ${schema.club_manager} (club_id,user_id) VALUES (${club.id},${user})`),
    ]);
    return c.body(null, 200);
  });

  app.patch('/admin/clubs/:clubId/active', async c => {
    requirePrincipal(c, ['ADMIN']);
    const active = bool(await body(c), 'is_active');
    const club = await getClub(c.get('db'), clubId(c));
    await c.get('db').update(schema.club).set({ is_active: active, updated_at: sqlNow() }).where(eq(schema.club.id, club.id));
    return c.body(null, 200);
  });
}
