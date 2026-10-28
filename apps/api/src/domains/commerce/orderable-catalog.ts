import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { Hono } from 'hono';
import { requirePrincipal } from '@api/auth';
import type { Database } from '@api/db/client';
import { schema } from '@api/db/schema';
import { ApiError } from '@api/errors';
import type { ApiEnv } from '@api/runtime';

const s = schema;
const missingShop = () => new ApiError(404, 'NOT_FOUND_ORDERABLE_SHOP', '주문 가능 상점이 존재하지 않습니다.');
const invalidArgument = () => new ApiError(400, 'ILLEGAL_ARGUMENT', '잘못된 인자가 전달되었습니다.');
const weekdays = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

function integer(value: string | undefined): number {
  if (value === undefined || !/^-?\d+$/.test(value)) throw invalidArgument();
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < -2147483648 || result > 2147483647) throw invalidArgument();
  return result;
}

function koreaNow(): { day: string; date: string; time: string } {
  const date = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return { day: weekdays[date.getUTCDay()]!, date: date.toISOString().slice(0, 10), time: date.toISOString().slice(11, 23) };
}

export async function getOrderableShop(db: Database, id: number) {
  const [row] = await db.select({ orderable: s.orderable_shop, shop: s.shops, operation: s.shop_operation })
    .from(s.orderable_shop).innerJoin(s.shops, and(eq(s.shops.id, s.orderable_shop.shop_id), eq(s.shops.is_deleted, false)))
    .leftJoin(s.shop_operation, and(eq(s.shop_operation.shop_id, s.shops.id), eq(s.shop_operation.is_deleted, false)))
    .where(and(eq(s.orderable_shop.id, id), eq(s.orderable_shop.is_deleted, false))).limit(1);
  if (!row) throw missingShop();
  return row;
}

export async function requireOrderableShopOpen(db: Database, id: number) {
  const shop = await getOrderableShop(db, id);
  if (!shop.operation?.is_open) throw new ApiError(400, 'SHOP_CLOSED', '상점의 영업시간이 아닙니다.');
  return shop;
}

export async function calculateDeliveryFee(db: Database, shopId: number, orderAmount: number): Promise<number> {
  const tips = await db.select({ order_amount: s.shop_base_delivery_tip.order_amount, fee: s.shop_base_delivery_tip.fee })
    .from(s.shop_base_delivery_tip).where(and(eq(s.shop_base_delivery_tip.shop_id, shopId), eq(s.shop_base_delivery_tip.is_deleted, false)))
    .orderBy(asc(s.shop_base_delivery_tip.order_amount));
  let fee = tips[0]?.fee ?? 0;
  for (const tip of tips) {
    if (tip.order_amount > orderAmount) break;
    fee = tip.fee;
  }
  return fee;
}

async function menuParts(db: Database, menuIds: number[]) {
  if (!menuIds.length) return { prices: [], images: [] };
  const [prices, images] = await Promise.all([
    db.select().from(s.orderable_shop_menu_price).where(and(inArray(s.orderable_shop_menu_price.orderable_shop_menu_id, menuIds), eq(s.orderable_shop_menu_price.is_deleted, false))),
    db.select().from(s.orderable_shop_menu_images).where(and(inArray(s.orderable_shop_menu_images.orderable_shop_menu_id, menuIds), eq(s.orderable_shop_menu_images.is_deleted, false))),
  ]);
  return { prices, images };
}

export async function getOrderableMenu(db: Database, id: number) {
  const [menu] = await db.select().from(s.orderable_shop_menu)
    .where(and(eq(s.orderable_shop_menu.id, id), eq(s.orderable_shop_menu.is_deleted, false))).limit(1);
  if (!menu) throw new ApiError(404, 'NOT_FOUND_ORDERABLE_SHOP_MENU', '메뉴가 존재하지 않습니다');
  const [parts, groups] = await Promise.all([
    menuParts(db, [id]),
    db.select({ group: s.orderable_shop_menu_option_group }).from(s.orderable_shop_menu_option_group_map)
      .innerJoin(s.orderable_shop_menu_option_group, eq(s.orderable_shop_menu_option_group.id, s.orderable_shop_menu_option_group_map.orderable_shop_menu_option_group_id))
      .where(and(eq(s.orderable_shop_menu_option_group_map.orderable_shop_menu_id, id), eq(s.orderable_shop_menu_option_group_map.is_deleted, false), eq(s.orderable_shop_menu_option_group.is_deleted, false))),
  ]);
  const ids = groups.map(({ group }) => group.id);
  const options = ids.length ? await db.select().from(s.orderable_shop_menu_option)
    .where(and(inArray(s.orderable_shop_menu_option.orderable_shop_menu_option_group_id, ids), eq(s.orderable_shop_menu_option.is_deleted, false))) : [];
  return { menu, prices: parts.prices, images: parts.images, option_groups: groups.map(({ group }) => ({
    ...group, options: options.filter((option) => option.orderable_shop_menu_option_group_id === group.id),
  })) };
}

async function menuGroups(db: Database, id: number) {
  await getOrderableShop(db, id);
  return db.select({ id: s.orderable_shop_menu_group.id, name: s.orderable_shop_menu_group.name })
    .from(s.orderable_shop_menu_group).where(and(eq(s.orderable_shop_menu_group.orderable_shop_id, id), eq(s.orderable_shop_menu_group.is_deleted, false)));
}

async function shopMenus(db: Database, id: number) {
  const groups = await menuGroups(db, id);
  if (!groups.length) return [];
  const maps = await db.select({ group_id: s.orderable_shop_menu_group_map.orderable_shop_menu_group_id, menu: s.orderable_shop_menu })
    .from(s.orderable_shop_menu_group_map).innerJoin(s.orderable_shop_menu, eq(s.orderable_shop_menu.id, s.orderable_shop_menu_group_map.orderable_shop_menu_id))
    .where(and(inArray(s.orderable_shop_menu_group_map.orderable_shop_menu_group_id, groups.map((group) => group.id)), eq(s.orderable_shop_menu_group_map.is_deleted, false), eq(s.orderable_shop_menu.is_deleted, false)));
  const parts = await menuParts(db, maps.map(({ menu }) => menu.id));
  return groups.map((group) => ({ menu_group_id: group.id, menu_group_name: group.name,
    menus: maps.filter((map) => map.group_id === group.id).map(({ menu }) => ({
      id: menu.id, name: menu.name, description: menu.description, is_sold_out: menu.is_sold_out,
      thumbnail_image: parts.images.find((image) => image.orderable_shop_menu_id === menu.id && image.is_thumbnail)?.image_url ?? null,
      prices: parts.prices.filter((price) => price.orderable_shop_menu_id === menu.id).map(({ id, name, price }) => ({ id, name, price })),
    })),
  }));
}

async function catalogRows(db: Database) {
  return db.select({
    shop_id: s.shops.id, orderable_shop_id: s.orderable_shop.id, name: s.shops.name, internal_name: s.shops.internal_name,
    is_delivery_available: s.orderable_shop.delivery, is_takeout_available: s.orderable_shop.takeout,
    service_event: s.orderable_shop.service_event, minimum_order_amount: s.orderable_shop.minimum_order_amount,
    is_open: s.shop_operation.is_open,
    rating_average: sql<number>`(select round(coalesce(avg(r.rating),0),1) from ${s.shop_reviews} r where r.shop_id=${s.shops.id} and r.is_deleted=0)`,
    review_count: sql<number>`(select count(*) from ${s.shop_reviews} r where r.shop_id=${s.shops.id} and r.is_deleted=0)`,
    minimum_delivery_tip: sql<number | null>`(select min(t.fee) from ${s.shop_base_delivery_tip} t where t.shop_id=${s.shops.id} and t.is_deleted=0)`,
    maximum_delivery_tip: sql<number | null>`(select max(t.fee) from ${s.shop_base_delivery_tip} t where t.shop_id=${s.shops.id} and t.is_deleted=0)`,
  }).from(s.shops).innerJoin(s.orderable_shop, eq(s.orderable_shop.shop_id, s.shops.id))
    .innerJoin(s.shop_operation, eq(s.shop_operation.shop_id, s.shops.id))
    .where(and(eq(s.shops.is_deleted, false), eq(s.orderable_shop.is_deleted, false), eq(s.shop_operation.is_deleted, false)));
}

interface CatalogRow {
  shop_id: number;
  orderable_shop_id: number;
  name: string;
  internal_name: string;
  is_delivery_available: boolean;
  is_takeout_available: boolean;
  service_event: boolean;
  minimum_order_amount: number;
  is_open: boolean;
  rating_average: number;
  review_count: number;
  minimum_delivery_tip: number | null;
  maximum_delivery_tip: number | null;
}

async function catalogDetails(db: Database, rows: CatalogRow[]) {
  if (!rows.length) return { categories: [], images: [], schedules: [] };
  const shopIds = rows.map((row) => row.shop_id);
  const ids = rows.map((row) => row.orderable_shop_id);
  const [categories, images, schedules] = await Promise.all([
    db.select().from(s.shop_category_map).where(inArray(s.shop_category_map.shop_id, shopIds)),
    db.select().from(s.orderable_shop_image).where(and(inArray(s.orderable_shop_image.orderable_shop_id, ids), eq(s.orderable_shop_image.is_deleted, false))),
    db.select().from(s.shop_opens).where(and(inArray(s.shop_opens.shop_id, shopIds), eq(s.shop_opens.is_deleted, false))),
  ]);
  return { categories, images, schedules };
}

function openStatus(row: CatalogRow, schedules: (typeof s.shop_opens.$inferSelect)[], now: { day: string; time: string }) {
  if (row.is_open) return 'OPERATING';
  const schedule = schedules.find((entry) => entry.shop_id === row.shop_id && entry.day_of_week === now.day);
  if (schedule && !schedule.closed && schedule.open_time && schedule.close_time
      && now.time >= schedule.open_time && now.time < schedule.close_time) return 'PREPARING';
  return 'CLOSED';
}

function sortRows<T extends { name: string; rating_average: number; review_count: number }>(rows: T[], sorter: string, search: boolean): T[] {
  const countKey = search ? 'REVIEW_COUNT' : 'COUNT';
  if (!['NONE', countKey, `${countKey}_ASC`, `${countKey}_DESC`, 'RATING', 'RATING_ASC', 'RATING_DESC'].includes(sorter)) throw invalidArgument();
  return rows.sort((a, b) => {
    const direction = sorter.endsWith('_ASC') ? 1 : -1;
    const difference = sorter.startsWith(countKey) ? (a.review_count - b.review_count) * direction
      : sorter.startsWith('RATING') ? (a.rating_average - b.rating_average) * direction : 0;
    return difference || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  });
}

async function summary(db: Database, id: number) {
  const { shop, orderable } = await getOrderableShop(db, id);
  const [reviews, tips, images] = await Promise.all([
    db.select({ average: sql<number>`coalesce(avg(${s.shop_reviews.rating}),0)`, count: sql<number>`count(*)` })
      .from(s.shop_reviews).where(and(eq(s.shop_reviews.shop_id, shop.id), eq(s.shop_reviews.is_deleted, false))),
    db.select({ minimum: sql<number>`coalesce(min(${s.shop_base_delivery_tip.fee}),0)`, maximum: sql<number>`coalesce(max(${s.shop_base_delivery_tip.fee}),0)` })
      .from(s.shop_base_delivery_tip).where(and(eq(s.shop_base_delivery_tip.shop_id, shop.id), eq(s.shop_base_delivery_tip.is_deleted, false))),
    db.select({ image_url: s.orderable_shop_image.image_url, is_thumbnail: s.orderable_shop_image.is_thumbnail })
      .from(s.orderable_shop_image).where(and(eq(s.orderable_shop_image.orderable_shop_id, id), eq(s.orderable_shop_image.is_deleted, false))),
  ]);
  return { shop_id: shop.id, orderable_shop_id: id, name: shop.name, introduction: shop.introduction,
    is_delivery_available: orderable.delivery, is_takeout_available: orderable.takeout, pay_card: shop.pay_card, pay_bank: shop.pay_bank,
    minimum_order_amount: orderable.minimum_order_amount, rating_average: reviews[0]!.average, review_count: reviews[0]!.count,
    minimum_delivery_tip: tips[0]!.minimum, maximum_delivery_tip: tips[0]!.maximum, images };
}

async function detail(db: Database, id: number) {
  const { shop } = await getOrderableShop(db, id);
  const [opens, tips, origins, owners] = await Promise.all([
    db.select().from(s.shop_opens).where(and(eq(s.shop_opens.shop_id, shop.id), eq(s.shop_opens.is_deleted, false))),
    db.select().from(s.shop_base_delivery_tip).where(and(eq(s.shop_base_delivery_tip.shop_id, shop.id), eq(s.shop_base_delivery_tip.is_deleted, false))).orderBy(asc(s.shop_base_delivery_tip.order_amount)),
    db.select({ ingredient: s.shop_menu_origin.ingredient, origin: s.shop_menu_origin.origin }).from(s.shop_menu_origin).where(eq(s.shop_menu_origin.shop_id, shop.id)),
    shop.owner_id === null ? Promise.resolve([]) : db.select({ name: s.users.name, company_registration_number: s.owners.company_registration_number })
      .from(s.owners).leftJoin(s.users, and(eq(s.users.id, s.owners.user_id), eq(s.users.is_deleted, false))).where(eq(s.owners.user_id, shop.owner_id)),
  ]);
  const today = opens.find((open) => open.day_of_week === koreaNow().day);
  const owner = owners[0];
  return { shop_id: shop.id, orderable_shop_id: id, name: shop.name, address: shop.address,
    open_time: today?.open_time?.slice(0, 5) ?? null, close_time: today?.close_time?.slice(0, 5) ?? null,
    closed_days: opens.filter((open) => open.closed).map((open) => open.day_of_week), phone: shop.phone,
    introduction: shop.introduction, notice: shop.notice, origins,
    delivery_tips: tips.map((tip, index) => ({ from_amount: tip.order_amount, to_amount: tips[index + 1]?.order_amount ?? null, fee: tip.fee })),
    owner_info: owner ? { name: owner.name, shop_name: shop.name, address: shop.address, company_registration_number: owner.company_registration_number }
      : { name: null, shop_name: null, address: null, company_registration_number: null },
  };
}

async function events(db: Database, id?: number) {
  if (id !== undefined) await getOrderableShop(db, id);
  const today = koreaNow().date;
  const rows = await db.select({ orderable_shop_id: s.orderable_shop.id, shop_id: s.shops.id, shop_name: s.shops.name,
    event_id: s.event_articles.id, title: s.event_articles.title, content: s.event_articles.content,
    start_date: s.event_articles.start_date, end_date: s.event_articles.end_date,
  }).from(s.orderable_shop).innerJoin(s.shops, eq(s.shops.id, s.orderable_shop.shop_id))
    .innerJoin(s.event_articles, eq(s.event_articles.shop_id, s.shops.id))
    .where(and(eq(s.orderable_shop.is_deleted, false), eq(s.shops.is_deleted, false), eq(s.event_articles.is_deleted, false),
      lte(s.event_articles.start_date, today), gte(s.event_articles.end_date, today), id === undefined ? undefined : eq(s.orderable_shop.id, id)));
  const images = rows.length ? await db.select().from(s.event_article_thumbnail_images)
    .where(inArray(s.event_article_thumbnail_images.event_id, rows.map((row) => row.event_id))) : [];
  return { shop_events: rows.map((row) => ({ ...row, thumbnail_images: images.filter((image) => image.event_id === row.event_id).map((image) => image.thumbnail_image) })) };
}

function keywords(value: string): string[] {
  return value.trim().split(/\s+/).map((word) => word.replace(/[^가-힣a-zA-Z0-9]/g, '')).filter(Boolean);
}
function matches(value: string | null, words: string[]) {
  return words.length === 0 || words.some((word) => value?.toLowerCase().includes(word.toLowerCase()));
}

export function registerOrderableCatalog(app: Hono<ApiEnv>): void {
  app.get('/order/shops', async (c) => {
    const db = c.get('db');
    const category = c.req.query('category_filter') === undefined ? 1 : integer(c.req.query('category_filter'));
    if (category < 1 || category > 12) throw invalidArgument();
    const minimum = c.req.query('minimum_order_amount') === undefined ? undefined : integer(c.req.query('minimum_order_amount'));
    const filters = (c.req.queries('filter') ?? []).flatMap((filter) => filter.split(',')).filter(Boolean);
    if (filters.some((filter) => !['IS_OPEN', 'DELIVERY_AVAILABLE', 'TAKEOUT_AVAILABLE', 'FREE_DELIVERY_TIP'].includes(filter))) throw invalidArgument();
    const rows = (await catalogRows(db)).filter((row) => (minimum === undefined || row.minimum_order_amount <= minimum)
      && filters.every((filter) => filter === 'IS_OPEN' ? row.is_open : filter === 'DELIVERY_AVAILABLE' ? row.is_delivery_available
        : filter === 'TAKEOUT_AVAILABLE' ? row.is_takeout_available : row.maximum_delivery_tip === 0));
    const details = await catalogDetails(db, rows);
    const now = koreaNow();
    const response = rows.filter((row) => category === 1 || details.categories.some((entry) => entry.shop_id === row.shop_id && entry.shop_category_id === category))
      .map(({ internal_name: _internal, ...row }) => ({ ...row,
        category_ids: details.categories.filter((entry) => entry.shop_id === row.shop_id).map((entry) => entry.shop_category_id),
        images: details.images.filter((entry) => entry.orderable_shop_id === row.orderable_shop_id).map(({ image_url, is_thumbnail }) => ({ image_url, is_thumbnail })),
        open_status: openStatus({ ...row, internal_name: _internal }, details.schedules, now),
      }));
    return c.json(sortRows(response, c.req.query('sorter') ?? 'NONE', false));
  });
  app.get('/order/shop/search/related', async (c) => {
    const raw = c.req.query('keyword');
    if (raw === undefined) throw invalidArgument();
    const words = keywords(raw);
    const db = c.get('db');
    const shops = await db.select({ orderable_shop_id: s.orderable_shop.id, orderable_shop_name: s.shops.name, internal_name: s.shops.internal_name })
      .from(s.orderable_shop).innerJoin(s.shops, eq(s.shops.id, s.orderable_shop.shop_id))
      .where(and(eq(s.orderable_shop.is_deleted, false), eq(s.shops.is_deleted, false)));
    const menus = shops.length ? await db.select().from(s.orderable_shop_menu)
      .where(and(inArray(s.orderable_shop_menu.orderable_shop_id, shops.map((shop) => shop.orderable_shop_id)), eq(s.orderable_shop_menu.is_deleted, false))) : [];
    const shopResults = shops.filter((shop) => matches(shop.orderable_shop_name, words) || matches(shop.internal_name, words))
      .map(({ internal_name: _internal, ...shop }) => shop);
    const menuResults = menus.filter((menu) => matches(menu.name, words)).map((menu) => ({ orderable_shop_id: menu.orderable_shop_id,
      orderable_shop_name: shops.find((shop) => shop.orderable_shop_id === menu.orderable_shop_id)!.orderable_shop_name, menu_name: menu.name }));
    return c.json({ search_keyword: raw, processed_search_keyword: words.join(' '), shop_name_search_result_count: shopResults.length,
      menu_name_search_result_count: menuResults.length, shop_name_search_results: shopResults, menu_name_search_results: menuResults });
  });
  app.get('/order/shop/search', async (c) => {
    const raw = c.req.query('keyword');
    if (raw === undefined) throw invalidArgument();
    const words = keywords(raw);
    const sorter = c.req.query('sorter') ?? 'NONE';
    sortRows([], sorter, true);
    const db = c.get('db');
    const allRows = words.length ? await catalogRows(db) : [];
    const menus = allRows.length ? await db.select().from(s.orderable_shop_menu)
      .where(and(inArray(s.orderable_shop_menu.orderable_shop_id, allRows.map((row) => row.orderable_shop_id)), eq(s.orderable_shop_menu.is_deleted, false))) : [];
    const matchingMenus = menus.filter((menu) => matches(menu.name, words));
    const rows = allRows.filter((row) => matches(row.name, words) || matches(row.internal_name, words) || matchingMenus.some((menu) => menu.orderable_shop_id === row.orderable_shop_id));
    const details = await catalogDetails(db, rows);
    const now = koreaNow();
    const result = rows.map((row) => {
      const menuNames = matchingMenus.filter((menu) => menu.orderable_shop_id === row.orderable_shop_id).map((menu) => menu.name);
      const { shop_id: _shopId, internal_name: _internal, ...fields } = row;
      return { ...fields, review_count: row.review_count * Math.max(1, menuNames.length),
        thumbnail_image_url: details.images.find((image) => image.orderable_shop_id === row.orderable_shop_id && image.is_thumbnail)?.image_url ?? null,
        open_status: openStatus(row, details.schedules, now), contain_menu_name: menuNames };
    });
    return c.json({ search_keyword: raw, processed_search_keyword: words.join(' '), result_count: result.length, search_results: sortRows(result, sorter, true) });
  });
  app.get('/order/shops/events', async (c) => c.json(await events(c.get('db'))));
  app.get('/order/shop/:orderableShopId/events', async (c) => c.json(await events(c.get('db'), integer(c.req.param('orderableShopId')))));
  app.get('/order/shop/:orderableShopId/summary', async (c) => c.json(await summary(c.get('db'), integer(c.req.param('orderableShopId')))));
  app.get('/order/shop/:orderableShopId/detail', async (c) => c.json(await detail(c.get('db'), integer(c.req.param('orderableShopId')))));
  app.get('/order/shop/:orderableShopId/delivery', async (c) => {
    const id = integer(c.req.param('orderableShopId'));
    await getOrderableShop(c.get('db'), id);
    const [option] = await c.get('db').select({ campus_delivery: s.orderable_shop_delivery_option.campus_delivery, off_campus_delivery: s.orderable_shop_delivery_option.off_campus_delivery })
      .from(s.orderable_shop_delivery_option).where(eq(s.orderable_shop_delivery_option.orderable_shop_id, id)).limit(1);
    if (!option) throw missingShop();
    return c.json(option);
  });
  app.get('/order/shop/:orderableShopId/menus/groups', async (c) => {
    const groups = await menuGroups(c.get('db'), integer(c.req.param('orderableShopId')));
    return c.json({ count: groups.length, menu_groups: groups });
  });
  app.get('/order/shop/:orderableShopId/menus', async (c) => c.json(await shopMenus(c.get('db'), integer(c.req.param('orderableShopId')))));
  app.get('/order/shop/:orderableShopId/menus/:orderableShopMenuId', async (c) => {
    integer(c.req.param('orderableShopId'));
    const { menu, images, prices, option_groups } = await getOrderableMenu(c.get('db'), integer(c.req.param('orderableShopMenuId')));
    return c.json({ id: menu.id, name: menu.name, description: menu.description, images: images.map((image) => image.image_url),
      prices: prices.map(({ id, name, price }) => ({ id, name, price })),
      option_groups: option_groups.map(({ id, name, description, is_required, min_select, max_select, options }) => ({
        id, name, description, is_required, min_select, max_select, options: options.map(({ id, name, price }) => ({ id, name, price })),
      })),
    });
  });
  app.get('/owner/order/shops', async (c) => {
    const owner = requirePrincipal(c, ['OWNER']);
    const shops = await c.get('db').select({ orderable_shop_id: s.orderable_shop.id, shop_id: s.shops.id, name: s.shops.name,
      address: s.shops.address, is_open: s.shop_operation.is_open }).from(s.orderable_shop)
      .innerJoin(s.shops, eq(s.shops.id, s.orderable_shop.shop_id))
      .leftJoin(s.shop_operation, and(eq(s.shop_operation.shop_id, s.shops.id), eq(s.shop_operation.is_deleted, false)))
      .where(and(eq(s.shops.owner_id, owner.id), eq(s.shops.is_deleted, false), eq(s.orderable_shop.is_deleted, false))).orderBy(asc(s.shops.name));
    return c.json({ total_count: shops.length, shops: shops.map((shop) => ({ ...shop, is_open: shop.is_open ?? false })) });
  });
  app.patch('/owner/order/shop/:orderableShopId/open', async (c) => {
    const owner = requirePrincipal(c, ['OWNER']);
    const body = await c.req.json<{ is_open?: unknown } | null>();
    if (typeof body?.is_open !== 'boolean') throw new ApiError(400, 'INVALID_REQUEST_BODY', '잘못된 입력값이 포함되어 있습니다.', [{ field: 'is_open', message: '영업 여부는 필수입니다.', constraint: 'NotNull' }]);
    const id = integer(c.req.param('orderableShopId'));
    const db = c.get('db');
    const { shop, operation } = await getOrderableShop(db, id);
    if (shop.owner_id !== owner.id) throw new ApiError(403, 'FORBIDDEN_SHOP_OWNER', '상점의 사장님이 아닙니다.');
    if (!operation) throw missingShop();
    const updated = await db.update(s.shop_operation).set({ is_open: body.is_open, updated_at: sql`CURRENT_TIMESTAMP` })
      .where(and(eq(s.shop_operation.id, operation.id), eq(s.shop_operation.is_deleted, false), sql`exists (select 1 from ${s.shops} where ${s.shops.id}=${s.shop_operation.shop_id} and ${s.shops.owner_id}=${owner.id} and ${s.shops.is_deleted}=0)`,
        sql`exists (select 1 from ${s.orderable_shop} where ${s.orderable_shop.id}=${id} and ${s.orderable_shop.shop_id}=${s.shop_operation.shop_id} and ${s.orderable_shop.is_deleted}=0)`))
      .returning({ id: s.shop_operation.id });
    if (!updated.length) throw new ApiError(403, 'FORBIDDEN_SHOP_OWNER', '상점의 사장님이 아닙니다.');
    return c.body(null, 200);
  });
}
