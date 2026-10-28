import { sql } from 'drizzle-orm';
import { schema } from '@api/db/schema';
import { catalogDate, kstDate, rows, shop, type CatalogContext, type Shop } from '@api/domains/commerce/catalog-shared';
import { menuCategories } from '@api/domains/commerce/catalog-menu';

const KST_OFFSET_MS = 9 * 3600000;
const DAY_SECONDS = 86400;

export const weekDays = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

export interface Opening { day_of_week: string; closed: boolean; open_time: string | null; close_time: string | null }

export interface ShopStatistics { average_rate: number; review_count: number; is_event: boolean }

export interface ShopListItem extends ShopStatistics {
  category_ids: number[];
  delivery: boolean;
  id: number;
  name: string;
  pay_bank: boolean;
  pay_card: boolean;
  phone: string | null;
  open: Opening[];
  is_open: boolean;
  benefit_details: (string | null)[];
  images: string[];
}

function secondsOfDay(time: string): number {
  const [hours = 0, minutes = 0, seconds = 0] = time.split(':').map(Number);
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * KST 기준 현재 영업 중인지 판단한다. 전날 영업시간이 자정을 넘기는 경우(예: 금요일 22:00~02:00)도
 * 포함하기 위해 전날 요일의 시간표를 하루 앞당겨 함께 본다.
 */
export function isCatalogShopOpen(openings: readonly Opening[], instant = Date.now()): boolean {
  const now = new Date(instant + KST_OFFSET_MS);
  const day = now.getUTCDay();
  const seconds = now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds() + now.getUTCMilliseconds() / 1000;
  return openings.some((open) => {
    if (open.closed || open.open_time === null || open.close_time === null) return false;
    const previous = open.day_of_week === weekDays[(day + 6) % 7];
    if (open.day_of_week !== weekDays[day] && !previous) return false;
    const start = secondsOfDay(open.open_time) - (previous ? DAY_SECONDS : 0);
    let end = secondsOfDay(open.close_time) - (previous ? DAY_SECONDS : 0);
    if (end <= start) end += DAY_SECONDS;
    return seconds >= start && seconds <= end;
  });
}

export function sanitizeCatalogSearch(keyword: string): string[] {
  return keyword.trim().split(/\s+/).map((word) => word.replace(/[^가-힣a-zA-Z0-9]/g, '')).filter(Boolean);
}

export async function shopOpenings(c: CatalogContext, id: number): Promise<Opening[]> {
  const values = await rows<Opening>(c, sql`select day_of_week,closed,open_time,close_time from ${schema.shop_opens} where shop_id=${id} and is_deleted=0 order by case day_of_week when 'MONDAY' then 1 when 'TUESDAY' then 2 when 'WEDNESDAY' then 3 when 'THURSDAY' then 4 when 'FRIDAY' then 5 when 'SATURDAY' then 6 else 7 end,open_time`);
  return values.map((row) => ({ ...row, closed: !!row.closed, open_time: row.open_time?.slice(0, 5) ?? null, close_time: row.close_time?.slice(0, 5) ?? null }));
}

export async function shopImages(c: CatalogContext, id: number): Promise<string[]> {
  return (await rows<{ image_url: string }>(c, sql`select image_url from ${schema.shop_images} where shop_id=${id} order by id`)).map((row) => row.image_url);
}

export async function shopCategories(c: CatalogContext, id: number) {
  return rows<{ id: number; name: string }>(c, sql`select sc.id,sc.name from ${schema.shop_categories} sc join ${schema.shop_category_map} cm on cm.shop_category_id=sc.id where cm.shop_id=${id} order by cm.id`);
}

export async function shopStatistics(c: CatalogContext, id: number): Promise<ShopStatistics> {
  const date = kstDate();
  const [stats] = await rows<{ average_rate: number; review_count: number; is_event: number }>(c, sql`select round(coalesce(avg(rating),0),1) as average_rate,count(*) as review_count,exists(select 1 from ${schema.event_articles} where shop_id=${id} and is_deleted=0 and start_date<=${date} and end_date>=${date}) as is_event from ${schema.shop_reviews} where shop_id=${id} and is_deleted=0`);
  return { average_rate: stats!.average_rate, review_count: stats!.review_count, is_event: !!stats!.is_event };
}

export async function shopDetail(c: CatalogContext, id: number, v2 = false) {
  const found = await shop(c, id);
  const [open, images, categories, menuGroups, stats] = await Promise.all([
    shopOpenings(c, id), shopImages(c, id), shopCategories(c, id), menuCategories(c, id), shopStatistics(c, id),
  ]);
  const today = open.find((row) => row.day_of_week === weekDays[new Date(Date.now() + KST_OFFSET_MS).getUTCDay()]);
  return {
    address: found.address,
    delivery: !!found.delivery,
    delivery_price: found.delivery_price,
    description: found.description?.trim() ? found.description : '-',
    id: found.id,
    image_urls: images,
    menu_categories: menuGroups.menu_categories,
    name: found.name,
    open,
    pay_bank: !!found.pay_bank,
    pay_card: !!found.pay_card,
    phone: found.phone,
    main_category_id: found.main_category_id,
    shop_categories: categories,
    updated_at: catalogDate(found.updated_at),
    is_event: stats.is_event,
    bank: found.bank,
    account_number: found.account_number,
    ...(v2 ? { open_time: today?.open_time ?? null, close_time: today?.close_time ?? null } : {}),
  };
}

export async function shopListItem(c: CatalogContext, found: Shop): Promise<ShopListItem> {
  const [open, categories, stats, images, benefits] = await Promise.all([
    shopOpenings(c, found.id),
    shopCategories(c, found.id),
    shopStatistics(c, found.id),
    shopImages(c, found.id),
    rows<{ detail: string | null }>(c, sql`select detail from ${schema.shop_benefit_category_map} where shop_id=${found.id}`),
  ]);
  return {
    category_ids: categories.map((row) => row.id),
    delivery: !!found.delivery,
    id: found.id,
    name: found.name,
    pay_bank: !!found.pay_bank,
    pay_card: !!found.pay_card,
    phone: found.phone,
    open,
    ...stats,
    is_open: isCatalogShopOpen(open),
    benefit_details: benefits.map((row) => row.detail),
    images,
  };
}
