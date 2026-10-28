import { sql, type SQL } from 'drizzle-orm';
import type { Hono } from 'hono';
import { requirePrincipal } from '@api/auth';
import { schema } from '@api/db/schema';
import type { ApiEnv } from '@api/runtime';
import {
  array, atomic, body, catalogError, catalogNow, ids, integer, object, rows, sqlList, text,
  type CatalogContext, type JsonObject, type Shop,
} from '@api/domains/commerce/catalog-shared';
import { shopListItem } from '@api/domains/commerce/catalog-data';
import { catalogAdminAudit } from '@api/domains/commerce/catalog-admin';

type Benefit = Pick<typeof schema.shop_benefit_categories.$inferSelect, 'id' | 'title' | 'detail' | 'on_image_url' | 'off_image_url'>;
interface ShopDetailInput { id: number; detail: string }

const BENEFIT_COLUMNS = sql`id,title,detail,on_image_url,off_image_url`;
const DUPLICATE_MESSAGE = '이미 존재하는 혜택 카테고리입니다. 이미 존재하는 혜택 카테고리입니다.';
const MAX_BENEFITS = 6;
const MIN_BENEFITS = 2;

async function category(c: CatalogContext, id: number): Promise<Benefit> {
  const [value] = await rows<Benefit>(c, sql`select ${BENEFIT_COLUMNS} from ${schema.shop_benefit_categories} where id=${id}`);
  if (!value) catalogError(404, '', `해당 ID의 혜택 카테고리가 존재하지 않습니다. benefitId: ${id}`);
  return value;
}

/** 사전 검사를 통과한 동시 요청은 DB 트리거(`CATALOG_BENEFIT_*`)가 막으므로 그 실패를 같은 응답으로 바꾼다. */
async function benefitWrite(c: CatalogContext, statements: SQL[]) {
  try {
    return await atomic(c.env, statements);
  } catch (error) {
    const message = String(error);
    if (message.includes('CATALOG_BENEFIT_LIMIT')) catalogError(400, '', '혜택 카테고리의 개수가 제한을 초과하였습니다.');
    if (message.includes('CATALOG_BENEFIT_DUPLICATE')) catalogError(409, '', DUPLICATE_MESSAGE);
    throw error;
  }
}

async function saveCategory(c: CatalogContext, b: JsonObject, id?: number) {
  const title = text(b.title, 'title', 5, 20);
  const detail = text(b.detail, 'detail', 10, 100);
  const onImage = text(b.on_image_url, 'on_image_url');
  const offImage = text(b.off_image_url, 'off_image_url');
  const all = await rows<Benefit>(c, sql`select ${BENEFIT_COLUMNS} from ${schema.shop_benefit_categories}`);
  if (all.some((benefit) => benefit.title === title && benefit.id !== id)) catalogError(409, '', DUPLICATE_MESSAGE);
  if (!id && all.length >= MAX_BENEFITS) catalogError(400, '', '혜택 카테고리의 개수가 제한을 초과하였습니다. 최대 혜택 수는 6개 입니다.');
  if (id) await category(c, id);
  const now = catalogNow();
  const write = id
    ? sql`update ${schema.shop_benefit_categories} set title=${title},detail=${detail},on_image_url=${onImage},off_image_url=${offImage},updated_at=${now} where id=${id} returning ${BENEFIT_COLUMNS}`
    : sql`insert into ${schema.shop_benefit_categories} (title,detail,on_image_url,off_image_url,created_at,updated_at) values (${title},${detail},${onImage},${offImage},${now},${now}) returning ${BENEFIT_COLUMNS}`;
  const result = await benefitWrite(c, [write, catalogAdminAudit(c, 'BENEFITCATEGORIES', id ?? null, b)]);
  return result[0]!.results[0] as unknown as Benefit;
}

function shopDetails(value: unknown, field: string, idField: string): ShopDetailInput[] {
  return array(value, field).map((entry) => {
    const item = object(entry);
    return { id: integer(item[idField], idField), detail: text(item.detail, 'detail', 2, 20) };
  });
}

export function registerCatalogBenefits(app: Hono<ApiEnv>) {
  app.get('/benefit/categories', async (c) => c.json({ benefits: await rows<Benefit>(c, sql`select ${BENEFIT_COLUMNS} from ${schema.shop_benefit_categories} order by id`) }));
  app.get('/benefit/:id/shops', async (c) => {
    const id = integer(c.req.param('id'));
    const shops = await rows<Shop & { benefit_detail: string | null }>(c, sql`select s.*,b.detail as benefit_detail from ${schema.shop_benefit_category_map} b join ${schema.shops} s on s.id=b.shop_id where b.benefit_id=${id} and s.is_deleted=0`);
    const result = await Promise.all(shops.map(async (found) => {
      const { benefit_details: _benefits, images: _images, ...item } = await shopListItem(c, found);
      return { ...item, benefit_detail: found.benefit_detail };
    }));
    result.sort((a, b) => Number(b.is_open) - Number(a.is_open) || b.average_rate - a.average_rate || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return c.json({ count: result.length, shops: result });
  });
  app.get('/admin/benefit/categories', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    return c.json({ benefits: await rows<Benefit>(c, sql`select ${BENEFIT_COLUMNS} from ${schema.shop_benefit_categories} order by title`) });
  });
  app.post('/admin/benefit/categories', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    return c.json(await saveCategory(c, await body(c)), 201);
  });
  app.put('/admin/benefit/categories/:id', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    return c.json(await saveCategory(c, await body(c), integer(c.req.param('id'))));
  });
  app.delete('/admin/benefit/categories/:id', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const id = integer(c.req.param('id'));
    const [count] = await rows<{ n: number }>(c, sql`select count(*) n from ${schema.shop_benefit_categories}`);
    if (count!.n <= MIN_BENEFITS) catalogError(400, '', '혜택 카테고리의 개수가 제한을 초과하였습니다. 최소 혜택 수는2개 입니다.');
    await benefitWrite(c, [
      sql`delete from ${schema.shop_benefit_category_map} where benefit_id=${id}`,
      sql`delete from ${schema.shop_benefit_categories} where id=${id}`,
      catalogAdminAudit(c, 'BENEFITCATEGORIES', id),
    ]);
    return c.body(null, 204);
  });
  app.get('/admin/benefit/:id/shops/search', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const id = integer(c.req.param('id'));
    const query = text(c.req.query('search_keyword'), 'search_keyword', 0);
    const shops = await rows<{ id: number; name: string; included: number }>(c, sql`select s.id,s.name,exists(select 1 from ${schema.shop_benefit_category_map} b where b.shop_id=s.id and b.benefit_id=${id}) included from ${schema.shops} s where s.is_deleted=0 and instr(lower(s.name),lower(${query}))>0 order by s.name`);
    const summary = ({ id, name }: { id: number; name: string }) => ({ id, name });
    return c.json({
      benefit_shops: shops.filter((found) => found.included).map(summary),
      non_benefit_shops: shops.filter((found) => !found.included).map(summary),
    });
  });
  app.get('/admin/benefit/:id/shops', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const id = integer(c.req.param('id'));
    const shops = await rows<{ shop_benefit_map_id: number; id: number; name: string; detail: string | null }>(c, sql`select b.id shop_benefit_map_id,s.id,s.name,b.detail from ${schema.shop_benefit_category_map} b join ${schema.shops} s on s.id=b.shop_id where b.benefit_id=${id} and s.is_deleted=0 order by s.name`);
    return c.json({ count: shops.length, shops });
  });
  app.post('/admin/benefit/:id/shops', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const id = integer(c.req.param('id'));
    await category(c, id);
    const b = await body(c);
    const details = shopDetails(b.shop_details, 'shop_details', 'shop_id');
    const requested = ids(details.map((detail) => detail.id), 'shop_details');
    const shops = requested.length ? await rows<{ id: number; name: string }>(c, sql`select id,name from ${schema.shops} where id in (${sqlList(requested)}) and is_deleted=0`) : [];
    // 존재하지 않거나 삭제된 상점은 조용히 건너뛴다.
    const result = shops.map((found) => ({ ...found, detail: details.find((detail) => detail.id === found.id)!.detail }));
    const now = catalogNow();
    await atomic(c.env, [
      ...result.map((found) => sql`insert into ${schema.shop_benefit_category_map} (shop_id,benefit_id,detail,created_at,updated_at) values (${found.id},${id},${found.detail},${now},${now})`),
      catalogAdminAudit(c, 'BENEFIT', id, b),
    ]);
    return c.json({ shops: result }, 201);
  });
  app.put('/admin/benefit', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const b = await body(c);
    const details = shopDetails(b.modify_details, 'modify_details', 'shop_benefit_map_id');
    const requested = ids(details.map((detail) => detail.id), 'modify_details');
    const found = requested.length ? await rows<{ id: number }>(c, sql`select id from ${schema.shop_benefit_category_map} where id in (${sqlList(requested)})`) : [];
    const missing = requested.filter((id) => !found.some((row) => row.id === id));
    if (missing.length) catalogError(404, '', `해당 혜택 카테고리에 존재하지 않는 상점이 포함되어 있습니다. shopBenefitMapId: [${missing.join(', ')}] null`);
    await atomic(c.env, [
      ...details.map((detail) => sql`update ${schema.shop_benefit_category_map} set detail=${detail.detail},updated_at=${catalogNow()} where id=${detail.id}`),
      catalogAdminAudit(c, 'BENEFIT', null, b),
    ]);
    return c.body(null, 200);
  });
  app.delete('/admin/benefit/:id/shops', async (c) => {
    requirePrincipal(c, ['ADMIN']);
    const id = integer(c.req.param('id'));
    const b = await body(c);
    const shopIds = ids(b.shop_ids, 'shop_ids');
    await atomic(c.env, [
      ...(shopIds.length ? [sql`delete from ${schema.shop_benefit_category_map} where benefit_id=${id} and shop_id in (${sqlList(shopIds)})`] : []),
      catalogAdminAudit(c, 'BENEFIT', id, b),
    ]);
    return c.body(null, 204);
  });
}
