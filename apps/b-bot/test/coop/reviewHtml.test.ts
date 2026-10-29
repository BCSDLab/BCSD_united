import { describe, expect, it } from 'vitest';
import { renderRegularCoopReview, renderVacationCoopReview } from '~/services/coop/reviewHtml';
import type { RegularConversionResult } from '~/services/coop/types';

const result: RegularConversionResult = {
  semester: '26-1학기',
  fromDate: '2026-03-03',
  toDate: '2026-06-19',
  request: { coop_shops: [] },
  excludedShops: [{ groupLabel: '2캠', shopLabel: '커피점', phone: '521-8088', remark: '', operationHours: [] }],
  issues: [{ code: 'excluded_second_campus', severity: 'info', shop: '2캠 커피점', detail: '제외' }],
  shops: [
    {
      baseline: { id: 1, name: '학생식당', phone: '041-560-1278', location: '학생회관 2층', remarks: null, opens: [] },
      source: {
        groupLabel: '학생',
        shopLabel: '식당',
        phone: '560-1278',
        remark: '<원문>',
        operationHours: [
          { dayLabel: '평일', type: '아침', openTime: '08:00', closeTime: '09:30', rawText: '08:00 - 09:30' },
          { dayLabel: '금요일', type: '', openTime: '휴점', closeTime: '휴점', rawText: '금요일 휴점' },
          { dayLabel: '토요일', type: '', openTime: '미운영', closeTime: '미운영', rawText: '미운영' },
        ],
      },
      admin: {
        coop_shop_info: { name: '학생식당', phone: '041-560-1278', location: '학생회관 2층', remark: '<원문>' },
        operation_hours: [
          { day_of_week: '평일', type: '아침', open_time: '08:00', close_time: '09:30' },
          { day_of_week: 'FRIDAY', open_time: '휴점', close_time: '휴점' },
          { day_of_week: '주말', open_time: '미운영', close_time: '미운영' },
        ],
      },
    },
  ],
};

describe('생협 검토 HTML', () => {
  it('카드형 운영시간과 접힌 상세 검증을 보여준다', () => {
    const html = renderRegularCoopReview(result);
    expect(html).toContain('26-1학기 시설물 운영 시간');
    expect(html).toContain('2026년 3월 3일 - 6월 19일');
    expect(html).toContain('<article class="card');
    expect(html).toContain('상세 검증');
    expect(html).toContain('학생회관 2층');
    expect(html).toContain('<td class="state">미운영</td>');
    expect(html).toContain('<th>금요일</th>');
    expect(html).not.toContain('<th>FRIDAY</th>');
    expect(html).toContain('<td class="state">휴점</td>');
    expect(html).not.toContain('반영 매장');
    expect(html).not.toContain('반영에서 제외한 2캠 사업장');
    expect(html).not.toContain('매장명 · 위치 · 전화번호 검색');
  });

  it('원본 문자열을 HTML escape 한다', () => {
    const html = renderRegularCoopReview(result);
    expect(html).toContain('&lt;원문&gt;');
    expect(html).not.toContain('<원문>');
  });

  it('계절학기와 방학을 한 검토 페이지에서 구분한다', () => {
    const vacation = structuredClone(result);
    vacation.semester = '26-하계방학';
    vacation.fromDate = '2026-07-18';
    vacation.toDate = '2026-08-30';
    const html = renderVacationCoopReview({
      year: 2026,
      season: '하계',
      vacationStartDate: '2026-07-18',
      seasonal: { ...result, semester: '26-하계계절학기', fromDate: '2026-06-22', toDate: '2026-07-17' },
      vacation,
    });
    expect(html).toContain('26-하계계절학기 · 계절학기');
    expect(html).toContain('26-하계방학 · 방학');
    expect(html).toContain('방학 시작일 2026년 7월 18일');
  });
});
