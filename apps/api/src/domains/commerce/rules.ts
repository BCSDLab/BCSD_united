import { ApiError } from '@api/errors';

const errors = {
  DIFFERENT_SHOP_ITEM_IN_CART: '장바구니에는 동일한 상점의 상품만 담을 수 있습니다.',
  MENU_SOLD_OUT: '상품이 매진되었습니다',
  SHOP_CLOSED: '상점의 영업시간이 아닙니다.',
  INVALID_MENU_IN_SHOP: '선택한 메뉴는 해당 상점에 속해있지 않습니다',
  INVALID_OPTION_IN_GROUP: '선택한 옵션이 해당 옵션 그룹에 속해있지 않습니다.',
  INVALID_CART_ITEM_QUANTITY: '유효하지 않은 수량입니다.',
  REQUIRED_OPTION_GROUP_MISSING: '필수 옵션 그룹을 선택하지 않았습니다.',
  MIN_SELECTION_NOT_MET: '옵션 그룹의 최소 선택 개수를 만족하지 못했습니다.',
  MAX_SELECTION_EXCEEDED: '옵션 그룹의 최대 선택 개수를 초과했습니다.',
  ORDER_AMOUNT_BELOW_MINIMUM: '최소 주문 금액을 충족하지 않습니다.',
  ORDER_PRICE_MISMATCH: '클라이언트 요청 금액이 서버 계산 결과와 다릅니다.',
  MISMATCH_TEMPORARY_PAYMENT: '요청한 정보가 임시 결제 정보와 일치하지 않습니다.',
  PAYMENT_ALREADY_CANCELED: '이미 취소된 결제입니다.',
  INVALID_ORDER_STATUS_CHANGE: '현재 주문 상태에서 요청한 상태로 변경할 수 없습니다.',
  REQUIRED_ORDER_CANCEL_REASON: '주문을 반려하려면 반려 사유가 필요합니다.',
  REQUIRED_ESTIMATED_MINUTES: '주문을 승인하려면 예상 소요 시간이 필요합니다.',
  PAYMENT_ACCESS_DENIED: '결제 정보 접근 권한이 없습니다.',
  FORBIDDEN_ORDER: '주문 정보 접근 권한이 없습니다.',
  FORBIDDEN_SHOP_OWNER: '상점의 사장님이 아닙니다.',
  NOT_FOUND_ORDERABLE_SHOP: '주문 가능 상점이 존재하지 않습니다.',
  NOT_FOUND_ORDERABLE_SHOP_MENU: '메뉴가 존재하지 않습니다',
  NOT_FOUND_ORDERABLE_SHOP_MENU_PRICE: '유효하지 않은 가격 ID 입니다.',
  NOT_FOUND_ORDERABLE_SHOP_MENU_OPTION: '유효하지 않은 옵션 ID 입니다.',
  NOT_FOUND_CART: '장바구니가 존재하지 않습니다',
  NOT_FOUND_CART_ITEM: '장바구니에 담긴 상품이 존재하지 않습니다',
  NOT_FOUND_TEMPORARY_PAYMENT: '임시 결제 정보가 존재하지 않습니다.',
  NOT_FOUND_PAYMENT: '결제 정보가 존재하지 않습니다.',
  NOT_FOUND_ORDER: '주문 정보가 존재하지 않습니다.',
  PAYMENT_CONFIRM_ERROR: '결제 중 문제가 생겼습니다.',
  PAYMENT_CANCEL_ERROR: '결제 취소 중 문제가 생겼습니다.',
} as const;

export function commerceError(code: keyof typeof errors): never {
  const status = code.startsWith('NOT_FOUND')
    ? 404
    : code.includes('ACCESS_DENIED') || code.startsWith('FORBIDDEN')
      ? 403
      : code.endsWith('_ERROR')
        ? 500
        : 400;
  throw new ApiError(status, code, errors[code]);
}

export type OrderType = 'DELIVERY' | 'TAKE_OUT';
export type OrderStatus = 'CONFIRMING' | 'COOKING' | 'PACKAGED' | 'PICKED_UP' | 'DELIVERING' | 'DELIVERED' | 'CANCELED';
export const inProgressStatuses: OrderStatus[] = ['CONFIRMING', 'COOKING', 'PACKAGED', 'DELIVERING'];
export const ownerStatusGroups: Record<string, OrderStatus[]> = {
  NEW: ['CONFIRMING'],
  COOKING: ['COOKING'],
  DELIVERING: ['DELIVERING', 'PACKAGED'],
  COMPLETED: ['PICKED_UP', 'DELIVERED', 'CANCELED'],
};

export function requireTransition(from: string, to: string, type: string): asserts to is OrderStatus {
  const transitions: Record<string, readonly string[]> = {
    CONFIRMING: ['COOKING', 'CANCELED'],
    COOKING: ['DELIVERING', 'PACKAGED'],
    PACKAGED: ['PICKED_UP'],
    DELIVERING: ['DELIVERED'],
  };
  const supported =
    type === 'DELIVERY'
      ? ['CONFIRMING', 'COOKING', 'DELIVERING', 'DELIVERED', 'CANCELED']
      : ['CONFIRMING', 'COOKING', 'PACKAGED', 'PICKED_UP', 'CANCELED'];
  if (!transitions[from]?.includes(to) || !supported.includes(to)) commerceError('INVALID_ORDER_STATUS_CHANGE');
}

export function quantity(value: unknown, maximum?: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    (maximum !== undefined && value > maximum)
  )
    commerceError('INVALID_CART_ITEM_QUANTITY');
  return value;
}

export function money(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) commerceError('ORDER_PRICE_MISMATCH');
  return value;
}

export function itemAmount(price: number, options: readonly { option_price: number }[], count: number): number {
  return money((money(price) + options.reduce((sum, option) => sum + money(option.option_price), 0)) * quantity(count));
}

export interface OptionSelection {
  option_group_id: number;
  option_id: number;
}
export interface OptionRule {
  id: number;
  is_required: boolean;
  min_select: number;
  max_select: number | null;
}
export interface AvailableOption {
  id: number;
  orderable_shop_menu_option_group_id: number;
}

export function resolveOptions<T extends AvailableOption>(
  groups: readonly OptionRule[],
  options: readonly T[],
  selected: readonly OptionSelection[],
): T[] {
  const result = selected.map((selection) => {
    const option = options.find((candidate) => candidate.id === selection.option_id);
    if (!option) commerceError('NOT_FOUND_ORDERABLE_SHOP_MENU_OPTION');
    if (option.orderable_shop_menu_option_group_id !== selection.option_group_id)
      commerceError('INVALID_OPTION_IN_GROUP');
    return option;
  });
  for (const group of groups) {
    const count = selected.filter((selection) => selection.option_group_id === group.id).length;
    if (group.is_required && count === 0) commerceError('REQUIRED_OPTION_GROUP_MISSING');
    if (selected.length && count < group.min_select) commerceError('MIN_SELECTION_NOT_MET');
    if (group.max_select !== null && count > group.max_select) commerceError('MAX_SELECTION_EXCEEDED');
  }
  return result;
}

export function sameConfiguration(
  menuId: number,
  priceId: number,
  optionIds: readonly number[],
  otherMenuId: number,
  otherPriceId: number,
  otherOptionIds: readonly number[],
): boolean {
  if (menuId !== otherMenuId || priceId !== otherPriceId || optionIds.length !== otherOptionIds.length) return false;
  const left = [...optionIds].sort((a, b) => a - b);
  const right = [...otherOptionIds].sort((a, b) => a - b);
  return left.every((value, index) => value === right[index]);
}

export function sqlNow(time = Date.now()): string {
  return new Date(time).toISOString().replace('T', ' ').replace('Z', '');
}
export function asInstant(value: string): Date {
  return new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : `${value.replace(' ', 'T')}Z`);
}
export function kstDate(value: string, pattern: 'date' | 'minute' | 'time' | 'iso' = 'minute'): string {
  const text = new Date(asInstant(value).getTime() + 9 * 3_600_000).toISOString();
  if (pattern === 'time') return text.slice(11, 16);
  if (pattern === 'date') return text.slice(0, 10);
  if (pattern === 'iso') return text.slice(0, 19);
  return `${text.slice(0, 10).replaceAll('-', '.')} ${text.slice(11, 16)}`;
}

export function orderType(value: unknown): OrderType {
  if (value !== 'DELIVERY' && value !== 'TAKE_OUT')
    throw new ApiError(400, 'INVALID_REQUEST', '주문 방법이 올바르지 않습니다.');
  return value;
}
