import { sql, type SQL } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { requirePrincipal } from '@api/auth';
import type { Database } from '@api/db/client';
import { ApiError } from '@api/errors';
import type { ApiEnv } from '@api/runtime';
import { calculateDeliveryFee, requireOrderableShopOpen } from '@api/domains/commerce/orderable-catalog';
import { commerceError, itemAmount, money, orderType, quantity, resolveOptions, sameConfiguration, type OptionSelection, type OrderType } from '@api/domains/commerce/rules';
import { first, mutateCart, revision } from '@api/domains/commerce/storage';

export interface CartOption extends Record<string, unknown> {
  id: number; orderable_shop_menu_option_id: number; option_name: string; option_price: number; quantity: number;
  option_group_id: number; option_group_name: string;
}
export interface CartItem extends Record<string, unknown> {
  id: number; orderable_shop_menu_id: number; orderable_shop_menu_price_id: number; quantity: number; is_modified: number;
  name: string; price_name: string | null; price: number; thumbnail: string | null; options: CartOption[];
}
export interface CartGraph extends Record<string, unknown> {
  id: number; user_id: number; orderable_shop_id: number; shop_id: number; shop_name: string; shop_address: string;
  shop_address_detail: string | null; delivery: number; takeout: number; minimum_order_amount: number;
  thumbnail: string | null; items: CartItem[]; revision: number;
}
interface Price extends Record<string, unknown> { id: number; name: string | null; price: number }
interface Menu extends Record<string, unknown> { id: number; orderable_shop_id: number; name: string; description: string | null; is_sold_out: number }
interface Group extends Record<string, unknown> { id: number; name: string; description: string | null; is_required: number; min_select: number; max_select: number | null }
interface Option extends Record<string, unknown> { id: number; orderable_shop_menu_option_group_id: number; name: string; price: number }

const CART_ROLES = ['GENERAL', 'STUDENT'] as const;
const DUPLICATE_REQUEST_WINDOW_MS = 300;

function cartUser(c: Context<ApiEnv>): number {
  return requirePrincipal(c, [...CART_ROLES]).id;
}

export async function loadCart(db: Database, userId: number, required = true): Promise<CartGraph | null> {
  const version = await revision(db, userId);
  const cart = await first<CartGraph>(db, sql`SELECT c.*, os.shop_id, os.delivery, os.takeout, os.minimum_order_amount,
    s.name AS shop_name,s.address AS shop_address,s.address_detail AS shop_address_detail,
    (SELECT image_url FROM orderable_shop_image WHERE orderable_shop_id=os.id AND is_thumbnail=1 AND is_deleted=0 LIMIT 1) AS thumbnail
    FROM cart c JOIN orderable_shop os ON os.id=c.orderable_shop_id JOIN shops s ON s.id=os.shop_id WHERE c.user_id=${userId}`);
  if (!cart) {
    if (required) commerceError('NOT_FOUND_CART');
    return null;
  }
  cart.revision = version;
  cart.items = await db.all<CartItem>(sql`SELECT ci.*,m.name,p.name AS price_name,p.price,
    (SELECT image_url FROM orderable_shop_menu_images WHERE orderable_shop_menu_id=m.id AND is_thumbnail=1 AND is_deleted=0 LIMIT 1) AS thumbnail
    FROM cart_menu_item ci JOIN orderable_shop_menu m ON m.id=ci.orderable_shop_menu_id
    JOIN orderable_shop_menu_price p ON p.id=ci.orderable_shop_menu_price_id WHERE ci.cart_id=${cart.id} ORDER BY ci.id`);
  const options = await db.all<CartOption & { cart_menu_item_id: number }>(sql`SELECT co.*,og.id AS option_group_id,og.name AS option_group_name
    FROM cart_menu_item_option co JOIN cart_menu_item ci ON ci.id=co.cart_menu_item_id
    JOIN orderable_shop_menu_option mo ON mo.id=co.orderable_shop_menu_option_id
    JOIN orderable_shop_menu_option_group og ON og.id=mo.orderable_shop_menu_option_group_id WHERE ci.cart_id=${cart.id} ORDER BY co.id`);
  for (const item of cart.items) item.options = options.filter((option) => option.cart_menu_item_id === item.id);
  return cart;
}

export function cartAmount(cart: CartGraph): number {
  return money(cart.items.reduce((total, item) => total + itemAmount(item.price, item.options, item.quantity), 0));
}

export async function cartAmounts(db: Database, cart: CartGraph, type: OrderType) {
  if (type === 'DELIVERY' && !cart.delivery) throw new ApiError(400, 'SHOP_NOT_DELIVERABLE', '배달 가능한 상점이 아닙니다.');
  if (type === 'TAKE_OUT' && !cart.takeout) throw new ApiError(400, 'SHOP_NOT_TAKEOUT_AVAILABLE', '포장 가능한 상점이 아닙니다.');
  const itemsAmount = cartAmount(cart);
  const deliveryFee = type === 'DELIVERY' ? await calculateDeliveryFee(db, cart.shop_id, itemsAmount) : 0;
  return { itemsAmount, deliveryFee, totalAmount: money(itemsAmount + deliveryFee) };
}

async function menuConfiguration(db: Database, menuId: number, priceId: number, selected: OptionSelection[]) {
  const menu = await first<Menu>(db, sql`SELECT * FROM orderable_shop_menu WHERE id=${menuId} AND is_deleted=0`);
  if (!menu) commerceError('NOT_FOUND_ORDERABLE_SHOP_MENU');
  const price = await first<Price>(db, sql`SELECT * FROM orderable_shop_menu_price WHERE id=${priceId} AND orderable_shop_menu_id=${menuId} AND is_deleted=0`);
  if (!price) commerceError('NOT_FOUND_ORDERABLE_SHOP_MENU_PRICE');
  const groups = await db.all<Group>(sql`SELECT g.* FROM orderable_shop_menu_option_group g JOIN orderable_shop_menu_option_group_map gm
    ON gm.orderable_shop_menu_option_group_id=g.id WHERE gm.orderable_shop_menu_id=${menuId} AND g.is_deleted=0 AND gm.is_deleted=0`);
  const options = await db.all<Option>(sql`SELECT o.* FROM orderable_shop_menu_option o JOIN orderable_shop_menu_option_group_map gm
    ON gm.orderable_shop_menu_option_group_id=o.orderable_shop_menu_option_group_id WHERE gm.orderable_shop_menu_id=${menuId} AND o.is_deleted=0 AND gm.is_deleted=0`);
  const chosen = resolveOptions(groups.map((group) => ({ ...group, is_required: Boolean(group.is_required) })), options, selected);
  return { menu, price, chosen };
}

function optionInserts(itemId: SQL | number, options: Option[]): SQL[] {
  return options.map((option) => sql`INSERT INTO cart_menu_item_option(cart_menu_item_id,orderable_shop_menu_option_id,option_name,option_price,quantity,is_modified)
    VALUES(${itemId},${option.id},${option.name},${option.price},1,0)`);
}

/** 장바구니 항목이 메뉴·가격·옵션 조합까지 같은지 본다. 같으면 새 행 대신 수량을 합친다. */
function sameCartConfiguration(item: CartItem, menuId: number, priceId: number, optionIds: number[]): boolean {
  return sameConfiguration(item.orderable_shop_menu_id, item.orderable_shop_menu_price_id, item.options.map((option) => option.orderable_shop_menu_option_id), menuId, priceId, optionIds);
}

const selections = z.array(z.object({ option_group_id: z.number().int(), option_id: z.number().int() })).nullish().transform((value) => value ?? []);
const addBody = z.object({
  orderable_shop_id: z.number().int(),
  orderable_shop_menu_id: z.number().int(),
  orderable_shop_menu_price_id: z.number().int(),
  orderable_shop_menu_option_ids: selections,
  quantity: z.number().int().min(1).max(10),
});
const updateBody = z.object({ orderable_shop_menu_price_id: z.number().int(), options: selections, quantity: z.number().int().min(1) });

async function addCartItem(db: Database, userId: number, body: z.output<typeof addBody>): Promise<void> {
  await requireOrderableShopOpen(db, body.orderable_shop_id);
  const cart = await loadCart(db, userId, false);
  const version = cart?.revision ?? await revision(db, userId);
  if (cart && cart.orderable_shop_id !== body.orderable_shop_id) commerceError('DIFFERENT_SHOP_ITEM_IN_CART');
  const config = await menuConfiguration(db, body.orderable_shop_menu_id, body.orderable_shop_menu_price_id, body.orderable_shop_menu_option_ids);
  if (config.menu.orderable_shop_id !== body.orderable_shop_id) commerceError('INVALID_MENU_IN_SHOP');
  if (config.menu.is_sold_out) commerceError('MENU_SOLD_OUT');
  const duplicateKey = `${userId}:${JSON.stringify(body)}`;
  const existingRequest = await first(db, sql`SELECT key FROM native_cart_duplicate WHERE key=${duplicateKey} AND expires_at>${Date.now()}`);
  if (existingRequest) throw new ApiError(409, 'REQUEST_TOO_FAST', '요청이 너무 빠릅니다. 다시 요청해주세요.');
  const chosenIds = config.chosen.map((option) => option.id);
  const duplicate = cart?.items.find((item) => sameCartConfiguration(item, config.menu.id, config.price.id, chosenIds));
  const statements: SQL[] = [
    sql`DELETE FROM native_cart_duplicate WHERE key=${duplicateKey} AND expires_at<=${Date.now()}`,
    sql`INSERT INTO native_cart_duplicate(key,user_id,expires_at) VALUES(${duplicateKey},${userId},${Date.now() + DUPLICATE_REQUEST_WINDOW_MS})`,
  ];
  if (!cart) statements.push(sql`INSERT INTO cart(user_id,orderable_shop_id) VALUES(${userId},${body.orderable_shop_id})`);
  if (duplicate) {
    quantity(duplicate.quantity + body.quantity);
    statements.push(sql`UPDATE cart_menu_item SET quantity=quantity+${body.quantity},updated_at=CURRENT_TIMESTAMP WHERE id=${duplicate.id}`);
  } else {
    statements.push(sql`INSERT INTO cart_menu_item(cart_id,orderable_shop_menu_id,orderable_shop_menu_price_id,quantity,is_modified)
      VALUES((SELECT id FROM cart WHERE user_id=${userId}),${config.menu.id},${config.price.id},${body.quantity},0)`);
    const itemId = sql`(SELECT MAX(id) FROM cart_menu_item WHERE cart_id=(SELECT id FROM cart WHERE user_id=${userId}))`;
    statements.push(...optionInserts(itemId, config.chosen));
  }
  await mutateCart(db, userId, version, statements);
}

async function editCartItem(db: Database, userId: number, itemId: number, body: z.output<typeof updateBody>): Promise<void> {
  const cart = (await loadCart(db, userId))!;
  const item = cart.items.find((candidate) => candidate.id === itemId);
  if (!item) commerceError('NOT_FOUND_CART_ITEM');
  const config = await menuConfiguration(db, item.orderable_shop_menu_id, body.orderable_shop_menu_price_id, body.options);
  const chosenIds = config.chosen.map((option) => option.id);
  const duplicate = cart.items.find((candidate) => candidate.id !== itemId && sameCartConfiguration(candidate, item.orderable_shop_menu_id, config.price.id, chosenIds));
  const statements: SQL[] = [sql`DELETE FROM cart_menu_item_option WHERE cart_menu_item_id=${itemId}`];
  if (duplicate) {
    quantity(duplicate.quantity + body.quantity);
    statements.push(
      sql`UPDATE cart_menu_item SET quantity=quantity+${body.quantity},updated_at=CURRENT_TIMESTAMP WHERE id=${duplicate.id}`,
      sql`DELETE FROM cart_menu_item WHERE id=${itemId}`,
    );
  } else {
    statements.push(
      sql`UPDATE cart_menu_item SET orderable_shop_menu_price_id=${config.price.id},quantity=${body.quantity},is_modified=1,updated_at=CURRENT_TIMESTAMP WHERE id=${itemId}`,
      ...optionInserts(itemId, config.chosen),
    );
  }
  await mutateCart(db, userId, cart.revision, statements);
}

export function deleteCartStatements(cartId: number): SQL[] {
  return [
    sql`DELETE FROM cart_menu_item_option WHERE cart_menu_item_id IN(SELECT id FROM cart_menu_item WHERE cart_id=${cartId})`,
    sql`DELETE FROM cart_menu_item WHERE cart_id=${cartId}`,
    sql`DELETE FROM cart WHERE id=${cartId}`,
  ];
}

async function editResponse(db: Database, cart: CartGraph, itemId: number) {
  const item = cart.items.find((candidate) => candidate.id === itemId);
  if (!item) commerceError('NOT_FOUND_CART_ITEM');
  const menu = await first<Menu>(db, sql`SELECT * FROM orderable_shop_menu WHERE id=${item.orderable_shop_menu_id} AND is_deleted=0`);
  if (!menu) commerceError('NOT_FOUND_ORDERABLE_SHOP_MENU');
  const prices = await db.all<Price>(sql`SELECT * FROM orderable_shop_menu_price WHERE orderable_shop_menu_id=${menu.id} AND is_deleted=0`);
  const images = await db.all<{ image_url: string }>(sql`SELECT image_url FROM orderable_shop_menu_images WHERE orderable_shop_menu_id=${menu.id} AND is_deleted=0 ORDER BY id`);
  const groups = await db.all<Group>(sql`SELECT g.* FROM orderable_shop_menu_option_group g JOIN orderable_shop_menu_option_group_map gm ON gm.orderable_shop_menu_option_group_id=g.id WHERE gm.orderable_shop_menu_id=${menu.id} AND g.is_deleted=0 AND gm.is_deleted=0 ORDER BY gm.id`);
  const options = await db.all<Option>(sql`SELECT o.* FROM orderable_shop_menu_option o JOIN orderable_shop_menu_option_group_map gm ON gm.orderable_shop_menu_option_group_id=o.orderable_shop_menu_option_group_id WHERE gm.orderable_shop_menu_id=${menu.id} AND o.is_deleted=0 AND gm.is_deleted=0 ORDER BY o.id`);
  return {
    id: menu.id,
    quantity: item.quantity,
    name: menu.name,
    description: menu.description,
    images: images.map((image) => image.image_url),
    prices: prices.map((price) => ({ id: price.id, name: price.name, price: price.price, is_selected: price.id === item.orderable_shop_menu_price_id })),
    option_groups: groups.map((group) => ({
      id: group.id,
      name: group.name,
      description: group.description,
      is_required: Boolean(group.is_required),
      min_select: group.min_select,
      max_select: group.max_select,
      options: options
        .filter((option) => option.orderable_shop_menu_option_group_id === group.id)
        .map((option) => ({ id: option.id, name: option.name, price: option.price, is_selected: item.options.some((selected) => selected.orderable_shop_menu_option_id === option.id) })),
    })),
  };
}

function cartItemResponse(item: CartItem) {
  return {
    cart_menu_item_id: item.id,
    orderable_shop_menu_id: item.orderable_shop_menu_id,
    name: item.name,
    menu_thumbnail_image_url: item.thumbnail,
    quantity: item.quantity,
    total_amount: itemAmount(item.price, item.options, item.quantity),
    price: { name: item.price_name, price: item.price },
    options: item.options.map((option) => ({ option_group_name: option.option_group_name, option_name: option.option_name, option_price: option.option_price })),
    is_modified: Boolean(item.is_modified),
  };
}

export function registerCart(app: Hono<ApiEnv>): void {
  app.get('/cart', async (c) => {
    const userId = cartUser(c);
    const type = orderType(c.req.query('type'));
    const cart = await loadCart(c.get('db'), userId, false);
    if (!cart?.items.length) {
      return c.json({ shop_name: null, shop_thumbnail_image_url: null, orderable_shop_id: null, is_delivery_available: false, is_takeout_available: false, shop_minimum_order_amount: 0, items: [], items_amount: 0, delivery_fee: 0, total_amount: 0, final_payment_amount: 0 });
    }
    const amounts = await cartAmounts(c.get('db'), cart, type);
    return c.json({
      shop_name: cart.shop_name,
      shop_thumbnail_image_url: cart.thumbnail,
      orderable_shop_id: cart.orderable_shop_id,
      is_delivery_available: Boolean(cart.delivery),
      is_takeout_available: Boolean(cart.takeout),
      shop_minimum_order_amount: cart.minimum_order_amount,
      items: cart.items.map(cartItemResponse),
      items_amount: amounts.itemsAmount,
      delivery_fee: amounts.deliveryFee,
      total_amount: amounts.totalAmount,
      final_payment_amount: amounts.totalAmount,
    });
  });
  app.post('/cart/add', async (c) => {
    await addCartItem(c.get('db'), cartUser(c), addBody.parse(await c.req.json()));
    return c.body(null, 200);
  });
  app.post('/cart/quantity/:cartMenuItemId/:quantity', async (c) => {
    const userId = cartUser(c);
    const cart = (await loadCart(c.get('db'), userId))!;
    const id = Number(c.req.param('cartMenuItemId'));
    const count = quantity(Number(c.req.param('quantity')));
    if (!cart.items.some((item) => item.id === id)) commerceError('NOT_FOUND_CART_ITEM');
    await mutateCart(c.get('db'), userId, cart.revision, [sql`UPDATE cart_menu_item SET quantity=${count},updated_at=CURRENT_TIMESTAMP WHERE id=${id}`]);
    return c.body(null, 200);
  });
  app.delete('/cart/delete/:cartMenuItemId', async (c) => {
    const userId = cartUser(c);
    const cart = (await loadCart(c.get('db'), userId))!;
    const id = Number(c.req.param('cartMenuItemId'));
    if (!cart.items.some((item) => item.id === id)) commerceError('NOT_FOUND_CART_ITEM');
    // 마지막 항목을 지우면 장바구니 자체를 지운다.
    const statements = cart.items.length === 1
      ? deleteCartStatements(cart.id)
      : [sql`DELETE FROM cart_menu_item_option WHERE cart_menu_item_id=${id}`, sql`DELETE FROM cart_menu_item WHERE id=${id}`];
    await mutateCart(c.get('db'), userId, cart.revision, statements);
    return c.body(null, 200);
  });
  app.delete('/cart/reset', async (c) => {
    const userId = cartUser(c);
    const cart = (await loadCart(c.get('db'), userId))!;
    await mutateCart(c.get('db'), userId, cart.revision, deleteCartStatements(cart.id));
    return c.body(null, 200);
  });
  app.put('/cart/item/:cartMenuItemId', async (c) => {
    await editCartItem(c.get('db'), cartUser(c), Number(c.req.param('cartMenuItemId')), updateBody.parse(await c.req.json()));
    return c.body(null, 200);
  });
  app.get('/cart/item/:cartMenuItemId/edit', async (c) => {
    const cart = (await loadCart(c.get('db'), cartUser(c)))!;
    return c.json(await editResponse(c.get('db'), cart, Number(c.req.param('cartMenuItemId'))));
  });
  app.get('/cart/summary/:orderableShopId', async (c) => {
    const cart = await loadCart(c.get('db'), cartUser(c), false);
    if (!cart?.items.length || cart.orderable_shop_id !== Number(c.req.param('orderableShopId'))) {
      return c.json({ orderable_shop_id: 0, shop_minimum_order_amount: 0, cart_items_amount: 0, is_available: false });
    }
    return c.json({ orderable_shop_id: cart.orderable_shop_id, shop_minimum_order_amount: cart.minimum_order_amount, cart_items_amount: cartAmount(cart), is_available: true });
  });
  app.get('/cart/payment/summary', async (c) => {
    const type = orderType(c.req.query('type'));
    const cart = await loadCart(c.get('db'), cartUser(c), false);
    if (!cart?.items.length) return c.json({ item_total_amount: 0, delivery_fee: 0, total_amount: 0, final_payment_amount: 0 });
    const amounts = await cartAmounts(c.get('db'), cart, type);
    return c.json({ item_total_amount: amounts.itemsAmount, delivery_fee: amounts.deliveryFee, total_amount: amounts.totalAmount, final_payment_amount: amounts.totalAmount });
  });
  app.get('/cart/validate', async (c) => {
    const type = orderType(c.req.query('order_type'));
    const cart = (await loadCart(c.get('db'), cartUser(c)))!;
    await requireOrderableShopOpen(c.get('db'), cart.orderable_shop_id);
    if (type === 'DELIVERY' && cartAmount(cart) < cart.minimum_order_amount) commerceError('ORDER_AMOUNT_BELOW_MINIMUM');
    return c.body(null, 200);
  });
  app.get('/cart/items/count', async (c) => {
    const cart = await loadCart(c.get('db'), cartUser(c), false);
    return c.json({ item_type_count: cart?.items.length ?? 0, total_quantity: cart?.items.reduce((sum, item) => sum + item.quantity, 0) ?? 0 });
  });
}
