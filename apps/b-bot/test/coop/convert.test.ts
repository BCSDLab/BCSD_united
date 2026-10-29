import { describe, expect, it } from 'vitest';
import {
  convertRegularTimetable,
  convertVacationTimetable,
  normalizeDate,
  normalizeMealType,
  normalizePhone,
  normalizeSemester,
  normalizeVacationSemester,
} from '~/services/coop/convert';
import type { CoopShopBaseline, RawRegularCoopTimetable } from '~/services/coop/types';

const baseline: CoopShopBaseline = {
  semester: '25-2학기',
  from_date: '2025-09-01',
  to_date: '2025-12-19',
  coop_shops: [
    { id: 1, name: '학생식당', phone: '041-560-1278', location: '학생회관 2층', remarks: null, opens: [] },
    { id: 2, name: '대즐', phone: '041-560-1779', location: '복지관 1층', remarks: '기존 비고', opens: [] },
  ],
};

const raw: RawRegularCoopTimetable = {
  title: '2026-1학기 생협 사업장 운영시간 안내',
  semesterLabel: '2026-1학기',
  fromDate: '2026.3.3.(화)',
  toDate: '2026년 6월 19일',
  shops: [
    {
      groupLabel: '학생',
      shopLabel: '식당',
      phone: '560-1278',
      remark: '',
      operationHours: [
        { dayLabel: '평 일', type: '아침', openTime: '8:00', closeTime: '09:30', rawText: '08:00 - 09:30' },
        { dayLabel: '평일', type: '', openTime: '금요일 휴점', closeTime: '금요일 휴점', rawText: '금요일 휴점' },
        {
          dayLabel: '토·일요일',
          type: '아침',
          openTime: '조식 미운영',
          closeTime: '조식 미운영',
          rawText: '조식 미운영',
        },
      ],
    },
    {
      groupLabel: '본교',
      shopLabel: '커피점',
      phone: '560-1779',
      remark: '배달 서비스 실시',
      operationHours: [{ dayLabel: '평일', type: '', openTime: '08:30', closeTime: '21:00', rawText: '08:30 - 21:00' }],
    },
    {
      groupLabel: '2캠',
      shopLabel: '편의점',
      phone: '521-8088',
      remark: '',
      operationHours: [
        { dayLabel: '평일', type: '', openTime: '24시간 운영', closeTime: '24시간 운영', rawText: '24시간 운영' },
      ],
    },
  ],
};

describe('정규학기 기본값 정규화', () => {
  it('학기·날짜·전화번호를 표준 형식으로 만든다', () => {
    expect(normalizeSemester('2026.1학기')).toBe('26-1학기');
    expect(normalizeSemester('2026년 1학기 시설물 운영 시간')).toBe('26-1학기');
    expect(normalizeSemester('2026년 1학기 하계방학 운영 시간')).toBeNull();
    expect(normalizeDate('2026년 3월 3일(화)')).toBe('2026-03-03');
    expect(normalizeDate('8.30.(일)', 2026)).toBe('2026-08-30');
    expect(normalizeDate('8.30.(일)')).toBeNull();
    expect(normalizePhone('560-1278')).toBe('041-560-1278');
  });

  it('식사 구분을 Admin API 표준 명칭으로 바꾼다', () => {
    expect(normalizeMealType('조식')).toBe('아침');
    expect(normalizeMealType(' 중식 ')).toBe('점심');
    expect(normalizeMealType('석식')).toBe('저녁');
    expect(normalizeMealType('아침')).toBe('아침');
    expect(normalizeMealType('')).toBe('');
  });
});

describe('방학 학기 분리', () => {
  const vacationRaw: RawRegularCoopTimetable = {
    ...raw,
    title: '2026년 하계방학 생협 사업장 운영시간 안내',
    semesterLabel: '2026년 하계방학',
    fromDate: '2026.6.22',
    toDate: '8.30.(일)',
    shops: raw.shops.slice(0, 2).map((shop, index) => ({
      ...shop,
      remark: index === 0 ? '계절학기 까지 운영' : '배달 서비스 실시',
    })),
  };

  it('방학 이름에서 연도와 계절을 읽는다', () => {
    expect(normalizeVacationSemester('26-하계방학')).toEqual({ year: 2026, season: '하계' });
    expect(normalizeVacationSemester('2026년 동계 계절학기')).toEqual({ year: 2026, season: '동계' });
  });

  it('방학 시작일을 경계로 두 학기 요청을 만든다', () => {
    const result = convertVacationTimetable(vacationRaw, baseline, '2026-07-18');

    expect(result.seasonal.semester).toBe('26-하계계절학기');
    expect(result.seasonal.fromDate).toBe('2026-06-22');
    expect(result.seasonal.toDate).toBe('2026-07-17');
    expect(result.vacation.semester).toBe('26-하계방학');
    expect(result.vacation.fromDate).toBe('2026-07-18');
    expect(result.vacation.toDate).toBe('2026-08-30');
  });

  it('기간 조건이 없는 운영시간은 복제하고 계절학기까지 운영하는 매장은 방학에 미운영 처리한다', () => {
    const result = convertVacationTimetable(vacationRaw, baseline, '2026-07-18');
    const seasonalRestaurant = result.seasonal.request.coop_shops[0];
    const vacationRestaurant = result.vacation.request.coop_shops[0];
    const seasonalCafe = result.seasonal.request.coop_shops[1];
    const vacationCafe = result.vacation.request.coop_shops[1];

    expect(seasonalRestaurant.operation_hours[0].open_time).toBe('08:00');
    expect(
      vacationRestaurant.operation_hours.every((hour) => hour.open_time === '미운영' && hour.close_time === '미운영'),
    ).toBe(true);
    expect(vacationCafe.operation_hours).toEqual(seasonalCafe.operation_hours);
    expect(result.vacation.issues).toContainEqual(
      expect.objectContaining({
        code: 'vacation_hours_closed',
        shop: '학생식당',
        severity: 'info',
      }),
    );
  });

  it('긴급 민원 안내 행은 두 학기의 매장 및 확인 필요 항목에서 제외한다', () => {
    const notices = [
      { groupLabel: '대학 시설 관련 긴급 민원', shopLabel: '', phone: '560-1266~7', remark: '', operationHours: [] },
      { groupLabel: '', shopLabel: '기계실', phone: '560-1266~7', remark: '', operationHours: [] },
    ];
    const result = convertVacationTimetable(
      {
        ...vacationRaw,
        shops: [...vacationRaw.shops, ...notices],
      },
      baseline,
      '2026-07-18',
    );

    for (const period of [result.seasonal, result.vacation]) {
      expect(period.request.coop_shops).toHaveLength(2);
      expect(period.issues).not.toContainEqual(
        expect.objectContaining({
          code: 'unmatched_shop',
          shop: expect.stringContaining('긴급 민원'),
        }),
      );
      expect(period.issues.filter((issue) => issue.severity === 'blocking')).toHaveLength(0);
    }
  });

  it('방학 시작일이 전체 운영 기간 밖이면 거부한다', () => {
    expect(() => convertVacationTimetable(vacationRaw, baseline, '2026-09-01')).toThrow(
      '방학 시작일은 전체 운영 기간 안에서',
    );
  });

  it('동계 종료일에 연도가 없고 연말을 넘으면 다음 연도로 보정한다', () => {
    const winterRaw: RawRegularCoopTimetable = {
      ...vacationRaw,
      title: '2026년 동계방학 생협 사업장 운영시간 안내',
      semesterLabel: '2026년 동계방학',
      fromDate: '2026.12.21.(월)',
      toDate: '2.28.(일)',
    };
    const result = convertVacationTimetable(winterRaw, baseline, '2027-01-16');

    expect(result.seasonal.semester).toBe('26-동계계절학기');
    expect(result.seasonal.fromDate).toBe('2026-12-21');
    expect(result.seasonal.toDate).toBe('2027-01-15');
    expect(result.vacation.fromDate).toBe('2027-01-16');
    expect(result.vacation.toDate).toBe('2027-02-28');
  });
});

describe('정규학기 변환', () => {
  it('표준 매장에 연결하고 2캠을 제외한다', () => {
    const result = convertRegularTimetable(raw, baseline);

    expect(result.semester).toBe('26-1학기');
    expect(result.fromDate).toBe('2026-03-03');
    expect(result.toDate).toBe('2026-06-19');
    expect(result.request.coop_shops.map((shop) => shop.coop_shop_info.name)).toEqual(['학생식당', '대즐']);
    expect(result.request.coop_shops[0].operation_hours[0]).toEqual({
      type: '아침',
      day_of_week: '평일',
      open_time: '08:00',
      close_time: '09:30',
    });
    expect(result.request.coop_shops[0].operation_hours[1]).toEqual({
      day_of_week: 'FRIDAY',
      open_time: '휴점',
      close_time: '휴점',
    });
    expect(result.request.coop_shops[0].operation_hours[2].open_time).toBe('조식 미운영');
    expect(result.request.coop_shops[0].operation_hours[2].day_of_week).toBe('주말');
    expect(result.excludedShops).toHaveLength(1);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'excluded_second_campus',
        severity: 'info',
      }),
    );
    expect(result.issues.filter((issue) => issue.severity === 'blocking')).toHaveLength(0);
  });

  it('기존 매장이 빠지면 반영을 막는다', () => {
    const result = convertRegularTimetable({ ...raw, shops: raw.shops.slice(0, 1) }, baseline);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: 'missing_shop', shop: '대즐' }));
  });

  it('모델이 조식·중식·석식으로 읽어도 아침·점심·저녁으로 변환한다', () => {
    const source = structuredClone(raw);
    source.shops[0].operationHours = [
      { dayLabel: '평일', type: '조식', openTime: '08:00', closeTime: '09:30', rawText: '08:00 - 09:30' },
      { dayLabel: '평일', type: '중식', openTime: '11:30', closeTime: '13:30', rawText: '11:30 - 13:30' },
      { dayLabel: '주말', type: '석식', openTime: '17:30', closeTime: '18:30', rawText: '17:30 - 18:30' },
    ];

    const result = convertRegularTimetable(source, baseline);
    expect(result.request.coop_shops[0].operation_hours.map((hour) => hour.type)).toEqual(['아침', '점심', '저녁']);
  });
});
