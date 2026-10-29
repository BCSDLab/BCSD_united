import { sql, type SQL } from 'drizzle-orm';
import type { Hono } from 'hono';
import { requirePrincipal } from '@api/auth';
import { schema } from '@api/db/schema';
import type { ApiEnv } from '@api/runtime';
import {
  array,
  atomic,
  body,
  boolean,
  catalogError,
  catalogNow,
  ids,
  integer,
  invalid,
  object,
  outbox,
  ownerCondition,
  rows,
  shop,
  signalCatalogJobs,
  sqlList,
  strings,
  text,
  type CatalogContext,
  type JsonObject,
  type Shop,
} from '@api/domains/commerce/catalog-shared';
import {
  sanitizeCatalogSearch,
  shopDetail,
  shopImages,
  shopListItem,
  shopStatistics,
  weekDays,
  type ShopListItem,
} from '@api/domains/commerce/catalog-data';
import { registerCatalogMenus } from '@api/domains/commerce/catalog-menu';
import { registerCatalogReviews } from '@api/domains/commerce/catalog-review';
import { registerCatalogEvents } from '@api/domains/commerce/catalog-event';
import { registerCatalogBenefits } from '@api/domains/commerce/catalog-benefit';
import { registerCommerceCatalogAdmin } from '@api/domains/commerce/catalog-admin';
export { shopDetail } from '@api/domains/commerce/catalog-data';
export { handleCommerceCatalogJob, runCommerceCatalogCron } from '@api/domains/commerce/catalog-jobs';

const LIST_SORTERS = ['NONE', 'COUNT', 'COUNT_ASC', 'COUNT_DESC', 'RATING', 'RATING_ASC', 'RATING_DESC'];
const DEFAULT_MENU_CATEGORIES = ['추천 메뉴', '메인 메뉴', '세트 메뉴', '사이드 메뉴'];
const DELIVERY_OPTIONS = ['CAMPUS', 'OUTSIDE', 'BOTH'];
const REVIEW_PROMPT_DELAY_MS = 3600000;
const REQUEST_GUARD_MS = 300;

/** 영업 중인 상점이 항상 앞이고, 그 안에서만 `sorter`가 적용된다. v1은 정렬 파라미터를 무시한다. */
function listComparator(version: 1 | 2 | 3, sorter: string) {
  return (a: ShopListItem, b: ShopListItem): number => {
    const openFirst = Number(b.is_open) - Number(a.is_open);
    if (openFirst || version === 1 || sorter === 'NONE') return openFirst;
    const difference = sorter.startsWith('COUNT') ? a.review_count - b.review_count : a.average_rate - b.average_rate;
    return difference * (sorter.endsWith('_ASC') ? 1 : -1);
  };
}

async function list(c: CatalogContext, version: 1 | 2 | 3) {
  const sorter = c.req.query('sorter') ?? 'NONE';
  if (!LIST_SORTERS.includes(sorter)) invalid('sorter', '유효하지 않은 정렬입니다.');
  const filters = (c.req.queries('filter') ?? []).flatMap((value) => value.split(',')).filter(Boolean);
  if (filters.some((value) => value !== 'OPEN' && value !== 'DELIVERY'))
    catalogError(400, '', '유효하지 않은 필터입니다.');
  const query = (c.req.query('query') ?? '').replaceAll(' ', '');
  // v3는 주문 가능 상점(orderable_shop)을 뺀 일반 상점만 보여준다.
  const excludeOrderable =
    version === 3
      ? sql`and not exists(select 1 from ${schema.orderable_shop} o where o.shop_id=s.id and o.is_deleted=0)`
      : sql``;
  const shops = await rows<Shop>(
    c,
    sql`select * from ${schema.shops} s where is_deleted=0 ${excludeOrderable} order by id`,
  );
  const menus =
    version === 1
      ? []
      : await rows<{ shop_id: number; name: string }>(c, sql`select shop_id,name from ${schema.shop_menus}`);
  const matches = (found: Shop) =>
    version === 1 ||
    found.name.includes(query) ||
    menus.some((menu) => menu.shop_id === found.id && menu.name.includes(query));
  let items = await Promise.all(shops.filter(matches).map((found) => shopListItem(c, found)));
  if (version !== 1) {
    items = items.filter(
      (item) => (!filters.includes('OPEN') || item.is_open) && (!filters.includes('DELIVERY') || item.delivery),
    );
  }
  items.sort(listComparator(version, sorter));
  const result = items.map(({ average_rate, review_count, benefit_details, images, ...base }) => {
    if (version === 1) return base;
    return { ...base, average_rate, review_count, benefit_details, ...(version === 3 ? { images } : {}) };
  });
  return { count: result.length, shops: result };
}

function openTime(value: unknown, field: string): string | null {
  if (value == null) return null;
  const time = text(value, field);
  if (!/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time)) invalid(field, '시간 형식이 올바르지 않습니다.');
  return time.length === 5 ? `${time}:00` : time;
}

function openingHours(value: unknown, editing: boolean) {
  return array(value, 'open', editing ? 0 : 7, editing ? 100 : 7).map((entry) => {
    const item = object(entry);
    const day = text(item.day_of_week, 'day_of_week');
    if (!weekDays.includes(day)) invalid('day_of_week', '올바르지 않은 요일입니다.');
    const closed = boolean(item.closed, 'closed');
    return { day, closed, open: openTime(item.open_time, 'open_time'), close: openTime(item.close_time, 'close_time') };
  });
}

/** 생성(`id` 없음)과 수정이 검증 규칙을 공유한다. 수정은 주소·전화를 비울 수 있고 계좌 정보를 받는다. */
async function saveOwnerShop(c: CatalogContext, b: JsonObject, id?: number) {
  const owner = requirePrincipal(c, ['OWNER']);
  if (id) await shop(c, id, true);
  const name = text(b.name, 'name', 1, 50);
  const address = b.address == null && id ? null : text(b.address, 'address');
  const phone = b.phone == null && id ? null : text(b.phone, 'phone', id ? 0 : 1, 50);
  if (!id && !/^\d{3}-\d{3,4}-\d{4}$/.test(phone!)) invalid('phone', '전화번호 형식이 올바르지 않습니다.');
  const description = text(b.description, 'description', 0);
  const mainCategory = integer(b.main_category_id, 'main_category_id');
  const [category] = await rows<{ id: number }>(
    c,
    sql`select id from ${schema.shop_categories} where id=${mainCategory}`,
  );
  if (!category) catalogError(404, '', `존재하지 않는 상점 카테고리입니다. shopCategoryId: ${mainCategory}`);
  const categoryIds = ids(b.category_ids, 'category_ids', 1);
  const categories = await rows<{ id: number }>(
    c,
    sql`select id from ${schema.shop_categories} where id in (${sqlList(categoryIds)})`,
  );
  const images = strings(b.image_urls, 'image_urls');
  const opens = openingHours(b.open, !!id);
  const delivery = boolean(b.delivery, 'delivery');
  const deliveryPrice = integer(b.delivery_price, 'delivery_price', 0);
  const payBank = boolean(b.pay_bank, 'pay_bank');
  const payCard = boolean(b.pay_card, 'pay_card');
  const bank = id && b.bank != null ? text(b.bank, 'bank', 0, 10) : null;
  const account = id && b.account_number != null ? text(b.account_number, 'account_number', 0, 20) : null;
  const now = catalogNow();
  const shopId = id ? sql`${id}` : sql`(select max(id) from ${schema.shops})`;
  const statements: SQL[] = id
    ? [
        sql`update ${schema.shops} set name=${name},address=${address},phone=${phone},description=${description},main_category_id=${mainCategory},delivery=${Number(delivery)},delivery_price=${deliveryPrice},pay_bank=${Number(payBank)},pay_card=${Number(payCard)},bank=${bank},account_number=${account},updated_at=${now} where id=${id} and owner_id=${owner.id}`,
        sql`delete from ${schema.shop_images} where shop_id=${id}`,
        sql`delete from ${schema.shop_opens} where shop_id=${id}`,
        sql`delete from ${schema.shop_category_map} where shop_id=${id}`,
      ]
    : [
        sql`insert into ${schema.shops} (owner_id,name,internal_name,chosung,address,phone,description,main_category_id,delivery,delivery_price,pay_bank,pay_card,is_deleted,is_event,remarks,hit,created_at,updated_at) values (${owner.id},${name},${name},${name.slice(0, 1)},${address},${phone},${description},${mainCategory},${Number(delivery)},${deliveryPrice},${Number(payBank)},${Number(payCard)},0,0,'',0,${now},${now})`,
      ];
  if (!id) {
    statements.push(
      ...DEFAULT_MENU_CATEGORIES.map(
        (categoryName) =>
          sql`insert into ${schema.shop_menu_categories} (shop_id,name,is_deleted,created_at,updated_at) values (${shopId},${categoryName},0,${now},${now})`,
      ),
    );
  }
  statements.push(
    ...images.map(
      (image) =>
        sql`insert into ${schema.shop_images} (shop_id,image_url,created_at,updated_at) values (${shopId},${image},${now},${now})`,
    ),
  );
  statements.push(
    ...opens.map(
      (open) =>
        sql`insert into ${schema.shop_opens} (shop_id,day_of_week,closed,open_time,close_time,is_deleted,created_at,updated_at) values (${shopId},${open.day},${Number(open.closed)},${open.open},${open.close},0,${now},${now})`,
    ),
  );
  statements.push(
    ...categories.map(
      (row) =>
        sql`insert into ${schema.shop_category_map} (shop_id,shop_category_id,created_at,updated_at) values (${shopId},${row.id},${now},${now})`,
    ),
  );
  await atomic(c.env, statements, id ? ownerCondition(c, id) : undefined);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function registerCommerceCatalog(app: Hono<ApiEnv>): void {
  registerCatalogMenus(app);
  registerCatalogReviews(app);
  registerCatalogEvents(app);
  registerCatalogBenefits(app);
  registerCommerceCatalogAdmin(app);

  app.get('/shops', async (c) => c.json(await list(c, 1)));
  app.get('/v2/shops', async (c) => c.json(await list(c, 2)));
  app.get('/v3/shops', async (c) => c.json(await list(c, 3)));
  app.get('/shops/count', async (c) => {
    const result = await list(c, 1);
    return c.json({ total_count: result.count, open_count: result.shops.filter((item) => item.is_open).length });
  });
  app.get('/shops/categories', async (c) => {
    const shop_categories = await rows<{ id: number; name: string; image_url: string | null }>(
      c,
      sql`select id,name,image_url from ${schema.shop_categories} order by order_index`,
    );
    return c.json({ count: shop_categories.length, shop_categories });
  });
  app.get('/shops/:id/summary', async (c) => {
    const found = await shop(c, integer(c.req.param('id')));
    const stats = await shopStatistics(c, found.id);
    const images = (await shopImages(c, found.id)).map((image_url, index) => ({
      image_url,
      is_thumbnail: index === 0,
    }));
    return c.json({
      shop_id: found.id,
      name: found.name,
      introduction: found.introduction,
      rating_average: stats.average_rate,
      review_count: stats.review_count,
      images,
    });
  });
  app.get('/shops/:id', async (c) => c.json(await shopDetail(c, integer(c.req.param('id')))));
  app.get('/v2/shops/search/related', async (c) => {
    const keyword = text(c.req.query('keyword'), 'keyword', 0);
    const keys = sanitizeCatalogSearch(keyword);
    const shopNames = keys.length
      ? sql.join(
          keys.map(
            (key) => sql`(instr(lower(s.name),lower(${key}))>0 or instr(lower(s.internal_name),lower(${key}))>0)`,
          ),
          sql` or `,
        )
      : sql`0`;
    const menuNames = keys.length
      ? sql.join(
          keys.map((key) => sql`instr(lower(m.name),lower(${key}))>0`),
          sql` or `,
        )
      : sql`0`;
    const shop_name_search_results = await rows<{ shop_id: number; shop_name: string }>(
      c,
      sql`select s.id as shop_id,s.name as shop_name from ${schema.shops} s where s.is_deleted=0 and (${shopNames}) order by s.id`,
    );
    const menu_name_search_results = await rows<{ shop_id: number; shop_name: string; menu_name: string }>(
      c,
      sql`select s.id as shop_id,s.name as shop_name,m.name as menu_name from ${schema.shop_menus} m join ${schema.shops} s on s.id=m.shop_id where s.is_deleted=0 and (${menuNames}) order by m.id`,
    );
    return c.json({
      search_keyword: keyword,
      processed_search_keyword: keys.join(' '),
      shop_name_search_result_count: shop_name_search_results.length,
      menu_name_search_result_count: menu_name_search_results.length,
      shop_name_search_results,
      menu_name_search_results,
    });
  });
  app.get('/v2/shops/:id', async (c) => c.json(await shopDetail(c, integer(c.req.param('id')), true)));
  app.get('/shops/search/related/:query', async (c) => {
    const query = c.req.param('query').replaceAll(' ', '');
    const shops = await rows<Shop>(c, sql`select * from ${schema.shops} where is_deleted=0`);
    const menus = await rows<{ shop_id: number; name: string }>(c, sql`select shop_id,name from ${schema.shop_menus}`);
    const keywords = await rows<{ keyword: string }>(
      c,
      sql`select distinct keyword from ${schema.shop_menu_search_keywords} where instr(keyword,${query})>0`,
    );
    const compare = (a: { keyword: string }, b: { keyword: string }) =>
      a.keyword < b.keyword ? -1 : a.keyword > b.keyword ? 1 : 0;
    const names = shops
      .filter((found) => found.name.includes(query))
      .map((found) => ({ keyword: found.name, shop_ids: [] as number[], shop_id: found.id }))
      .sort(compare);
    const menuKeys = keywords
      .map((row) => ({
        keyword: row.keyword,
        shop_ids: shops
          .filter(
            (found) =>
              found.name.includes(row.keyword) ||
              menus.some((menu) => menu.shop_id === found.id && menu.name.includes(row.keyword)),
          )
          .map((found) => found.id),
        shop_id: null,
      }))
      .filter((key) => key.shop_ids.length)
      .sort(compare);
    // 이름이 같은 상점은 정렬 후 첫 항목만 남긴다.
    const uniqueNames = names.filter((item, index) => !index || names[index - 1]!.keyword !== item.keyword);
    return c.json({ keywords: [...uniqueNames, ...menuKeys].slice(0, 5) });
  });
  app.post('/shops/:shopId/call-notification', async (c) => {
    const principal = requirePrincipal(c, ['GENERAL', 'STUDENT', 'COUNCIL']);
    const found = await shop(c, integer(c.req.param('shopId')));
    const subscriptions = await rows<{ id: string }>(
      c,
      sql`select id from ${schema.notification_subscribe} where user_id=${principal.id} and subscribe_type='REVIEW_PROMPT' and detail_type is null limit 1`,
    );
    if (subscriptions.length) {
      const job = {
        kind: 'commerce.catalog.review-prompt',
        key: `review-prompt:${principal.id}:${found.id}`,
        dueAt: Date.now() + REVIEW_PROMPT_DELAY_MS,
      };
      await atomic(c.env, [outbox(job.kind, { shopId: found.id, userId: principal.id }, job.dueAt, job.key)]);
      signalCatalogJobs(c, [job]);
    }
    return c.body(null, 200);
  });
  app.get('/owner/shops', async (c) => {
    const owner = requirePrincipal(c, ['OWNER']);
    const shops = await rows<Shop>(c, sql`select * from ${schema.shops} where owner_id=${owner.id} and is_deleted=0`);
    const result = await Promise.all(
      shops.map(async (found) => ({
        id: found.id,
        name: found.name,
        is_event: (await shopStatistics(c, found.id)).is_event,
      })),
    );
    return c.json({ count: result.length, shops: result });
  });
  app.post('/owner/shops', async (c) => {
    requirePrincipal(c, ['OWNER']);
    await saveOwnerShop(c, await body(c));
    return c.body(null, 201);
  });
  app.get('/owner/shops/:id', async (c) => {
    const found = await shop(c, integer(c.req.param('id')), true);
    return c.json(await shopDetail(c, found.id));
  });
  app.put('/owner/shops/:id', async (c) => {
    requirePrincipal(c, ['OWNER']);
    await saveOwnerShop(c, await body(c), integer(c.req.param('id')));
    return c.body(null, 201);
  });
  app.post('/owner/shops/:shopId/order-service-requests', async (c) => {
    const owner = requirePrincipal(c, ['OWNER']);
    const found = await shop(c, integer(c.req.param('shopId')));
    if (found.owner_id !== owner.id) catalogError(403, 'FORBIDDEN_SHOP_OWNER', '상점의 사장님이 아닙니다.');
    const b = await body(c);
    const option = text(b.delivery_option, 'delivery_option');
    if (!DELIVERY_OPTIONS.includes(option)) invalid('delivery_option', '올바르지 않은 배달 옵션입니다.');
    const minimum = integer(b.minimum_order_amount, 'minimum_order_amount', 0);
    const takeout = boolean(b.is_takeout, 'is_takeout');
    const campus = integer(b.campus_delivery_tip, 'campus_delivery_tip', 0);
    const outside = integer(b.off_campus_delivery_tip, 'off_campus_delivery_tip', 0);
    const license = text(b.business_license_url, 'business_license_url');
    const certificate = text(b.business_certificate_url, 'business_certificate_url');
    const bankCopy = text(b.bank_copy_url, 'bank_copy_url');
    const bank = text(b.bank, 'bank', 1, 10);
    const account = text(b.account_number, 'account_number', 1, 20);
    // 가드 키는 Java 서버의 요청 DTO `toString()` 문자열을 그대로 해시한 값이라 양쪽이 같은 중복 판정을 한다.
    const sourceKey = `${owner.id}:${found.id}:ShopOrderServiceRequestRequest[minimumOrderAmount=${minimum}, isTakeout=${takeout}, deliveryOption=${option}, campusDeliveryTip=${campus}, offCampusDeliveryTip=${outside}, businessLicenseUrl=${license}, businessCertificateUrl=${certificate}, bankCopyUrl=${bankCopy}, bank=${bank}, accountNumber=${account}]`;
    const key = await sha256Hex(sourceKey);
    const guardTime = Date.now();
    const guard = await rows<{ key: string }>(
      c,
      sql`insert into ${schema.native_catalog_request_guard} (key,user_id,expires_at) values (${key},${owner.id},${guardTime + REQUEST_GUARD_MS}) on conflict(key) do update set expires_at=excluded.expires_at where expires_at<=${guardTime} returning key`,
    );
    if (!guard.length) catalogError(409, 'REQUEST_TOO_FAST', '요청이 너무 빠릅니다. 다시 요청해주세요.');
    const existing = await rows<{ request_status: string }>(
      c,
      sql`select request_status from ${schema.shop_order_service_requests} where shop_id=${found.id} and request_status in ('PENDING','APPROVED')`,
    );
    if (existing.some((row) => row.request_status === 'PENDING'))
      catalogError(409, 'DUPLICATE_REQUESTED_ORDERABLE_SHOP', '이미 전환 신청이 접수된 상점입니다.');
    if (existing.length) catalogError(409, 'DUPLICATE_ORDERABLE_SHOP', '이미 주문 가능한 상점입니다.');
    const now = catalogNow();
    const result = await atomic(c.env, [
      sql`insert into ${schema.shop_order_service_requests} (shop_id,minimum_order_amount,is_takeout,delivery_option,campus_delivery_tip,off_campus_delivery_tip,business_license_url,business_certificate_url,bank_copy_url,bank,account_number,request_status,created_at,updated_at) select ${found.id},${minimum},${Number(takeout)},${option},${campus},${outside},${license},${certificate},${bankCopy},${bank},${account},'PENDING',${now},${now} where not exists(select 1 from ${schema.shop_order_service_requests} where shop_id=${found.id} and request_status in ('PENDING','APPROVED'))`,
    ]);
    if (!result[0]?.meta.changes)
      catalogError(409, 'DUPLICATE_REQUESTED_ORDERABLE_SHOP', '이미 전환 신청이 접수된 상점입니다.');
    return c.body(null, 201);
  });
}
