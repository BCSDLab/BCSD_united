import type {
  AdminOperationHour,
  BaselineCoopShop,
  ConversionIssue,
  CoopShopBaseline,
  RawCoopShop,
  RawRegularCoopTimetable,
  RegularConversionResult,
  VacationSeason,
  VacationSplitConversionResult,
} from './types';

const NAME_ALIASES: Record<string, string> = {
  학생식당: '학생식당',
  복지관식당: '복지관식당',
  본교커피점: '대즐',
  커피점: '대즐',
  대즐: '대즐',
  본교편의점: '복지관 참빛관 편의점',
  복지관참빛관편의점: '복지관 참빛관 편의점',
  서점문구점: '서점',
  서점: '서점',
  우편취급국: '우편취급국',
  세탁소: '세탁소',
  미용실: '미용실',
  안경원: '안경원',
  복사실: '복사실',
  오락실: '오락실',
};

const clean = (value: string): string => value.replace(/[\s·.()-]/g, '').trim();

const MEAL_TYPE: Record<string, string> = {
  조식: '아침',
  중식: '점심',
  석식: '저녁',
};

/** 이미지와 수정 명령의 식사 구분을 Admin API 표준 명칭으로 맞춘다. */
export function normalizeMealType(value: string): string {
  const type = value.trim();
  return MEAL_TYPE[type] ?? type;
}

export function normalizeSemester(label: string): string | null {
  if (/(?:하계|동계)\s*방학|여름\s*학기|겨울\s*학기|계절\s*학기/.test(label)) {
    return null;
  }
  const match = /(?:^|\D)(?:20)?(\d{2})\s*(?:년\s*)?[-.]?\s*제?\s*([12])\s*학기/.exec(label);
  return match ? `${match[1]}-${match[2]}학기` : null;
}

export function normalizeVacationSemester(label: string): { year: number; season: VacationSeason } | null {
  const match = /(?:^|\D)(20\d{2}|\d{2})\s*(?:년\s*)?[-.]?\s*(하계|동계)\s*(?:방학|계절\s*학기)/.exec(label);
  if (!match) return null;
  const parsedYear = Number(match[1]);
  return {
    year: parsedYear < 100 ? 2000 + parsedYear : parsedYear,
    season: match[2] as VacationSeason,
  };
}

export function normalizeDate(value: string, fallbackYear?: number): string | null {
  const trimmed = value.trim();
  const full = /(20\d{2})\D+(\d{1,2})\D+(\d{1,2})/.exec(trimmed);
  if (!full && /20\d{2}/.test(trimmed)) return null;
  const partial = full ? null : /^\D*(\d{1,2})\D+(\d{1,2})(?:\D|$)/.exec(trimmed);
  const year = full ? Number(full[1]) : fallbackYear;
  const month = Number(full?.[2] ?? partial?.[1]);
  const day = Number(full?.[3] ?? partial?.[2]);
  if (!year || !month || !day) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeVacationPeriod(
  fromValue: string,
  toValue: string,
  semesterYear: number,
): { fromDate: string | null; toDate: string | null } {
  const fromDate = normalizeDate(fromValue, semesterYear);
  const fromYear = fromDate ? Number(fromDate.slice(0, 4)) : semesterYear;
  let toDate = normalizeDate(toValue, fromYear);
  if (fromDate && toDate && toDate < fromDate && !/20\d{2}/.test(toValue)) {
    toDate = normalizeDate(toValue, fromYear + 1);
  }
  return { fromDate, toDate };
}

export function normalizePhone(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  if (/^041\d{7,8}$/.test(digits)) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (/^\d{7,8}$/.test(digits)) {
    return `041-${digits.slice(0, 3)}-${digits.slice(3)}`;
  }
  return null;
}

function normalizeDay(value: string): string | null {
  const day = clean(value);
  if (day === '평일' || day === '주중') return '평일';
  if (day === '금요일' || day === '금') return 'FRIDAY';
  if (['주말', '토요일', '토', '일요일', '일', '토일', '토일요일'].includes(day)) {
    return '주말';
  }
  return null;
}

function normalizeStatus(value: string): string | null {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return null;
  if (/^24시간(?:\s*운영)?$/.test(compact)) return '24시간';
  if (/^(?:금요일\s*)?휴\s*점$/.test(compact)) return '휴점';
  if (/미\s*운영$/.test(compact)) return compact.replace(/미\s*운영$/, '미운영');
  if (/예약\s*운영$/.test(compact)) return '예약 운영';
  return null;
}

/** 여는 시각과 닫는 시각이 같으면 한 번만 적는다. */
export function displayHour(hour: AdminOperationHour): string {
  return hour.open_time === hour.close_time ? hour.open_time : `${hour.open_time} - ${hour.close_time}`;
}

export function normalizeClock(value: string): string | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function normalizeHourValue(value: string): string | null {
  return normalizeStatus(value) ?? normalizeClock(value);
}

function isSecondCampus(shop: RawCoopShop): boolean {
  return /(?:^|\s)(?:2캠|제2캠)/.test(`${shop.groupLabel} ${shop.shopLabel}`);
}

function isNonShopNotice(shop: RawCoopShop): boolean {
  const label = clean(`${shop.groupLabel} ${shop.shopLabel}`);
  return label.includes('긴급민원') || label.includes('기계실');
}

function canonicalName(shop: RawCoopShop): string | null {
  const combined = clean(`${shop.groupLabel}${shop.shopLabel}`);
  const own = clean(shop.shopLabel);
  return NAME_ALIASES[combined] ?? NAME_ALIASES[own] ?? null;
}

function matchShop(source: RawCoopShop, baseline: BaselineCoopShop[], used: Set<number>): BaselineCoopShop | null {
  const phone = normalizePhone(source.phone);
  if (phone) {
    const byPhone = baseline.find((shop) => !used.has(shop.id) && shop.phone === phone);
    if (byPhone) return byPhone;
  }

  const name = canonicalName(source);
  return name ? (baseline.find((shop) => !used.has(shop.id) && clean(shop.name) === clean(name)) ?? null) : null;
}

function convertHours(source: RawCoopShop, issues: ConversionIssue[]): AdminOperationHour[] {
  const result: AdminOperationHour[] = [];
  const seen = new Set<string>();

  for (const hour of source.operationHours) {
    const fridayClosed = [hour.openTime, hour.closeTime].some((value) => /^금요일\s*휴\s*점$/.test(value.trim()));
    const day = fridayClosed ? 'FRIDAY' : normalizeDay(hour.dayLabel);
    const open = normalizeHourValue(hour.openTime);
    const close = normalizeHourValue(hour.closeTime);
    const label = `${source.groupLabel} ${source.shopLabel}`.trim();
    if (!day) {
      issues.push({
        code: 'invalid_day',
        severity: 'blocking',
        shop: label,
        detail: `지원하지 않는 요일입니다: ${hour.dayLabel}`,
      });
      continue;
    }
    if (!open || !close) {
      issues.push({
        code: 'invalid_time',
        severity: 'blocking',
        shop: label,
        detail: `운영시간을 해석하지 못했습니다: ${hour.rawText || `${hour.openTime} - ${hour.closeTime}`}`,
      });
      continue;
    }
    const type = normalizeMealType(hour.type);
    const key = `${day}|${type}`;
    if (seen.has(key)) {
      issues.push({
        code: 'duplicate_operation_hour',
        severity: 'blocking',
        shop: label,
        detail: `${day} ${type || '운영시간'}이 중복되었습니다.`,
      });
      continue;
    }
    seen.add(key);
    result.push({
      ...(type ? { type } : {}),
      day_of_week: day,
      open_time: open,
      close_time: close,
    });
  }
  return result;
}

function convertTimetable(
  raw: RawRegularCoopTimetable,
  baseline: CoopShopBaseline,
  semester: string | null,
): RegularConversionResult {
  const issues: ConversionIssue[] = [];
  const fromDate = normalizeDate(raw.fromDate);
  const toDate = normalizeDate(raw.toDate);

  if (!semester) {
    issues.push({
      code: 'invalid_semester',
      severity: 'blocking',
      shop: '',
      detail: `정규학기 이름을 해석하지 못했습니다: ${raw.semesterLabel}`,
    });
  }
  if (!fromDate || !toDate || (fromDate && toDate && fromDate > toDate)) {
    issues.push({
      code: 'invalid_date',
      severity: 'blocking',
      shop: '',
      detail: `운영 기간을 해석하지 못했습니다: ${raw.fromDate} - ${raw.toDate}`,
    });
  }

  const sourceShops = raw.shops.filter((shop) => !isNonShopNotice(shop));
  const excludedShops = sourceShops.filter(isSecondCampus);
  for (const shop of excludedShops) {
    const label = `${shop.groupLabel} ${shop.shopLabel}`.trim();
    issues.push({
      code: 'excluded_second_campus',
      severity: 'info',
      shop: label,
      detail: '2캠 사업장은 반영 대상에서 제외합니다.',
    });
  }

  const used = new Set<number>();
  const shops = sourceShops
    .filter((shop) => !isSecondCampus(shop))
    .flatMap((source) => {
      const label = `${source.groupLabel} ${source.shopLabel}`.trim();
      const matched = matchShop(source, baseline.coop_shops, used);
      if (!matched) {
        issues.push({
          code: 'unmatched_shop',
          severity: 'blocking',
          shop: label,
          detail: '기존 표준 매장과 연결하지 못했습니다.',
        });
        return [];
      }
      used.add(matched.id);

      const normalizedPhone = normalizePhone(source.phone);
      let phone = normalizedPhone;
      if (!source.phone.trim()) {
        phone = matched.phone;
        issues.push({
          code: 'baseline_phone_used',
          severity: 'info',
          shop: matched.name,
          detail: `이미지에 전화번호가 없어 기존 값 ${matched.phone}을 사용합니다.`,
        });
      } else if (!normalizedPhone) {
        issues.push({
          code: 'invalid_phone',
          severity: 'blocking',
          shop: matched.name,
          detail: `전화번호를 해석하지 못했습니다: ${source.phone}`,
        });
        phone = matched.phone;
      } else if (normalizedPhone !== matched.phone) {
        issues.push({
          code: 'phone_changed',
          severity: 'info',
          shop: matched.name,
          detail: `전화번호가 ${matched.phone}에서 ${normalizedPhone}(으)로 바뀝니다.`,
        });
      }

      const operationHours = convertHours(source, issues);
      return [
        {
          source,
          baseline: matched,
          admin: {
            coop_shop_info: {
              name: matched.name,
              phone: phone ?? matched.phone,
              location: matched.location,
              ...(source.remark.trim() || matched.remarks
                ? { remark: source.remark.trim() || matched.remarks || undefined }
                : {}),
            },
            operation_hours: operationHours,
          },
        },
      ];
    });

  for (const missing of baseline.coop_shops.filter((shop) => !used.has(shop.id))) {
    issues.push({
      code: 'missing_shop',
      severity: 'blocking',
      shop: missing.name,
      detail: '이미지에서 기존 표준 매장을 찾지 못했습니다.',
    });
  }

  // 관리자와 공개 API가 사용하는 기존 매장 순서를 유지한다.
  shops.sort((a, b) => a.baseline.id - b.baseline.id);

  return {
    semester: semester ?? '',
    fromDate: fromDate ?? '',
    toDate: toDate ?? '',
    request: { coop_shops: shops.map((shop) => shop.admin) },
    shops,
    excludedShops,
    issues,
  };
}

export function convertRegularTimetable(
  raw: RawRegularCoopTimetable,
  baseline: CoopShopBaseline,
): RegularConversionResult {
  return convertTimetable(raw, baseline, normalizeSemester(raw.semesterLabel));
}

function previousDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function closesAfterSeasonalTerm(remark: string): boolean {
  return /계절\s*학기\s*까지\s*운영/.test(remark);
}

function closeVacationHours(result: RegularConversionResult): RegularConversionResult {
  const next = structuredClone(result) as RegularConversionResult;
  for (const shop of next.shops) {
    if (!closesAfterSeasonalTerm(shop.source.remark)) continue;
    shop.admin.operation_hours = shop.admin.operation_hours.map((hour) => ({
      ...(hour.type ? { type: hour.type } : {}),
      day_of_week: hour.day_of_week,
      open_time: '미운영',
      close_time: '미운영',
    }));
    next.issues.push({
      code: 'vacation_hours_closed',
      severity: 'info',
      shop: shop.admin.coop_shop_info.name,
      detail: "비고의 '계절학기까지 운영' 조건에 따라 방학 기간은 미운영으로 변환했습니다.",
    });
  }
  next.request = { coop_shops: next.shops.map((shop) => shop.admin) };
  return next;
}

export function convertVacationTimetable(
  raw: RawRegularCoopTimetable,
  baseline: CoopShopBaseline,
  vacationStartDateValue: string,
): VacationSplitConversionResult {
  const vacationSemester = normalizeVacationSemester(raw.semesterLabel) ?? normalizeVacationSemester(raw.title);
  if (!vacationSemester) {
    throw new Error(`하계·동계 방학 학기를 해석하지 못했습니다: ${raw.semesterLabel || raw.title}`);
  }

  const { fromDate, toDate } = normalizeVacationPeriod(raw.fromDate, raw.toDate, vacationSemester.year);
  const vacationStartDate = normalizeDate(vacationStartDateValue);
  if (!fromDate || !toDate || !vacationStartDate) {
    throw new Error(
      `전체 운영 기간 또는 방학 시작일을 해석하지 못했습니다: ${raw.fromDate} - ${raw.toDate} / ${vacationStartDateValue}`,
    );
  }
  if (fromDate >= vacationStartDate || vacationStartDate > toDate) {
    throw new Error(`방학 시작일은 전체 운영 기간 안에서 시작일보다 늦어야 합니다: ${fromDate} - ${toDate}`);
  }

  const yearShort = String(vacationSemester.year).slice(-2);
  const seasonalSemester = `${yearShort}-${vacationSemester.season}계절학기`;
  const vacationSemesterName = `${yearShort}-${vacationSemester.season}방학`;
  const seasonal = convertTimetable(
    { ...raw, fromDate, toDate: previousDate(vacationStartDate) },
    baseline,
    seasonalSemester,
  );
  const vacationBase = convertTimetable(
    { ...raw, fromDate: vacationStartDate, toDate },
    baseline,
    vacationSemesterName,
  );

  return {
    year: vacationSemester.year,
    season: vacationSemester.season,
    vacationStartDate,
    seasonal,
    vacation: closeVacationHours(vacationBase),
  };
}
