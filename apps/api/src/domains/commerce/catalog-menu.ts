import { sql, type SQL } from 'drizzle-orm';
import type { Hono } from 'hono';
import { requirePrincipal } from '@api/auth';
import { schema } from '@api/db/schema';
import type { ApiEnv } from '@api/runtime';
import {
  array, atomic, body, catalogDate, catalogError, catalogNow, ids, integer, invalid, menu, object, ownerCondition, rows, shop, sqlList, strings, text,
  type CatalogContext, type JsonObject,
} from '@api/domains/commerce/catalog-shared';

type Category = typeof schema.shop_menu_categories.$inferSelect;
interface MenuOption { option: string; price: number }

export async function menuCategories(c: CatalogContext, shopId: number) {
  const categories = await rows<Category>(c, sql`select * from ${schema.shop_menu_categories} where shop_id=${shopId} order by case name when '추천 메뉴' then 1 when '메인 메뉴' then 2 when '세트 메뉴' then 3 when '사이드 메뉴' then 4 else 5 end,id`);
  return { count: categories.length, menu_categories: categories.map(({ id, name }) => ({ id, name })) };
}

export async function menuDetail(c: CatalogContext, id: number) {
  const found = await menu(c, id);
  const [options, images, categories] = await Promise.all([
    rows<MenuOption>(c, sql`select option,price from ${schema.shop_menu_details} where shop_menu_id=${id} order by id`),
    rows<{ image_url: string }>(c, sql`select image_url from ${schema.shop_menu_images} where shop_menu_id=${id} order by id`),
    rows<{ shop_menu_category_id: number }>(c, sql`select shop_menu_category_id from ${schema.shop_menu_category_map} where shop_menu_id=${id} order by id`),
  ]);
  if (!options.length) catalogError(500, 'INTERNAL_SERVER_ERROR', '서버에 에러가 발생했습니다.');
  const single = options.length === 1;
  return {
    id: found.id,
    shop_id: found.shop_id,
    name: found.name,
    is_hidden: !!found.is_hidden,
    is_single: single,
    single_price: single ? options[0]!.price : null,
    option_prices: single ? null : options,
    description: found.description,
    category_ids: categories.map((row) => row.shop_menu_category_id),
    image_urls: images.map((row) => row.image_url),
  };
}

export async function menuList(c: CatalogContext, shopId: number) {
  const categories = await menuCategories(c, shopId);
  const maps = await rows<{ shop_menu_id: number; shop_menu_category_id: number; updated_at: string }>(c, sql`select cm.shop_menu_id,cm.shop_menu_category_id,m.updated_at from ${schema.shop_menu_category_map} cm join ${schema.shop_menus} m on m.id=cm.shop_menu_id join ${schema.shop_menu_categories} mc on mc.id=cm.shop_menu_category_id where mc.shop_id=${shopId} order by cm.id`);
  const menuIds = [...new Set(maps.map((row) => row.shop_menu_id))];
  const details = new Map(await Promise.all(menuIds.map(async (id) => [id, await menuDetail(c, id)] as const)));
  const groups = categories.menu_categories
    .map((category) => ({
      ...category,
      menus: maps
        .filter((row) => row.shop_menu_category_id === category.id)
        .map((row) => {
          const { shop_id: _shop, category_ids: _categories, ...detail } = details.get(row.shop_menu_id)!;
          return detail;
        }),
    }))
    .filter((category) => category.menus.length);
  const latestUpdate = maps.reduce((latest, row) => (row.updated_at > latest ? row.updated_at : latest), '');
  return { count: maps.length, menu_categories: groups, updated_at: maps.length ? catalogDate(latestUpdate) : '-999999999-01-01' };
}

function menuOptions(b: JsonObject, name: string, single: boolean): MenuOption[] {
  if (single) return [{ option: name, price: integer(b.single_price, 'single_price', 0) }];
  return array(b.option_prices, 'option_prices', 1).map((value) => {
    const item = object(value);
    const option = text(item.option, 'option', 0, 50);
    if (option.length === 0) invalid('option', '크기가 1에서 50 사이여야 합니다.');
    return { option, price: integer(item.price, 'price', 0) };
  });
}

export async function saveMenu(c: CatalogContext, shopId: number, b: JsonObject, menuId?: number, tail: SQL[] = []) {
  const name = text(b.name, 'name', 0, 25);
  if (name.length === 0) invalid('name', '메뉴명은 1자 이상 25자 이하로 입력해주세요.');
  const description = b.description == null ? null : text(b.description, 'description', 0, 80);
  const categoryIds = ids(b.category_ids, 'category_ids', 1);
  const images = strings(b.image_urls, 'image_urls', 3);
  const single = b.is_single === true;
  if (typeof b.is_single !== 'boolean') invalid('is_single', '단일 메뉴 여부는 필수입니다.');
  const options = menuOptions(b, name, single);
  if ((single && b.option_prices != null) || (!single && b.single_price != null)) invalid('is_single', '단일 메뉴와 옵션 가격이 일치하지 않습니다.');
  const categories = await rows<{ id: number }>(c, sql`select id from ${schema.shop_menu_categories} where id in (${sqlList(categoryIds)})`);
  const now = catalogNow();
  const id: SQL = menuId ? sql`${menuId}` : sql`(select max(id) from ${schema.shop_menus})`;
  const statements: SQL[] = menuId
    ? [
      sql`update ${schema.shop_menus} set name=${name},description=${description},updated_at=${now} where id=${menuId}`,
      sql`delete from ${schema.shop_menu_category_map} where shop_menu_id=${menuId}`,
      sql`delete from ${schema.shop_menu_images} where shop_menu_id=${menuId}`,
      sql`delete from ${schema.shop_menu_details} where shop_menu_id=${menuId}`,
    ]
    : [sql`insert into ${schema.shop_menus} (shop_id,name,description,is_hidden,is_deleted,created_at,updated_at) values (${shopId},${name},${description},0,0,${now},${now})`];
  statements.push(...categories.map((category) => sql`insert into ${schema.shop_menu_category_map} (shop_menu_id,shop_menu_category_id,created_at,updated_at) values (${id},${category.id},${now},${now})`));
  statements.push(...images.map((image) => sql`insert into ${schema.shop_menu_images} (shop_menu_id,image_url,created_at,updated_at) values (${id},${image},${now},${now})`));
  statements.push(...options.map((option) => sql`insert into ${schema.shop_menu_details} (shop_menu_id,option,price,created_at,updated_at) values (${id},${option.option},${option.price},${now},${now})`));
  statements.push(...tail);
  await atomic(c.env, statements, ownerCondition(c, shopId));
}

export async function deleteMenu(c: CatalogContext, id: number) {
  const existing = await menu(c, id);
  await atomic(c.env, [
    sql`delete from ${schema.shop_menu_category_map} where shop_menu_id=${id}`,
    sql`delete from ${schema.shop_menu_details} where shop_menu_id=${id}`,
    sql`delete from ${schema.shop_menu_images} where shop_menu_id=${id}`,
    sql`delete from ${schema.shop_menus} where id=${id}`,
  ], ownerCondition(c, existing.shop_id));
}

/** 인증 확인을 경로 파라미터 검사보다 먼저 해서 비로그인 요청이 400이 아닌 401을 받게 한다. */
async function ownedCategory(c: CatalogContext): Promise<Category> {
  requirePrincipal(c, ['OWNER']);
  const id = integer(c.req.param('categoryId'));
  const [category] = await rows<Category>(c, sql`select * from ${schema.shop_menu_categories} where id=${id}`);
  if (!category) catalogError(404, '', `존재하지 않는 메뉴 카테고리입니다. menuCategoryId: ${id}`);
  await shop(c, category.shop_id, true);
  return category;
}

export function registerCatalogMenus(app: Hono<ApiEnv>) {
  app.get('/shops/:shopId/menus/categories', async (c) => {
    const found = await shop(c, integer(c.req.param('shopId')));
    return c.json(await menuCategories(c, found.id));
  });
  app.get('/shops/:shopId/menus/:menuId', async (c) => c.json(await menuDetail(c, integer(c.req.param('menuId')))));
  app.get('/shops/:shopId/menus', async (c) => {
    const found = await shop(c, integer(c.req.param('shopId')));
    return c.json(await menuList(c, found.id));
  });
  app.get('/owner/shops/menus/categories', async (c) => {
    const found = await shop(c, integer(c.req.query('shopId')), true);
    return c.json(await menuCategories(c, found.id));
  });
  app.get('/owner/shops/menus', async (c) => {
    const found = await shop(c, integer(c.req.query('shopId')), true);
    return c.json(await menuList(c, found.id));
  });
  app.get('/owner/shops/menus/:menuId', async (c) => {
    const found = await menu(c, integer(c.req.param('menuId')), true);
    return c.json(await menuDetail(c, found.id));
  });
  app.post('/owner/shops/:shopId/menus', async (c) => {
    const found = await shop(c, integer(c.req.param('shopId')), true);
    await saveMenu(c, found.id, await body(c));
    return c.body(null, 201);
  });
  app.put('/owner/shops/menus/:menuId', async (c) => {
    const found = await menu(c, integer(c.req.param('menuId')), true);
    await saveMenu(c, found.shop_id, await body(c), found.id);
    return c.body(null, 201);
  });
  app.delete('/owner/shops/menus/:menuId', async (c) => {
    const found = await menu(c, integer(c.req.param('menuId')), true);
    await deleteMenu(c, found.id);
    return c.body(null, 204);
  });
  app.post('/owner/shops/:shopId/menus/categories', async (c) => {
    const found = await shop(c, integer(c.req.param('shopId')), true);
    const name = text((await body(c)).name, 'name', 1, 20);
    const now = catalogNow();
    await atomic(c.env, [sql`insert into ${schema.shop_menu_categories} (shop_id,name,is_deleted,created_at,updated_at) values (${found.id},${name},0,${now},${now})`], ownerCondition(c, found.id));
    return c.body(null, 201);
  });
  app.put('/owner/shops/menus/categories/:categoryId', async (c) => {
    const category = await ownedCategory(c);
    const name = text((await body(c)).name, 'name', 1, 20);
    await atomic(c.env, [sql`update ${schema.shop_menu_categories} set name=${name},updated_at=${catalogNow()} where id=${category.id}`], ownerCondition(c, category.shop_id));
    return c.body(null, 201);
  });
  app.delete('/owner/shops/menus/categories/:categoryId', async (c) => {
    const category = await ownedCategory(c);
    await atomic(c.env, [
      sql`delete from ${schema.shop_menu_category_map} where shop_menu_category_id=${category.id}`,
      sql`delete from ${schema.shop_menu_categories} where id=${category.id}`,
    ], ownerCondition(c, category.shop_id));
    return c.body(null, 204);
  });
}
