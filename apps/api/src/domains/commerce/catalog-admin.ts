import { sql, type SQL } from 'drizzle-orm';
import type { Hono, MiddlewareHandler } from 'hono';
import { requirePrincipal } from '@api/auth';
import { schema } from '@api/db/schema';
import type { ApiEnv } from '@api/runtime';
import {
  array, atomic, body, boolean, catalogDate, catalogDateTime, catalogError, catalogNow, ids, integer, invalid,
  kstDate, menu, object, pageInfo, rows, shop, sqlList, strings, text,
  type CatalogContext, type JsonObject, type Shop,
} from '@api/domains/commerce/catalog-shared';
import { menuCategories, menuDetail, menuList, saveMenu } from '@api/domains/commerce/catalog-menu';
import { registerCommerceCatalogAdminReviews } from '@api/domains/commerce/catalog-admin-reviews';

type ShopCategory = typeof schema.shop_categories.$inferSelect;
type MenuCategory = typeof schema.shop_menu_categories.$inferSelect;
type OrderServiceRequest = typeof schema.shop_order_service_requests.$inferSelect;

const WEEK_DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
const DEFAULT_MENU_CATEGORIES = ['추천 메뉴', '메인 메뉴', '세트 메뉴', '사이드 메뉴'];
const REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'];
const REQUEST_SORTS = ['CREATED_AT_ASC', 'CREATED_AT_DESC'];

export function catalogAdminAudit(c: CatalogContext, domain: string, id: number | null, request?: JsonObject): SQL {
  const admin = requirePrincipal(c, ['ADMIN']);
  return sql`insert into ${schema.admins_activity_history} (admin_id,domain_id,domain_name,request_method,request_message) values (${admin.id},${id},${domain},${c.req.method},${request ? JSON.stringify(request) : ''})`;
}

function queryInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) invalid('page', '페이지 값이 올바르지 않습니다.');
  return Number(value);
}

export function adminPagination(c: CatalogContext, total: number) {
  const limit = Math.min(50, Math.max(1, queryInteger(c.req.query('limit'), 10)));
  return pageInfo(total, Math.max(1, queryInteger(c.req.query('page'), 1)), limit);
}

export function adminQueryBoolean(c: CatalogContext, name: string): boolean | undefined {
  const value = c.req.query(name);
  if (value === undefined) return undefined;
  if (!['true', 'false'].includes(value)) invalid(name, 'Boolean 값이 올바르지 않습니다.');
  return value === 'true';
}

/**
 * `atomic`과 같은 가드 방식이지만 관리자 화면 계약에 맞춰 409 `CONCURRENT_MODIFICATION`으로 응답한다.
 * 반환값에는 가드 문장의 결과가 포함되므로 인덱스로 결과를 읽는 호출자는 그만큼 밀어서 읽어야 한다.
 */
export async function catalogAdminWrite(c: CatalogContext, statements: SQL[], condition?: SQL) {
  if (!condition) return atomic(c.env, statements);
  const id = crypto.randomUUID();
  try {
    return await atomic(c.env, [
      sql`insert into native_commerce_guard(id,valid) values (${id},case when ${condition} then 1 else 0 end)`,
      ...statements,
      sql`delete from native_commerce_guard where id=${id}`,
    ]);
  } catch (error) {
    if (String(error).includes('CHECK constraint failed')) catalogError(409, 'CONCURRENT_MODIFICATION', '데이터가 변경되었습니다. 다시 요청해주세요.');
    throw error;
  }
}

async function category(c: CatalogContext, id: number): Promise<ShopCategory> {
  const [result] = await rows<ShopCategory>(c, sql`select * from ${schema.shop_categories} where id=${id}`);
  if (!result) catalogError(404, '', `존재하지 않는 카테고리입니다. shopCategoryId: ${id}`);
  return result;
}

function categoryResponse(value: ShopCategory) {
  return { id: value.id, name: value.name, image_url: value.image_url, parent_category_id: value.parent_category_id, event_banner_image_url: value.event_banner_image_url };
}

function optionalText(value: unknown, field: string, max: number) {
  return value == null ? null : text(value, field, 0, max);
}

function clockTime(value: unknown, field: string): string {
  const result = text(value, field);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(result)) invalid(field, '시간 형식이 올바르지 않습니다.');
  return result;
}

function openingHours(value: unknown) {
  return array(value, 'open', 7, 7).map((entry) => {
    const open = object(entry);
    const day = text(open.day_of_week, 'day_of_week');
    if (!WEEK_DAYS.includes(day)) invalid('day_of_week', '요일은 올바른 값이어야 합니다.');
    const closed = Number(open.closed === undefined ? false : boolean(open.closed, 'closed'));
    return { day, closed, start: clockTime(open.open_time, 'open_time'), end: clockTime(open.close_time, 'close_time') };
  });
}

async function saveShop(c: CatalogContext, request: JsonObject, id?: number) {
  if (id !== undefined) await shop(c, id);
  const name = text(request.name, 'name', 1, 100);
  const address = text(request.address, 'address', 1, 100);
  const description = text(request.description, 'description', 0, 200);
  const phone = text(request.phone, 'phone');
  if (!/^\d{3}-\d{3,4}-\d{4}$/.test(phone)) invalid('phone', '전화번호 형식이 유효하지 않습니다.');
  const main = integer(request.main_category_id, 'main_category_id');
  await category(c, main);
  const categories = ids(request.category_ids, 'category_ids', 1);
  const images = strings(request.image_urls, 'image_urls');
  const delivery = Number(boolean(request.delivery, 'delivery'));
  const deliveryPrice = integer(request.delivery_price, 'delivery_price', 0);
  const payBank = Number(boolean(request.pay_bank, 'pay_bank'));
  const payCard = Number(boolean(request.pay_card, 'pay_card'));
  const bank = optionalText(request.bank, 'bank', 10);
  const account = optionalText(request.account_number, 'account_number', 20);
  const opens = openingHours(request.open);
  const now = catalogNow();
  const target = id === undefined ? sql`(select max(id) from ${schema.shops})` : sql`${id}`;
  const statements: SQL[] = id === undefined
    ? [
      sql`insert into ${schema.shops} (name,internal_name,chosung,address,description,phone,delivery,delivery_price,pay_bank,pay_card,main_category_id,remarks,hit,is_event,is_deleted,created_at,updated_at) values (${name},${name},${name.slice(0, 1)},${address},${description},${phone},${delivery},${deliveryPrice},${payBank},${payCard},${main},'',0,0,0,${now},${now})`,
      ...DEFAULT_MENU_CATEGORIES.map((categoryName) => sql`insert into ${schema.shop_menu_categories}(shop_id,name) values (${target},${categoryName})`),
    ]
    : [
      sql`update ${schema.shops} set name=${name},address=${address},description=${description},phone=${phone},delivery=${delivery},delivery_price=${deliveryPrice},pay_bank=${payBank},pay_card=${payCard},main_category_id=${main},bank=${bank},account_number=${account},updated_at=${now} where id=${id}`,
      sql`delete from ${schema.shop_category_map} where shop_id=${id}`,
      sql`delete from ${schema.shop_images} where shop_id=${id}`,
      sql`delete from ${schema.shop_opens} where shop_id=${id}`,
    ];
  statements.push(
    sql`insert into ${schema.shop_category_map}(shop_id,shop_category_id) select ${target},id from ${schema.shop_categories} where id in (${sqlList(categories)})`,
    ...images.map((image) => sql`insert into ${schema.shop_images}(shop_id,image_url) values (${target},${image})`),
    ...opens.map((open) => sql`insert into ${schema.shop_opens}(shop_id,day_of_week,closed,open_time,close_time) values (${target},${open.day},${open.closed},${open.start},${open.end})`),
    catalogAdminAudit(c, 'SHOPS', id ?? null, request),
  );
  await catalogAdminWrite(c, statements, id === undefined ? undefined : sql`exists(select 1 from ${schema.shops} where id=${id} and is_deleted=0)`);
}

async function shopResponse(c: CatalogContext, id: number) {
  const value = await shop(c, id);
  const [images, opens, categories, menus, event] = await Promise.all([
    rows<{ image_url: string }>(c, sql`select image_url from ${schema.shop_images} where shop_id=${id} order by id`),
    rows<{ day_of_week: string; closed: number; open_time: string | null; close_time: string | null }>(c, sql`select day_of_week,closed,open_time,close_time from ${schema.shop_opens} where shop_id=${id} order by id`),
    rows<{ id: number; name: string }>(c, sql`select c.id,c.name from ${schema.shop_categories} c join ${schema.shop_category_map} m on m.shop_category_id=c.id where m.shop_id=${id}`),
    menuCategories(c, id),
    rows<{ count: number }>(c, sql`select count(*) count from ${schema.event_articles} where shop_id=${id} and is_deleted=0 and ${kstDate()} between start_date and end_date`),
  ]);
  return {
    address: value.address,
    delivery: Boolean(value.delivery),
    delivery_price: value.delivery_price,
    description: value.description?.trim() ? value.description : '-',
    id: value.id,
    image_urls: images.map((image) => image.image_url),
    menu_categories: menus.menu_categories,
    name: value.name,
    open: opens.map((open) => ({ ...open, closed: Boolean(open.closed), open_time: open.open_time?.slice(0, 5) ?? null, close_time: open.close_time?.slice(0, 5) ?? null })),
    pay_bank: Boolean(value.pay_bank),
    pay_card: Boolean(value.pay_card),
    phone: value.phone,
    shop_categories: categories,
    main_category_id: value.main_category_id,
    updated_at: catalogDate(value.updated_at),
    is_deleted: Boolean(value.is_deleted),
    is_event: Boolean(event[0]?.count),
    bank: value.bank,
    account_number: value.account_number,
  };
}

async function saveCategory(c: CatalogContext, request: JsonObject, id?: number) {
  const name = text(request.name, 'name', 1, 25);
  const image = text(request.image_url, 'image_url', 1, 255);
  const parent = integer(request.parent_category_id, 'parent_category_id');
  const banner = optionalText(request.event_banner_image_url, 'event_banner_image_url', 255);
  const duplicate = sql`exists(select 1 from ${schema.shop_categories} where name=${name} and id<>${id ?? -1})`;
  if ((await rows<{ found: number }>(c, sql`select ${duplicate} found`))[0]?.found) catalogError(409, '', `카테고리명이 이미 존재합니다 name: 중복되는 상점 카테고리명이 존재합니다.: ${name}`);
  if (id !== undefined) await category(c, id);
  if (!(await rows(c, sql`select id from ${schema.shop_parent_categories} where id=${parent}`)).length) catalogError(404, '', `존재하지 않는 상위 카테고리입니다. shopParentCategoryId: ${parent}`);
  await catalogAdminWrite(c, [
    id === undefined
      ? sql`insert into ${schema.shop_categories}(name,image_url,parent_category_id,event_banner_image_url,order_index) values (${name},${image},${parent},${banner},coalesce((select max(order_index) from ${schema.shop_categories}),0))`
      : sql`update ${schema.shop_categories} set name=${name},image_url=${image},parent_category_id=${parent},event_banner_image_url=${banner},updated_at=${catalogNow()} where id=${id}`,
    catalogAdminAudit(c, 'SHOPSCATEGORIES', id ?? null, request),
  ], sql`not ${duplicate}`);
}

async function menuCategory(c: CatalogContext, id: number): Promise<MenuCategory> {
  const [value] = await rows<MenuCategory>(c, sql`select * from ${schema.shop_menu_categories} where id=${id}`);
  if (!value) catalogError(404, '', `존재하지 않는 메뉴카테고리입니다. categoryId: ${id}`);
  return value;
}

export function registerCommerceCatalogAdmin(app: Hono<ApiEnv>): void {
  const requireAdmin: MiddlewareHandler<ApiEnv> = async (c, next) => {
    requirePrincipal(c, ['ADMIN']);
    await next();
  };
  app.use('/admin/shops', requireAdmin);
  app.use('/admin/shops/*', requireAdmin);
  app.use('/admin/owner/shops/order-service-requests', requireAdmin);
  app.use('/admin/owner/shops/order-service-requests/*', requireAdmin);

  registerCommerceCatalogAdminReviews(app);
  app.get('/admin/shops/categories', async (c) => {
    const categories = await rows<ShopCategory>(c, sql`select * from ${schema.shop_categories} order by order_index`);
    return c.json(categories.map(categoryResponse));
  });
  app.get('/admin/shops/categories/:id', async (c) => c.json(categoryResponse(await category(c, integer(c.req.param('id'))))));
  app.get('/admin/shops/parent-categories', async (c) => c.json(await rows(c, sql`select id,name from ${schema.shop_parent_categories}`)));
  app.post('/admin/shops/categories', async (c) => {
    await saveCategory(c, await body(c));
    return c.body(null, 201);
  });
  app.put('/admin/shops/categories/order', async (c) => {
    const request = await body(c);
    const order = array(request.shop_category_ids, 'shop_category_ids').map((value) => integer(value));
    const current = await rows<{ id: number }>(c, sql`select id from ${schema.shop_categories}`);
    const distinct = new Set(order);
    if (distinct.size !== current.length || current.some((value) => !distinct.has(value.id))) catalogError(400, '', '카테고리를 찾을 수 없습니다 카테고리 목록이 잘못되었습니다.');
    await catalogAdminWrite(c, [
      ...order.map((id, index) => sql`update ${schema.shop_categories} set order_index=${index},updated_at=${catalogNow()} where id=${id}`),
      catalogAdminAudit(c, 'SHOPSCATEGORIES', null, request),
    ], sql`(select count(*) from ${schema.shop_categories})=${current.length}`);
    return c.body(null, 204);
  });
  app.put('/admin/shops/categories/:id', async (c) => {
    await saveCategory(c, await body(c), integer(c.req.param('id')));
    return c.body(null, 200);
  });
  app.delete('/admin/shops/categories/:id', async (c) => {
    const id = integer(c.req.param('id'));
    const empty = sql`not exists(select 1 from ${schema.shop_category_map} where shop_category_id=${id})`;
    if (!(await rows<{ empty: number }>(c, sql`select ${empty} empty`))[0]?.empty) catalogError(400, '', `카테고리에 상점이 남아있어 삭제할 수 없습니다 카테고리에 상점이 존재합니다.${id}`);
    await catalogAdminWrite(c, [sql`delete from ${schema.shop_categories} where id=${id}`, catalogAdminAudit(c, 'SHOPSCATEGORIES', id)], empty);
    return c.body(null, 204);
  });
  app.get('/admin/shops', async (c) => {
    const deleted = Number(adminQueryBoolean(c, 'is_deleted') ?? false);
    const [{ total }] = await rows<{ total: number }>(c, sql`select count(*) total from ${schema.shops} where is_deleted=${deleted}`);
    const page = adminPagination(c, total);
    const shops = await rows<Shop>(c, sql`select * from ${schema.shops} where is_deleted=${deleted} order by id limit ${page.limit} offset ${page.offset}`);
    const mapped = await Promise.all(shops.map(async (value) => {
      const categoryNames = await rows<{ name: string }>(c, sql`select c.name from ${schema.shop_categories} c join ${schema.shop_category_map} m on m.shop_category_id=c.id where m.shop_id=${value.id}`);
      return { id: value.id, name: value.name, phone: value.phone, is_deleted: Boolean(value.is_deleted), category_names: categoryNames.map((item) => item.name) };
    }));
    return c.json({ total_count: total, current_count: mapped.length, total_page: page.total_page, current_page: page.current_page, shops: mapped });
  });
  app.get('/admin/shops/:id', async (c) => c.json(await shopResponse(c, integer(c.req.param('id')))));
  app.post('/admin/shops', async (c) => {
    await saveShop(c, await body(c));
    return c.body(null, 201);
  });
  app.put('/admin/shops/:id', async (c) => {
    await saveShop(c, await body(c), integer(c.req.param('id')));
    return c.body(null, 200);
  });
  app.post('/admin/shops/:id/undelete', async (c) => {
    const id = integer(c.req.param('id'));
    const deleted = sql`exists(select 1 from ${schema.shops} where id=${id} and is_deleted=1)`;
    if (!(await rows(c, sql`select id from ${schema.shops} where id=${id} and is_deleted=1`)).length) catalogError(404, '', `해당 상점이 존재하지 않습니다.: ${id} null`);
    await catalogAdminWrite(c, [sql`update ${schema.shops} set is_deleted=0,updated_at=${catalogNow()} where id=${id}`, catalogAdminAudit(c, 'SHOPS', id)], deleted);
    return c.body(null, 200);
  });
  app.delete('/admin/shops/:id', async (c) => {
    const id = integer(c.req.param('id'));
    await shop(c, id);
    await catalogAdminWrite(c, [sql`update ${schema.shops} set is_deleted=1,updated_at=${catalogNow()} where id=${id}`, catalogAdminAudit(c, 'SHOPS', id)]);
    return c.body(null, 200);
  });

  app.get('/admin/shops/:id/menus/categories', async (c) => {
    const id = integer(c.req.param('id'));
    await shop(c, id);
    return c.json(await menuCategories(c, id));
  });
  app.get('/admin/shops/:id/menus', async (c) => {
    const id = integer(c.req.param('id'));
    await shop(c, id);
    return c.json(await menuList(c, id));
  });
  app.get('/admin/shops/:shopId/menus/:menuId', async (c) => {
    await shop(c, integer(c.req.param('shopId')));
    return c.json(await menuDetail(c, integer(c.req.param('menuId'))));
  });
  app.post('/admin/shops/:id/menus', async (c) => {
    const request = await body(c);
    const shopId = integer(c.req.param('id'));
    await shop(c, shopId);
    for (const id of ids(request.category_ids, 'category_ids', 1)) await menuCategory(c, id);
    await saveMenu(c, shopId, request, undefined, [catalogAdminAudit(c, 'MENUS', null, request)]);
    return c.body(null, 201);
  });
  app.put('/admin/shops/:shopId/menus/categories', async (c) => {
    await shop(c, integer(c.req.param('shopId')));
    const request = await body(c);
    const id = integer(request.id);
    await menuCategory(c, id);
    const name = text(request.name, 'name', 0, 255);
    await catalogAdminWrite(c, [sql`update ${schema.shop_menu_categories} set name=${name},updated_at=${catalogNow()} where id=${id}`, catalogAdminAudit(c, 'MENUSCATEGORIES', null, request)]);
    return c.body(null, 201);
  });
  app.put('/admin/shops/:shopId/menus/:menuId', async (c) => {
    const request = await body(c);
    const id = integer(c.req.param('menuId'));
    const shopId = integer(c.req.param('shopId'));
    await shop(c, shopId);
    await menu(c, id);
    await saveMenu(c, shopId, request, id, [catalogAdminAudit(c, 'MENUS', id, request)]);
    return c.body(null, 201);
  });
  app.post('/admin/shops/:id/menus/categories', async (c) => {
    const id = integer(c.req.param('id'));
    await shop(c, id);
    const request = await body(c);
    const name = text(request.name, 'name', 1, 20);
    await catalogAdminWrite(c, [sql`insert into ${schema.shop_menu_categories}(shop_id,name) values (${id},${name})`, catalogAdminAudit(c, 'MENUSCATEGORIES', null, request)]);
    return c.body(null, 201);
  });
  app.delete('/admin/shops/:shopId/menus/categories/:categoryId', async (c) => {
    const id = integer(c.req.param('categoryId'));
    const value = await menuCategory(c, id);
    if (value.shop_id !== integer(c.req.param('shopId'))) catalogError(400, '', '해당 상점의 카테고리가 아닙니다. null');
    await catalogAdminWrite(c, [
      sql`delete from ${schema.shop_menu_category_map} where shop_menu_category_id=${id}`,
      sql`delete from ${schema.shop_menu_categories} where id=${id}`,
      catalogAdminAudit(c, 'MENUSCATEGORIES', id),
    ]);
    return c.body(null, 204);
  });
  app.delete('/admin/shops/:shopId/menus/:menuId', async (c) => {
    const id = integer(c.req.param('menuId'));
    const value = await menu(c, id);
    if (value.shop_id !== integer(c.req.param('shopId'))) catalogError(400, '', '해당 상점의 메뉴가 아닙니다. null');
    await catalogAdminWrite(c, [
      sql`delete from ${schema.shop_menu_category_map} where shop_menu_id=${id}`,
      sql`delete from ${schema.shop_menu_images} where shop_menu_id=${id}`,
      sql`delete from ${schema.shop_menu_details} where shop_menu_id=${id}`,
      sql`delete from ${schema.shop_menus} where id=${id}`,
      catalogAdminAudit(c, 'MENUS', id),
    ]);
    return c.body(null, 204);
  });

  app.get('/admin/owner/shops/order-service-requests', async (c) => {
    const query = c.req.query('query');
    const status = c.req.query('status');
    const sort = c.req.query('sort') ?? 'CREATED_AT_ASC';
    if (query !== undefined && !query.trim()) catalogError(400, 'SEARCH_QUERY_ONLY_WHITESPACE', '검색 내용은 공백 문자로만 이루어져 있으면 안됩니다.');
    if (status !== undefined && !REQUEST_STATUSES.includes(status)) invalid('status', '상태가 올바르지 않습니다.');
    if (!REQUEST_SORTS.includes(sort)) invalid('sort', '정렬 기준이 올바르지 않습니다.');
    const where = sql.join([
      sql`s.is_deleted=0`,
      ...(query === undefined ? [] : [sql`s.name like ${`%${query}%`}`]),
      ...(status === undefined ? [] : [sql`r.request_status=${status}`]),
    ], sql` and `);
    // 검색어가 없으면 전체 건수는 삭제된 상점의 요청까지 세고, 목록은 삭제되지 않은 상점만 보여준다.
    const countQuery = query === undefined
      ? sql`select count(*) total from ${schema.shop_order_service_requests} r where ${status === undefined ? sql`1=1` : sql`r.request_status=${status}`}`
      : sql`select count(*) total from ${schema.shop_order_service_requests} r join ${schema.shops} s on s.id=r.shop_id where ${where}`;
    const [{ total }] = await rows<{ total: number }>(c, countQuery);
    const page = adminPagination(c, total);
    const direction = sort === 'CREATED_AT_ASC' ? sql`asc` : sql`desc`;
    const requests = await rows<{ id: number; shop_id: number; shop_name: string; request_status: string; created_at: string; approved_at: string | null }>(c, sql`select r.id,r.shop_id,s.name shop_name,r.request_status,r.created_at,r.approved_at from ${schema.shop_order_service_requests} r join ${schema.shops} s on s.id=r.shop_id where ${where} order by r.created_at ${direction} limit ${page.limit} offset ${page.offset}`);
    return c.json({
      total_count: total,
      total_page: page.total_page,
      current_page: page.current_page,
      current_count: requests.length,
      order_service_requests: requests.map((value) => ({ ...value, created_at: catalogDateTime(value.created_at), approved_at: value.approved_at === null ? null : catalogDateTime(value.approved_at) })),
    });
  });
  app.get('/admin/owner/shops/order-service-requests/:id', async (c) => {
    const id = integer(c.req.param('id'));
    const [value] = await rows<OrderServiceRequest & { shop_name: string }>(c, sql`select r.*,s.name shop_name from ${schema.shop_order_service_requests} r join ${schema.shops} s on s.id=r.shop_id and s.is_deleted=0 where r.id=${id}`);
    if (!value) catalogError(404, 'NOT_FOUND_SHOP_ORDER_SERVICE_REQUEST', '상점 서비스 전환 요청이 존재하지 않습니다.');
    return c.json({
      id: value.id,
      shop_id: value.shop_id,
      shop_name: value.shop_name,
      minimum_order_amount: value.minimum_order_amount,
      is_takeout: Boolean(value.is_takeout),
      delivery_option: value.delivery_option,
      campus_delivery_tip: value.campus_delivery_tip,
      off_campus_delivery_tip: value.off_campus_delivery_tip,
      request_status: value.request_status,
      business_license_url: value.business_license_url,
      business_certificate_url: value.business_certificate_url,
      bank_copy_url: value.bank_copy_url,
      bank: value.bank,
      account_number: value.account_number,
      created_at: catalogDateTime(value.created_at),
      approved_at: value.approved_at === null ? null : catalogDateTime(value.approved_at),
    });
  });
}
