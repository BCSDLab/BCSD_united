import { describe, expect, it } from 'vitest';
import { parseStructuredWorkbook } from '~/services/bus/regularParser';
import type { AnalysedWorkbook } from '~/services/bus/excelAnalyzer';

const cell = (row: number, column: number, value: unknown) => ({ row, column, value });

function workbook(): AnalysedWorkbook {
  return {
    sheets: [
      {
        name: 'REGULAR',
        cells: [
          cell(1, 1, '천안 지역 등교'),
          cell(1, 4, '천안 셔틀'),
          cell(2, 1, '정류장'),
          cell(2, 2, '천안역'),
          cell(2, 3, '터미널'),
          cell(2, 4, '셔틀 1회'),
          cell(3, 1, '천안역'),
          cell(4, 1, '터미널'),
          cell(5, 1, '대학'),
          cell(3, 2, '07:50/08:10'),
          cell(4, 2, '08:00/08:20'),
          cell(3, 3, '08:10'),
          cell(4, 3, '08:20'),
          cell(5, 3, '08:50'),
          cell(3, 4, '08:10'),
          cell(4, 4, '08:20'),
          cell(5, 4, '08:50'),
        ],
        merges: [],
      },
    ],
    tables: [],
  };
}

describe('parseStructuredWorkbook', () => {
  it('통학 슬래시 결합을 다중 회차로 분리하고 셔틀은 그대로 둔다', () => {
    const routes = parseStructuredWorkbook(workbook());

    const commuting = routes.filter((r) => r.target === 'commuting');
    const shuttle = routes.filter((r) => r.target === 'shuttle');

    // KOIN Admin API는 route_info[].running_days를 받지 않으므로, 평일
    // 운행이라는 사실은 route_name 뒤 괄호(→ sub_name "주중")로만 남는다.
    const joined = commuting.find((r) => r.route.route_name === '천안역(주중)')!;
    expect(joined.route.node_info).toEqual([{ name: '천안역' }, { name: '터미널' }]);
    expect(joined.route.route_info).toHaveLength(2);
    expect(joined.route.route_info[0]).toMatchObject({
      name: '등교',
      arrival_time: ['07:50', '08:00'],
    });
    expect(joined.route.route_info[1]).toMatchObject({
      name: '등교',
      arrival_time: ['08:10', '08:20'],
    });
    for (const trip of joined.route.route_info) expect(trip.running_days).toEqual(['MON', 'TUE', 'WED', 'THU', 'FRI']);

    const plain = commuting.find((r) => r.route.route_name === '터미널(주중)')!;
    expect(plain.route.route_info).toHaveLength(1);
    expect(plain.route.route_info[0]).toMatchObject({
      name: '등교',
      arrival_time: ['08:10', '08:20', '08:50'],
    });

    expect(shuttle).toHaveLength(1);
    expect(shuttle[0].route.route_name).toBe('천안 셔틀(주중)');
    expect(shuttle[0].route.node_info).toHaveLength(3);
    expect(shuttle[0].route.route_info).toHaveLength(1);
    expect(shuttle[0].route.route_info[0]).toMatchObject({
      name: '셔틀 1회',
      arrival_time: ['08:10', '08:20', '08:50'],
    });
  });

  it('주말 셔틀은 등교/하교를 한 노선에 담고, 소속을 상위 제목에서 찾아 회차명에 방향을 붙인다', () => {
    const weekend: AnalysedWorkbook = {
      sheets: [
        {
          name: 'REGULAR',
          cells: [
            cell(8, 1, '2026학년도 학기 중 일학습병행대학 주말통학버스 운행시간표'),
            cell(9, 1, '(천안시내) 토요일 통학 셔틀버스'),
            cell(10, 1, '정류장'),
            cell(10, 2, '등교 2회'),
            cell(10, 4, '하교 2회'),
            cell(11, 1, '두정역'),
            cell(11, 2, '08:00'),
            cell(11, 3, '10:10'),
            cell(12, 1, '대학'),
            cell(12, 2, '도착'),
            cell(12, 3, '도착'),
            cell(12, 4, '19:10'),
            cell(12, 5, '19:20'),
          ],
          merges: [],
        },
      ],
      tables: [],
    };

    const routes = parseStructuredWorkbook(weekend);
    // KOIN Admin API는 route_info[].running_days를 받지 않으므로, 토요일
    // 전용 셔틀이라는 제한은 route_name 뒤 괄호(→ sub_name)로만 남는다.
    const route = routes.find((r) => r.route.route_name === '일학습병행대학 천안시내(토요일)');
    expect(route).toBeDefined();
    expect(route!.target).toBe('shuttle');
    expect(route!.route.route_info.map((trip) => trip.name)).toEqual([
      '1회(등교)',
      '2회(등교)',
      '3회(하교)',
      '4회(하교)',
    ]);
    for (const trip of route!.route.route_info) expect(trip.running_days).toEqual(['SAT']);
  });

  it("헤더 행에 옆으로 넓게 걸린 '운행기간' 안내문을 회차로 잡지 않는다", () => {
    const withNoticeCell: AnalysedWorkbook = {
      sheets: [
        {
          name: 'REGULAR',
          cells: [
            cell(1, 1, '청주 지역 등교'),
            cell(1, 4, '청주 셔틀(본교-청주-본교)'),
            cell(2, 1, '정류장'),
            cell(2, 4, '1회'),
            cell(2, 5, '2회'),
            cell(2, 7, '운행기간 : 2026.01.01 ~ 2026.02.01'),
            cell(3, 1, '정류장A'),
            cell(3, 4, '08:00'),
            cell(3, 5, '09:00'),
            // 실제 파일에서 이 자리는 안내문 셀이 넓게 병합돼 있었고, 그 아래
            // 다른 표의 시각이 같은 행 번호에 우연히 걸쳐 회차처럼 보였다.
            cell(3, 7, '10:00'),
          ],
          merges: [],
        },
      ],
      tables: [],
    };

    const routes = parseStructuredWorkbook(withNoticeCell);
    const route = routes.find((r) => r.route.route_name === '청주 셔틀(주중)');
    expect(route).toBeDefined();
    expect(route!.route.route_info.map((trip) => trip.name)).toEqual(['1회', '2회']);
  });

  it("서울 노선은 출발지별로 나누고 프로덕션 표기('서울 등교 추가 OO역')를 따른다", () => {
    const seoul: AnalysedWorkbook = {
      sheets: [
        {
          name: 'REGULAR',
          cells: [
            cell(0, 1, '서울(월~금요일) 안내'),
            cell(1, 1, '출발지 →'),
            cell(1, 4, '교대 출발'),
            cell(1, 5, '교대 출발'),
            cell(1, 6, '교대 출발'),
            cell(1, 7, '동천 출발'),
            cell(2, 1, '노선'),
            cell(2, 4, '월(1호차)'),
            cell(2, 5, '월(2호차)'),
            cell(2, 6, '화~금'),
            cell(2, 7, '월(3호차)'),
            cell(3, 1, '교대역'),
            cell(3, 4, '07:10'),
            cell(3, 5, '07:20'),
            cell(3, 6, '07:20'),
            cell(4, 1, '동천역'),
            cell(4, 5, '07:40'),
            cell(4, 6, '07:40'),
            cell(4, 7, '07:30'),
            cell(5, 1, '대학'),
            cell(5, 4, '08:40'),
            cell(5, 5, '08:50'),
            cell(5, 6, '08:50'),
            cell(5, 7, '08:40'),
          ],
          merges: [],
        },
      ],
      tables: [],
    };

    const routes = parseStructuredWorkbook(seoul);
    const seoulRoutes = routes.filter((r) => r.route.region === '서울');
    // 프로덕션 표기(예: `_id: 69a5a710...` "서울 교대역" sub_name "주중" vs
    // `_id: 675ab6d6...` "서울 등교 추가 교대역" sub_name "월요일")를 따라,
    // 매일 도는 기본 배차(화~금 → "주중")는 "등교 추가" 없이 "서울 OO역"으로,
    // 특정 요일에만 도는 추가 배차만 "서울 등교 추가 OO역"으로 나눈다. 도착
    // 시각이 같은 월(2호차)와 화~금은 같은 물리적 배차라 하나로 합쳐져
    // "서울 교대역(주중)"이 되고, 시각이 다른 월(1호차)만 별도 "추가" 문서로
    // 남는다(번호는 같은 요일 그룹에 배차가 여전히 여러 개일 때만 붙는다) —
    // 같은 route_name 아래 sub_name만 다르게 묶으면 앱에서 같은 이름 노선이
    // 두 번 뜨는 문제가 있었다. 요일은 route_name 뒤 괄호(→ sub_name)로 담는다.
    expect(seoulRoutes.map((r) => r.route.route_name).sort()).toEqual([
      '서울 교대역(주중)',
      '서울 등교 추가 교대역(월요일)',
      '서울 등교 추가 동천역(월요일)',
    ]);

    const gyodaeExtra = seoulRoutes.find((r) => r.route.route_name === '서울 등교 추가 교대역(월요일)')!;
    expect(gyodaeExtra.route.node_info).toEqual([{ name: '교대역' }, { name: '동천역' }, { name: '대학' }]);
    // KOIN 사이트는 route_type이 WEEKDAYS(통학)인 노선의 등교/하교를
    // route_info[].name이 정확히 "등교"/"하교"인지로 구분하므로, name 자체는
    // 그대로 둔다.
    expect(gyodaeExtra.route.route_info).toEqual([
      { name: '등교', running_days: ['MON'], arrival_time: ['07:10', null, '08:40'] },
    ]);

    const gyodaeBase = seoulRoutes.find((r) => r.route.route_name === '서울 교대역(주중)')!;
    expect(gyodaeBase.route.route_info).toEqual([
      {
        name: '등교',
        running_days: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
        arrival_time: ['07:20', '07:40', '08:50'],
      },
    ]);

    const dongcheon = seoulRoutes.find((r) => r.route.route_name === '서울 등교 추가 동천역(월요일)')!;
    expect(dongcheon.route.node_info).toEqual([{ name: '동천역' }, { name: '대학' }]);
    expect(dongcheon.route.route_info).toHaveLength(1);
    expect(dongcheon.route.route_info[0]).toMatchObject({
      name: '등교',
      arrival_time: ['07:30', '08:40'],
    });
  });

  it("서울 하교는 '노선' 헤더 없이 한 칸에 뭉친 요일별 출발시각을 회차로 나눈다", () => {
    const seoulReturn: AnalysedWorkbook = {
      sheets: [
        {
          name: 'REGULAR',
          cells: [
            cell(0, 1, '서울(월~금요일) 안내'),
            cell(5, 1, '대학'),
            cell(5, 4, '14:10(금), 18:10(월~금)'),
            cell(6, 1, '죽전'),
            cell(6, 4, '하차'),
            cell(7, 1, '교대'),
            cell(7, 4, '하차'),
          ],
          merges: [],
        },
      ],
      tables: [],
    };

    const routes = parseStructuredWorkbook(seoulReturn);
    const returns = routes.filter((r) => r.route.region === '서울' && r.route.route_type === '하교');
    // 매일 도는 기본 배차(월~금)는 등교 쪽 기본 배차와 같은 이름
    // (SEOUL_BASE_ROUTE_NAME="서울 교대역")을 써야 admin API 전송 직전
    // mergeCommutingDirections가 한 문서로 합친다. 특정 요일(금)에만 도는
    // 추가 배차는 "서울 하교 추가"로 나뉜다. 같은 요일 그룹에 배차가 하나뿐
    // 이면 번호는 붙지 않는다.
    expect(returns.map((r) => r.route.route_name).sort()).toEqual(['서울 교대역(주중)', '서울 하교 추가(금요일)']);

    const friday = returns.find((r) => r.route.route_name === '서울 하교 추가(금요일)')!;
    expect(friday.route.node_info).toEqual([{ name: '대학' }, { name: '죽전' }, { name: '교대' }]);
    expect(friday.route.route_info).toEqual([
      {
        name: '하교',
        running_days: ['FRI'],
        arrival_time: ['14:10', '하차', '하차'],
      },
    ]);

    const weekday = returns.find((r) => r.route.route_name === '서울 교대역(주중)')!;
    expect(weekday.route.route_info).toEqual([
      {
        name: '하교',
        running_days: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
        arrival_time: ['18:10', '하차', '하차'],
      },
    ]);
  });

  it('통학 표 제목에 요일이 없으면(예: 세종) 평일 운행을 기본값으로 둔다', () => {
    const noDayTitle: AnalysedWorkbook = {
      sheets: [
        {
          name: 'REGULAR',
          cells: [
            cell(0, 1, '세종 등교/하교'),
            cell(1, 1, '정류장'),
            cell(1, 4, '예정시간'),
            cell(2, 1, '정류장A'),
            cell(2, 4, '07:20'),
            cell(3, 1, '대학'),
            cell(3, 4, '08:50'),
          ],
          merges: [],
        },
      ],
      tables: [],
    };

    const routes = parseStructuredWorkbook(noDayTitle);
    const route = routes.find((r) => r.target === 'commuting');
    expect(route).toBeDefined();
    expect(route!.route.route_info[0].running_days).toEqual(['MON', 'TUE', 'WED', 'THU', 'FRI']);
  });

  it('특정 요일 하나로만 도는 화살표 노선(예: 대전)은 요일을 route_name 괄호에 남긴다', () => {
    // KOIN Admin API는 running_days를 보내지 않고 commuting route_type도
    // "주중" 고정이라, "일요일에만 등교" 같은 제한은 route_name 끝 괄호
    // (→ sub_name)로만 살아남는다. 안 붙이면 조용히 사라진다.
    const daejeon: AnalysedWorkbook = {
      sheets: [
        {
          name: 'REGULAR',
          cells: [cell(0, 1, '(일요일)대전역→대전복합터미널→대학'), cell(0, 3, '18:10')],
          merges: [],
        },
      ],
      tables: [],
    };

    const routes = parseStructuredWorkbook(daejeon);
    const route = routes.find((r) => r.route.region === '대전');
    expect(route).toBeDefined();
    expect(route!.route.route_name).toBe('대전(일요일)');
    expect(route!.route.route_info[0].running_days).toEqual(['SUN']);
  });

  it("한 셀에 쉼표/마침표로 묶인 정류장(예: '동우@,신계초,운전리.연춘리')을 각각 나눈다", () => {
    const wb: AnalysedWorkbook = {
      sheets: [
        {
          name: 'REGULAR',
          cells: [
            cell(1, 1, '천안 지역 등교'),
            cell(2, 1, '정류장'),
            cell(2, 2, '천안역'),
            cell(3, 1, '천안역'),
            cell(4, 1, '삼룡교(유니클로, 구 한방병원)'),
            cell(5, 1, '동우@,신계초,운전리.연춘리'),
            cell(6, 1, '대학'),
            cell(3, 2, '08:00'),
            cell(4, 2, '08:10'),
            cell(5, 2, '승하차'),
            cell(6, 2, '08:50'),
          ],
          merges: [],
        },
      ],
      tables: [],
    };

    const routes = parseStructuredWorkbook(wb);
    const route = routes.find((r) => r.route.route_name === '천안역(주중)')!;
    expect(route.route.node_info.map((node) => node.name)).toEqual([
      '천안역',
      '삼룡교(유니클로, 구 한방병원)',
      '동우@',
      '신계초',
      '운전리',
      '연춘리',
      '대학',
    ]);
    expect(route.route.route_info[0].arrival_time).toEqual([
      '08:00',
      '08:10',
      '승하차',
      '승하차',
      '승하차',
      '승하차',
      '08:50',
    ]);
  });
});
