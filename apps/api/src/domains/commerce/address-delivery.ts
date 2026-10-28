import { and, eq } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { requirePrincipal } from '@api/auth';
import type { Database } from '@api/db/client';
import { schema } from '@api/db/schema';
import { ApiError } from '@api/errors';
import type { ApiEnv, Bindings } from '@api/runtime';

type AddressBody = Record<string, unknown>;

async function addressBody(c: Context<ApiEnv>): Promise<AddressBody> {
  const body = await c.req.json<unknown>();
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'INVALID_REQUEST_BODY', '잘못된 입력값이 포함되어 있습니다.');
  }
  return body as AddressBody;
}

function invalid(field: string, message: string, constraint: string): never {
  throw new ApiError(400, 'INVALID_REQUEST_BODY', '잘못된 입력값이 포함되어 있습니다.', [{ field, message, constraint }]);
}

function stringField(body: AddressBody, field: string, message: string, blankAllowed = false): string {
  const value = body[field];
  if (typeof value !== 'string' || (!blankAllowed && !value.trim())) {
    invalid(field, message, blankAllowed ? 'NotNull' : 'NotBlank');
  }
  return value;
}

function optionalString(body: AddressBody, field: string): string | null {
  const value = body[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') invalid(field, '문자열이어야 합니다.', 'String');
  return value;
}

export function validateOffCampusAddress(address: {
  si_do: string | null; si_gun_gu: string | null; eup_myeon_dong: string | null; building: string | null;
}): void {
  if (address.si_do !== '충청남도' || address.si_gun_gu !== '천안시 동남구' || address.eup_myeon_dong !== '병천면') {
    throw new ApiError(400, 'INVALID_DELIVERY_AREA', '배달이 불가능한 지역이에요.');
  }
  if (address.building === '한국기술교육대학교') {
    throw new ApiError(400, 'INVALID_DELIVERY_BUILDING', '교외 주문 주소에 교내 주문 주소를 입력할 수 없습니다.');
  }
}

async function requireUser(db: Database, id: number) {
  const [user] = await db.select({ id: schema.users.id }).from(schema.users)
    .where(and(eq(schema.users.id, id), eq(schema.users.is_deleted, false))).limit(1);
  if (!user) throw new ApiError(404, 'NOT_FOUND_USER', '사용자가 존재하지 않습니다.');
}

interface Juso {
  roadAddr: string; jibunAddr: string; engAddr: string; zipNo: string; bdNm: string;
  siNm: string; sggNm: string; emdNm: string; liNm: string; rn: string;
}
interface JusoResponse {
  results?: {
    common?: { totalCount: string; currentPage: number; countPerPage: number; errorCode: string; errorMessage: string };
    juso?: Juso[];
  };
}

const addressErrors: Record<string, { code: string; message: string }> = {
  E0005: { code: 'ADDRESS_KEYWORD_NOT_PROVIDED', message: '검색어를 입력해주세요.' },
  E0006: { code: 'ADDRESS_KEYWORD_TOO_EXTENSIVE', message: '주소를 상세히 입력해 주세요' },
  E0008: { code: 'ADDRESS_KEYWORD_TOO_SHORT', message: '검색어는 두 글자 이상 입력해야 합니다.' },
  E0009: { code: 'ADDRESS_KEYWORD_ONLY_NUMBER', message: '검색어는 문자와 숫자 같이 입력되어야 합니다.' },
  E0010: { code: 'ADDRESS_KEYWORD_TOO_LONG', message: '검색어가 너무 깁니다. (한글 40자 이하)' },
  E0013: { code: 'ADDRESS_KEYWORD_INVALID_SYMBOLS', message: '검색어에 사용할 수 없는 특수문자(%,=,<,[,])가 포함되어 있습니다.' },
  E0015: { code: 'ADDRESS_SEARCH_LIMIT_EXCEEDED', message: '검색 결과가 너무 많습니다.' },
};

async function searchLocalAddresses(db: Database, keyword: string, page: number, size: number) {
  let pattern: RegExp;
  try { pattern = new RegExp(keyword, 'i'); }
  catch { throw new ApiError(400, 'ILLEGAL_ARGUMENT', '잘못된 인자가 전달되었습니다.'); }
  const rows = await db.select().from(schema.address_byeongcheon);
  const matches = rows.filter((row) => [row.road_address, row.jibun_address, row.bd_nm]
    .some((value) => value !== null && pattern.test(value)));
  return {
    total_count: String(matches.length), current_page: page, count_per_page: size,
    addresses: matches.slice((page - 1) * size, page * size).map(({ id: _id, ...address }) => address),
  };
}

async function queryAddressProvider(env: Bindings, keyword: string, page: number, size: number) {
  if (!env.ADDRESS_API_URL || !env.ADDRESS_API_KEY) {
    throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', '주소 API 연결 설정이 없습니다.');
  }
  let payload: JusoResponse;
  try {
    const response = await fetch(env.ADDRESS_API_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ confmKey: env.ADDRESS_API_KEY, currentPage: String(page),
        countPerPage: String(size), keyword, resultType: 'json' }),
    });
    if (!response.ok) return null;
    payload = await response.json<JusoResponse>();
  } catch {
    return null;
  }
  const common = payload.results?.common;
  if (!common) return null;
  if (common.errorCode !== '0') {
    const error = addressErrors[common.errorCode];
    if (error) throw new ApiError(400, error.code, error.message);
    return null;
  }
  return {
    total_count: common.totalCount, current_page: Number(common.currentPage), count_per_page: Number(common.countPerPage),
    addresses: (payload.results?.juso ?? []).map((address) => ({
      road_address: address.roadAddr, jibun_address: address.jibunAddr, eng_address: address.engAddr,
      zip_no: address.zipNo, bd_nm: address.bdNm, si_nm: address.siNm, sgg_nm: address.sggNm,
      emd_nm: address.emdNm, li_nm: address.liNm, rn: address.rn,
    })),
  };
}

async function searchAddresses(env: Bindings, db: Database, keyword: string, page: number, size: number) {
  const result = await queryAddressProvider(env, keyword, page, size);
  return result ?? searchLocalAddresses(db, keyword, page, size);
}

export async function validateDeliveryAddress(env: Bindings, address: string): Promise<void> {
  try {
    const result = await queryAddressProvider(env, address, 1, 1);
    if (result === null) {
      console.error('[Address API-5xx] 주소 검증 과정에서 외부 API 호출에 실패했습니다.');
      return;
    }
    if (Number(result.total_count) === 0) throw new ApiError(400, 'INVALID_ADDRESS_FORMAT', '올바르지 않은 주소 형식입니다.');
  } catch (error) {
    if (error instanceof ApiError && error.status === 400) {
      throw new ApiError(400, 'INVALID_ADDRESS_FORMAT', '올바르지 않은 주소 형식입니다.');
    }
    throw error;
  }
}

export function registerAddressDelivery(app: Hono<ApiEnv>): void {
  app.get('/address/search', async (c) => {
    const keyword = c.req.query('keyword');
    if (!keyword?.trim()) invalid('keyword', '공백일 수 없습니다.', 'NotBlank');
    const pageValue = c.req.query('currentPage');
    const sizeValue = c.req.query('countPerPage');
    const page = Number(pageValue);
    const size = Number(sizeValue);
    if (!pageValue || !Number.isInteger(page) || page < 1) invalid('currentPage', '1 이상이어야 합니다.', 'Min');
    if (!sizeValue || !Number.isInteger(size) || size < 1) invalid('countPerPage', '1 이상이어야 합니다.', 'Min');
    return c.json(await searchAddresses(c.env, c.get('db'), keyword, page, size));
  });

  app.get('/address/delivery/campus', async (c) => {
    const filter = c.req.query('filter') ?? 'ALL';
    const filterIds: Record<string, number> = { ALL: 0, DORMITORY: 1, COLLEGE_BUILDING: 2, ETC: 3 };
    const filterId = filterIds[filter];
    if (filterId === undefined) throw new ApiError(400, 'ILLEGAL_ARGUMENT', '잘못된 인자가 전달되었습니다.');
    const a = schema.campus_delivery_address;
    const t = schema.campus_delivery_address_type;
    const addresses = await c.get('db').select({
      id: a.id, type: t.name, full_address: a.full_address, short_address: a.short_address,
      address: a.address, latitude: a.latitude, longitude: a.longitude,
    }).from(a).innerJoin(t, eq(a.campus_address_type_id, t.id))
      .where(filterId ? eq(t.id, filterId) : undefined);
    return c.json({ count: addresses.length, addresses: addresses.map((a) => ({ ...a,
      latitude: a.latitude === null ? null : Number(a.latitude), longitude: a.longitude === null ? null : Number(a.longitude),
    })) });
  });

  app.post('/delivery/address/off-campus/validate', async (c) => {
    const body = await addressBody(c);
    validateOffCampusAddress({
      si_do: stringField(body, 'si_do', '시/도는 필수입니다.'),
      si_gun_gu: stringField(body, 'si_gun_gu', '시/군/구는 필수입니다.'),
      eup_myeon_dong: optionalString(body, 'eup_myeon_dong'), building: optionalString(body, 'building'),
    });
    return c.body(null, 200);
  });

  app.post('/delivery/address/off-campus', async (c) => {
    const principal = requirePrincipal(c, ['GENERAL', 'STUDENT']);
    const body = await addressBody(c);
    const address = {
      zip_number: stringField(body, 'zip_number', '우편번호는 필수입니다.', true),
      si_do: optionalString(body, 'si_do'), si_gun_gu: optionalString(body, 'si_gun_gu'),
      eup_myeon_dong: optionalString(body, 'eup_myeon_dong'), road: optionalString(body, 'road'),
      building: optionalString(body, 'building'), address: stringField(body, 'address', '기본 주소는 필수입니다.'),
      detail_address: stringField(body, 'detail_address', '상세 주소는 필수입니다.'),
    };
    await requireUser(c.get('db'), principal.id);
    validateOffCampusAddress(address);
    const fullAddress = `${address.address} ${address.detail_address}`;
    const [inserted] = await c.get('db').insert(schema.user_delivery_address).values({
      ...address, user_id: principal.id, address_type: 'OFF_CAMPUS', full_address: fullAddress,
      last_used_at: new Date().toISOString().replace('T', ' ').replace('Z', ''), usage_count: null, is_default: null,
    }).returning({ id: schema.user_delivery_address.id });
    return c.json({ user_delivery_address_id: inserted!.id, full_address: fullAddress });
  });

  app.post('/delivery/address/campus', async (c) => {
    const principal = requirePrincipal(c, ['GENERAL', 'STUDENT']);
    const body = await addressBody(c);
    const addressId = body.campus_delivery_address_id;
    if (typeof addressId !== 'number' || !Number.isInteger(addressId)) invalid('campus_delivery_address_id', '널이어서는 안됩니다.', 'NotNull');
    const db = c.get('db');
    await requireUser(db, principal.id);
    const a = schema.campus_delivery_address;
    const t = schema.campus_delivery_address_type;
    const [campus] = await db.select({ id: a.id, full_address: a.full_address }).from(a)
      .innerJoin(t, eq(a.campus_address_type_id, t.id)).where(eq(a.id, addressId)).limit(1);
    if (!campus) throw new ApiError(404, 'NOT_FOUND_DELIVERY_ADDRESS', '주소가 존재하지 않습니다.');
    const [inserted] = await db.insert(schema.user_delivery_address).values({
      user_id: principal.id, address_type: 'CAMPUS', campus_delivery_address_id: addressId,
      last_used_at: new Date().toISOString().replace('T', ' ').replace('Z', ''), usage_count: null, is_default: null,
    }).returning({ id: schema.user_delivery_address.id });
    return c.json({ user_delivery_address_id: inserted!.id, full_address: campus.full_address });
  });

  app.get('/delivery/rider-message', async (c) => {
    const contents = await c.get('db').select({ content: schema.rider_message.content }).from(schema.rider_message);
    return c.json({ count: contents.length, contents });
  });
}
