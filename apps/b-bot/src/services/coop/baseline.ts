import type { BaselineCoopShop, CoopShopBaseline } from './types';

function isBaselineShop(value: unknown): value is BaselineCoopShop {
  if (!value || typeof value !== 'object') return false;
  const shop = value as Partial<BaselineCoopShop>;
  return (
    typeof shop.id === 'number' &&
    typeof shop.name === 'string' &&
    typeof shop.phone === 'string' &&
    typeof shop.location === 'string' &&
    Array.isArray(shop.opens) &&
    (typeof shop.remarks === 'string' || shop.remarks === null)
  );
}

export function parseCoopShopBaseline(value: unknown): CoopShopBaseline {
  if (!value || typeof value !== 'object') {
    throw new Error('기존 생협 매장 응답이 객체가 아닙니다.');
  }
  const baseline = value as Partial<CoopShopBaseline>;
  if (!Array.isArray(baseline.coop_shops) || !baseline.coop_shops.every(isBaselineShop)) {
    throw new Error('기존 생협 매장 응답 형식이 올바르지 않습니다.');
  }
  if (baseline.coop_shops.length === 0) {
    throw new Error('기존 생협 매장이 비어 있습니다.');
  }
  return baseline as CoopShopBaseline;
}

export async function fetchCoopShopBaseline(): Promise<CoopShopBaseline> {
  const baseUrl = (process.env.KOIN_API_BASE_URL || 'https://api.koreatech.in').replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/coopshop`);
  if (!response.ok) {
    throw new Error(`기존 생협 매장을 불러오지 못했습니다 (HTTP ${response.status}).`);
  }
  return parseCoopShopBaseline(await response.json());
}
