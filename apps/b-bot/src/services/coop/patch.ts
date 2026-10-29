import { generateStructured } from '@koin/b-bot-ai';
import { displayHour, normalizeClock, normalizeDate, normalizeMealType, normalizePhone } from './convert';
import type { AdminOperationHour, RegularConversionResult } from './types';

export type CoopPatchField = 'operation_hours' | 'phone' | 'remark' | 'from_date' | 'to_date';

export interface CoopPatch {
  field: CoopPatchField;
  shopName: string;
  dayOfWeek: string;
  type: string;
  before: string;
  after: string;
  value: string;
  openTime?: string;
  closeTime?: string;
}

export interface CoopPatchPlan {
  patches: CoopPatch[];
  problems: string[];
}

interface RawCoopPatch {
  shop: string;
  day: string;
  type: string;
  field: CoopPatchField;
  value: string;
}

const PATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['patches', 'unclear'],
  properties: {
    patches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['shop', 'day', 'type', 'field', 'value'],
        properties: {
          shop: { type: 'string', description: '매장명. 운영 기간 수정이면 빈 문자열.' },
          day: {
            type: 'string',
            enum: ['평일', 'FRIDAY', '금요일', '주말', '토요일', ''],
            description: '운영시간 수정 대상 요일. 금요일은 FRIDAY, 토요일과 토·일요일은 주말.',
          },
          type: { type: 'string', description: '아침/점심/저녁 같은 시간 구분. 없으면 빈 문자열.' },
          field: {
            type: 'string',
            enum: ['operation_hours', 'phone', 'remark', 'from_date', 'to_date'],
          },
          value: {
            type: 'string',
            description: '새 값. 운영시간은 09:00-18:00 또는 24시간/휴점/미운영, 날짜는 YYYY-MM-DD.',
          },
        },
      },
    },
    unclear: { type: 'array', items: { type: 'string' } },
  },
} as const;

const SYSTEM_PROMPT = `너는 이미지에서 추출한 생협 운영시간 데이터의 수정 요청을 구조화하는 도구다.

- 사용자가 지금 메시지에서 명시한 값만 옮긴다. 값을 추측하거나 보충하지 마라.
- 매장 운영시간은 매장명, 평일/FRIDAY/주말, 아침/점심/저녁 구분을 적는다.
- 금요일은 FRIDAY로 적는다.
- 토요일, 일요일, 토·일요일은 모두 주말로 적는다.
- 일반 매장은 시간 구분이 없으므로 type을 빈 문자열로 둔다.
- 영업시간 범위 전체나 휴점/미운영/24시간 상태는 operation_hours다.
- 운영 시작일은 from_date, 운영 종료일은 to_date다. 날짜는 YYYY-MM-DD로 적는다.
- 전화번호는 phone, 비고는 remark다.
- 뜻이 확실하지 않은 부분은 patches에 넣지 말고 unclear에 적는다.
- 직전 대화는 대명사 해석에만 참고하고, 지금 메시지가 요청한 변경만 반환한다.`;

const clean = (value: string) => value.replace(/[\s·.()-]/g, '').toLowerCase();
const normalizePatchDay = (value: string): string => {
  const day = clean(value);
  if (day === '금요일' || day === '금' || day === 'friday') return 'FRIDAY';
  return ['주말', '토요일', '토', '일요일', '일', '토일', '토일요일'].includes(day) ? '주말' : value;
};

function findShop(result: RegularConversionResult, name: string) {
  const wanted = clean(name);
  const exact = result.shops.filter((shop) => clean(shop.admin.coop_shop_info.name) === wanted);
  if (exact.length === 1) return exact[0];
  const partial = result.shops.filter((shop) => {
    const candidate = clean(shop.admin.coop_shop_info.name);
    return candidate.includes(wanted) || wanted.includes(candidate);
  });
  return partial.length === 1 ? partial[0] : null;
}

function normalizeStatus(value: string): string | null {
  const compact = value.replace(/\s+/g, '').trim();
  if (/^24시간(?:운영)?$/.test(compact)) return '24시간';
  if (/^휴점$/.test(compact)) return '휴점';
  if (compact.endsWith('미운영')) return '미운영';
  return null;
}

function parseHours(value: string): { openTime: string; closeTime: string } | null {
  const status = normalizeStatus(value);
  if (status) return { openTime: status, closeTime: status };
  const matched = /^(\d{1,2}:\d{2})\s*(?:-|~|–|부터)\s*(\d{1,2}:\d{2})(?:\s*까지)?$/.exec(value.trim());
  if (!matched) return null;
  const openTime = normalizeClock(matched[1]);
  const closeTime = normalizeClock(matched[2]);
  return openTime && closeTime ? { openTime, closeTime } : null;
}

/** 식사 구분을 알면 그걸로 찾고, 모르면 그날 하나뿐인 시간이나 구분 없는 시간을 쓴다. */
function findExistingHour(sameDay: AdminOperationHour[], resolvedType: string): AdminOperationHour | undefined {
  if (resolvedType) return sameDay.find((hour) => normalizeMealType(hour.type ?? '') === resolvedType);
  if (sameDay.length === 1) return sameDay[0];
  return sameDay.find((hour) => !hour.type);
}

export function resolveCoopPatch(
  raw: RawCoopPatch,
  result: RegularConversionResult,
  problems: string[],
): CoopPatch | null {
  const dayOfWeek = normalizePatchDay(raw.day);
  if (raw.field === 'from_date' || raw.field === 'to_date') {
    const value = normalizeDate(raw.value);
    if (!value) {
      problems.push(`운영 날짜 "${raw.value}"을 YYYY-MM-DD 형식으로 해석하지 못했습니다.`);
      return null;
    }
    const from = raw.field === 'from_date' ? value : result.fromDate;
    const to = raw.field === 'to_date' ? value : result.toDate;
    if (from && to && from > to) {
      problems.push(`운영 기간의 시작일 ${from}이 종료일 ${to}보다 늦습니다.`);
      return null;
    }
    return {
      field: raw.field,
      shopName: '',
      dayOfWeek: '',
      type: '',
      before: raw.field === 'from_date' ? result.fromDate : result.toDate,
      after: value,
      value,
    };
  }

  const shop = findShop(result, raw.shop);
  if (!shop) {
    problems.push(`"${raw.shop}"에 해당하는 매장을 하나로 찾지 못했습니다.`);
    return null;
  }
  const name = shop.admin.coop_shop_info.name;

  if (raw.field === 'phone') {
    const value = normalizePhone(raw.value);
    if (!value) {
      problems.push(`${name}: 전화번호 "${raw.value}"을 해석하지 못했습니다.`);
      return null;
    }
    return {
      field: raw.field,
      shopName: name,
      dayOfWeek: '',
      type: '',
      before: shop.admin.coop_shop_info.phone,
      after: value,
      value,
    };
  }

  if (raw.field === 'remark') {
    const value = raw.value.trim();
    return {
      field: raw.field,
      shopName: name,
      dayOfWeek: '',
      type: '',
      before: shop.admin.coop_shop_info.remark ?? '',
      after: value,
      value,
    };
  }

  if (!dayOfWeek) {
    problems.push(`${name}: 운영시간을 바꿀 요일을 적어주세요.`);
    return null;
  }
  const hours = parseHours(raw.value);
  if (!hours) {
    problems.push(`${name}: 운영시간 "${raw.value}"을 시간 범위나 24시간/휴점/미운영으로 해석하지 못했습니다.`);
    return null;
  }
  const knownTypes = [
    ...new Set(
      shop.admin.operation_hours
        .map((hour) => (hour.type ? normalizeMealType(hour.type) : hour.type))
        .filter((type): type is string => Boolean(type)),
    ),
  ];
  const resolvedType = normalizeMealType(raw.type) || (knownTypes.length === 1 ? knownTypes[0] : '');
  const sameDay = shop.admin.operation_hours.filter((hour) => hour.day_of_week === dayOfWeek);
  const existing = findExistingHour(sameDay, resolvedType);
  if (!resolvedType && (sameDay.length > 1 || knownTypes.length > 1) && !existing) {
    problems.push(`${name} ${dayOfWeek}: 아침/점심/저녁 중 어떤 시간인지 적어주세요.`);
    return null;
  }
  return {
    field: raw.field,
    shopName: name,
    dayOfWeek,
    type: resolvedType,
    before: existing ? displayHour(existing) : '(없음)',
    after: hours.openTime === hours.closeTime ? hours.openTime : `${hours.openTime} - ${hours.closeTime}`,
    value: raw.value,
    ...hours,
  };
}

export async function planCoopPatches(
  text: string,
  result: RegularConversionResult,
  context = '',
): Promise<CoopPatchPlan> {
  const raw = await generateStructured<{ patches: RawCoopPatch[]; unclear: string[] }>({
    system: SYSTEM_PROMPT,
    schema: PATCH_SCHEMA as unknown as Record<string, unknown>,
    prompt: context
      ? `직전 대화:\n${context}\n\n지금 메시지(이것만 처리해라):\n${text}`
      : `다음 수정 요청을 구조화해줘.\n\n${text}`,
  });
  const problems = raw.unclear.map((line) => `무슨 뜻인지 확실하지 않아 넘겼습니다: ${line}`);
  const patches = raw.patches.flatMap((item) => {
    const patch = resolveCoopPatch(item, result, problems);
    return patch ? [patch] : [];
  });
  return { patches, problems };
}

export function applyCoopPatches(result: RegularConversionResult, patches: CoopPatch[]): RegularConversionResult {
  const next = structuredClone(result) as RegularConversionResult;
  for (const patch of patches) {
    if (patch.field === 'from_date' || patch.field === 'to_date') {
      if (patch.field === 'from_date') next.fromDate = patch.value;
      else next.toDate = patch.value;
      if (normalizeDate(next.fromDate) && normalizeDate(next.toDate) && next.fromDate <= next.toDate) {
        next.issues = next.issues.filter((issue) => issue.code !== 'invalid_date');
      }
      continue;
    }

    const shop = next.shops.find((candidate) => candidate.admin.coop_shop_info.name === patch.shopName);
    if (!shop) throw new Error(`수정할 매장을 찾지 못했습니다: ${patch.shopName}`);
    if (patch.field === 'phone') {
      shop.admin.coop_shop_info.phone = patch.value;
      const sourceName = `${shop.source.groupLabel} ${shop.source.shopLabel}`.trim();
      next.issues = next.issues.filter(
        (issue) =>
          ![patch.shopName, sourceName].includes(issue.shop) ||
          !['invalid_phone', 'phone_changed', 'baseline_phone_used'].includes(issue.code),
      );
      continue;
    }
    if (patch.field === 'remark') {
      if (patch.value) shop.admin.coop_shop_info.remark = patch.value;
      else delete shop.admin.coop_shop_info.remark;
      continue;
    }

    const found = shop.admin.operation_hours.find(
      (hour) =>
        hour.day_of_week === patch.dayOfWeek && normalizeMealType(hour.type ?? '') === normalizeMealType(patch.type),
    );
    if (found) {
      if (found.type) found.type = normalizeMealType(found.type);
      found.open_time = patch.openTime!;
      found.close_time = patch.closeTime!;
    } else {
      shop.admin.operation_hours.push({
        ...(patch.type ? { type: normalizeMealType(patch.type) } : {}),
        day_of_week: patch.dayOfWeek,
        open_time: patch.openTime!,
        close_time: patch.closeTime!,
      });
    }
    const sourceName = `${shop.source.groupLabel} ${shop.source.shopLabel}`.trim();
    next.issues = next.issues.filter(
      (issue) =>
        ![patch.shopName, sourceName].includes(issue.shop) ||
        !['invalid_time', 'duplicate_operation_hour'].includes(issue.code),
    );
  }
  next.request = { coop_shops: next.shops.map((shop) => shop.admin) };
  return next;
}
