import { describe, expect, it } from 'vitest';
import {
  applyBusPatchesToConversions,
  buildRouteList,
  planBusPatches,
  resolvePatch,
  resolvePatches,
  type RawPatch,
} from '~/services/bus/patch';
import type { BusConversion, BusRoute } from '~/services/bus/types';
import { validateConversion } from '~/services/bus/validation';

const route = (over = {}): BusRoute => ({
  region: '천안',
  route_type: '등교',
  route_name: '천안역',
  node_info: [{ name: '터미널' }, { name: '천안역 (학화호두과자 앞)' }, { name: '대학(본교)' }],
  route_info: [
    {
      name: '1회',
      running_days: ['MON', 'TUE', 'WED', 'THU', 'FRI'] as BusRoute['route_info'][number]['running_days'],
      arrival_time: ['08:10', '08:15', '08:50'],
    },
    {
      name: '2회',
      arrival_time: ['09:10', null, '09:50'],
    },
  ],
  ...over,
});

const conversion = (over = {}): BusConversion => ({
  payloads: [
    {
      target: 'commuting',
      semester_type: 'REGULAR',
      body: { commuting_bus_timetables: [route()] },
    },
    {
      target: 'shuttle',
      semester_type: 'REGULAR',
      body: { shuttle_bus_timetables: [route({ route_type: '셔틀', route_name: '천안 셔틀' })] },
    },
  ],
  version_update: {
    type: 'shuttle_bus_timetable',
    title: '정규학기',
    content: '2025-03-03~2025-06-20',
  },
  provenance: {},
  warnings: [],
  ...over,
});

describe('버스 수정 적용', () => {
  it('원본을 건드리지 않는다', () => {
    const original = conversion();
    const before = structuredClone(original);

    applyBusPatchesToConversions(
      [original],
      [
        {
          semester: 'REGULAR',
          target: 'commuting',
          region: '천안',
          routeType: '등교',
          routeName: '천안역',
          kind: 'arrival_time',
          tripName: '1회',
          stopName: '터미널',
          before: '08:10',
          after: '08:05',
          rawValue: '08:05',
          value: '08:05',
        },
      ],
    );

    expect(original).toEqual(before);
  });

  it('도착시각을 바꾼다', () => {
    const [next] = applyBusPatchesToConversions(
      [conversion()],
      [
        {
          semester: 'REGULAR',
          target: 'commuting',
          region: '천안',
          routeType: '등교',
          routeName: '천안역',
          kind: 'arrival_time',
          tripName: '1회',
          stopName: '터미널',
          before: '08:10',
          after: '08:05',
          rawValue: '08:05',
          value: '08:05',
        },
      ],
    );
    const target = Object.values(next.payloads[0].body)[0][0];
    expect(target.route_info[0].arrival_time[0]).toBe('08:05');
    expect(target.route_info[1].arrival_time[0]).toBe('09:10');
    expect(validateConversion(next)).toBeTruthy();
  });

  it('노선명을 바꾸고, 같은 요청의 뒤따르는 패치가 새 이름을 따라잡는다', () => {
    const [next] = applyBusPatchesToConversions(
      [conversion()],
      [
        {
          semester: 'REGULAR',
          target: 'commuting',
          region: '천안',
          routeType: '등교',
          routeName: '천안역',
          kind: 'route_name',
          before: '천안역',
          after: '천안역1',
          rawValue: '천안역1',
          value: '천안역1',
        },
        {
          semester: 'REGULAR',
          target: 'commuting',
          region: '천안',
          routeType: '등교',
          routeName: '천안역1',
          kind: 'arrival_time',
          tripName: '2회',
          stopName: '대학(본교)',
          before: '09:50',
          after: '10:00',
          rawValue: '10:00',
          value: '10:00',
        },
      ],
    );
    const target = Object.values(next.payloads[0].body)[0][0];
    expect(target.route_name).toBe('천안역1');
    expect(target.route_info[1].arrival_time[2]).toBe('10:00');
    expect(validateConversion(next)).toBeTruthy();
  });

  it('운행요일을 바꾼다', () => {
    const [next] = applyBusPatchesToConversions(
      [conversion()],
      [
        {
          semester: 'REGULAR',
          target: 'commuting',
          region: '천안',
          routeType: '등교',
          routeName: '천안역',
          kind: 'running_days',
          tripName: '1회',
          before: '월~금',
          after: '월,수,금',
          rawValue: '월수금',
          days: ['MON', 'WED', 'FRI'],
        },
      ],
    );
    const target = Object.values(next.payloads[0].body)[0][0];
    expect(target.route_info[0].running_days).toEqual(['MON', 'WED', 'FRI']);
    expect(target.route_info[1].running_days).toBeUndefined();
  });

  it('적용 기간을 바꾼다', () => {
    const [next] = applyBusPatchesToConversions(
      [conversion()],
      [
        {
          semester: 'REGULAR',
          target: 'commuting',
          region: '',
          routeType: '',
          routeName: '',
          kind: 'period',
          before: '2025-03-03~2025-06-20',
          after: '2025-03-02~2025-06-19',
          rawValue: '2025-03-02~2025-06-19',
          value: '2025-03-02~2025-06-19',
        },
      ],
    );
    expect(next.version_update.content).toBe('2025-03-02~2025-06-19');
  });

  it('회차를 삭제한다', () => {
    const [next] = applyBusPatchesToConversions(
      [conversion()],
      [
        {
          semester: 'REGULAR',
          target: 'commuting',
          region: '천안',
          routeType: '등교',
          routeName: '천안역',
          kind: 'remove_trip',
          tripName: '2회',
          before: '2회 삭제',
          after: '삭제',
          rawValue: '2회',
        },
      ],
    );
    const target = Object.values(next.payloads[0].body)[0][0];
    expect(target.route_info).toHaveLength(1);
    expect(validateConversion(next)).toBeTruthy();
  });

  it('정류장을 삭제하면 모든 회차에서 빠진다', () => {
    const [next] = applyBusPatchesToConversions(
      [conversion()],
      [
        {
          semester: 'REGULAR',
          target: 'commuting',
          region: '천안',
          routeType: '등교',
          routeName: '천안역',
          kind: 'remove_stop',
          stopName: '천안역 (학화호두과자 앞)',
          before: '삭제',
          after: '삭제',
          rawValue: '천안역',
        },
      ],
    );
    const target = Object.values(next.payloads[0].body)[0][0];
    expect(target.node_info).toHaveLength(2);
    for (const trip of target.route_info) expect(trip.arrival_time).toHaveLength(2);
    expect(validateConversion(next)).toBeTruthy();
  });

  it('회차를 추가한다', () => {
    const [next] = applyBusPatchesToConversions(
      [conversion()],
      [
        {
          semester: 'REGULAR',
          target: 'commuting',
          region: '천안',
          routeType: '등교',
          routeName: '천안역',
          kind: 'add_trip',
          tripName: '3회',
          before: '-',
          after: '3회 추가',
          rawValue: '3회',
          value: '10:10',
        },
      ],
    );
    const target = Object.values(next.payloads[0].body)[0][0];
    expect(target.route_info).toHaveLength(3);
    expect(target.route_info[2].arrival_time).toEqual(['10:10', null, null]);
    expect(validateConversion(next)).toBeTruthy();
  });

  it('정류장을 추가한다', () => {
    const [next] = applyBusPatchesToConversions(
      [conversion()],
      [
        {
          semester: 'REGULAR',
          target: 'commuting',
          region: '천안',
          routeType: '등교',
          routeName: '천안역',
          kind: 'add_stop',
          before: '-',
          after: '두정역 추가',
          rawValue: '두정역',
          addStop: { name: '두정역', afterStop: '터미널' },
        },
      ],
    );
    const target = Object.values(next.payloads[0].body)[0][0];
    expect(target.node_info.map((node) => node.name)).toEqual([
      '터미널',
      '두정역',
      '천안역 (학화호두과자 앞)',
      '대학(본교)',
    ]);
    for (const trip of target.route_info) expect(trip.arrival_time).toHaveLength(4);
    expect(validateConversion(next)).toBeTruthy();
  });

  it('노선을 삭제한다', () => {
    const [next] = applyBusPatchesToConversions(
      [conversion()],
      [
        {
          semester: 'REGULAR',
          target: 'commuting',
          region: '천안',
          routeType: '등교',
          routeName: '천안역',
          kind: 'remove_route',
          before: '천안역 삭제',
          after: '삭제',
          rawValue: '천안역',
        },
      ],
    );
    const remaining = Object.values(next.payloads[0].body)[0];
    expect(remaining).toHaveLength(0);
    expect(() => validateConversion(next)).toThrow();
  });

  it('다른 학기의 노선은 건드리지 않는다', () => {
    const [next] = applyBusPatchesToConversions(
      [conversion()],
      [
        {
          semester: 'REGULAR',
          target: 'shuttle',
          region: '천안',
          routeType: '셔틀',
          routeName: '천안 셔틀',
          kind: 'arrival_time',
          tripName: '1회',
          stopName: '터미널',
          before: '08:10',
          after: '12:00',
          rawValue: '12:00',
          value: '12:00',
        },
      ],
    );
    const commuting = Object.values(next.payloads[0].body)[0][0];
    const shuttle = Object.values(next.payloads[1].body)[0][0];
    expect(commuting.route_info[0].arrival_time[0]).toBe('08:10');
    expect(shuttle.route_info[0].arrival_time[0]).toBe('12:00');
  });

  it('없는 정류장을 삭제하면 오류를 던진다', () => {
    expect(() =>
      applyBusPatchesToConversions(
        [conversion()],
        [
          {
            semester: 'REGULAR',
            target: 'commuting',
            region: '천안',
            routeType: '등교',
            routeName: '천안역',
            kind: 'remove_stop',
            stopName: '없는 정류장',
            before: '삭제',
            after: '삭제',
            rawValue: '없는 정류장',
          },
        ],
      ),
    ).toThrow(/정류장을 찾지 못했습니다/);
  });

  it('없는 기준 정류장에 정류장을 추가하면 오류를 던진다', () => {
    expect(() =>
      applyBusPatchesToConversions(
        [conversion()],
        [
          {
            semester: 'REGULAR',
            target: 'commuting',
            region: '천안',
            routeType: '등교',
            routeName: '천안역',
            kind: 'add_stop',
            before: '-',
            after: '두정역 추가',
            rawValue: '두정역',
            addStop: { name: '두정역', afterStop: '없는 기준' },
          },
        ],
      ),
    ).toThrow(/정류장 위치를 찾지 못했습니다/);
  });

  it('없는 정류장의 도착시각을 바꾸면 오류를 던진다', () => {
    expect(() =>
      applyBusPatchesToConversions(
        [conversion()],
        [
          {
            semester: 'REGULAR',
            target: 'commuting',
            region: '천안',
            routeType: '등교',
            routeName: '천안역',
            kind: 'arrival_time',
            tripName: '1회',
            stopName: '없는 정류장',
            before: '08:10',
            after: '08:05',
            rawValue: '08:05',
            value: '08:05',
          },
        ],
      ),
    ).toThrow(/정류장을 찾지 못했습니다/);
  });
});

describe('버스 수정 요청 해석 (LLM 없이 코드 가드)', () => {
  const raw = (over: Partial<RawPatch> = {}): RawPatch => ({
    semester: '정규학기',
    region: '천안',
    direction: '등교',
    route: '천안역',
    field: 'remove_route',
    trip: '',
    stop: '',
    value: '',
    days: '',
    newStop: '',
    referenceStop: '',
    position: '',
    ...over,
  });

  it('마지막 남은 노선 삭제는 미리보기 단계에서 막는다', () => {
    const problems: string[] = [];
    const patch = resolvePatch(raw(), [conversion()], problems);

    expect(patch).toBeNull();
    expect(problems.join(' ')).toMatch(/마지막 남은 노선/);
  });

  it('둘 이상 노선 중 하나는 삭제할 수 있다', () => {
    const two = conversion();
    (two.payloads[0].body.commuting_bus_timetables as BusRoute[]).push(route({ route_name: '터미널' }));
    const problems: string[] = [];
    const patch = resolvePatch(raw(), [two], problems);

    expect(patch?.kind).toBe('remove_route');
    expect(patch?.routeName).toBe('천안역');
    expect(problems).toHaveLength(0);
  });

  it('LLM이 존재하지 않는 학기를 내놓으면 변환 목록이 하나뿐일 때 fallback', () => {
    const problems: string[] = [];
    const patch = resolvePatch(
      {
        semester: '방학기간',
        region: '천안',
        direction: '등교',
        route: '천안역',
        field: 'arrival_time',
        trip: '1회',
        stop: '터미널',
        value: '08:05',
      } as RawPatch,
      [conversion()],
      problems,
    );
    expect(patch).not.toBeNull();
    expect(patch?.semester).toBe('REGULAR');
    expect(problems).toHaveLength(0);
  });

  it('정류장 이름이 일부만 일치해도 partial match로 찾는다', () => {
    const problems: string[] = [];
    const patch = resolvePatch(
      {
        semester: '정규학기',
        region: '천안',
        direction: '등교',
        route: '천안역',
        field: 'arrival_time',
        trip: '1회',
        stop: '천안역',
        value: '08:05',
      } as RawPatch,
      [conversion()],
      problems,
    );
    expect(patch).not.toBeNull();
    expect(patch?.stopName).toBe('천안역 (학화호두과자 앞)');
    expect(problems).toHaveLength(0);
  });

  it('정류장 부분 일치가 여러 개면 반려하고 안내한다', () => {
    const problems: string[] = [];
    const patch = resolvePatch(
      {
        semester: '정규학기',
        region: '천안',
        direction: '등교',
        route: '천안역',
        field: 'arrival_time',
        trip: '1회',
        stop: '학',
        value: '08:05',
      } as RawPatch,
      [conversion()],
      problems,
    );
    expect(patch).toBeNull();
    expect(problems.join(' ')).toMatch(/여러 개 일치/);
  });

  it('회차가 하나뿐이면 이름을 쓰지 않아도 자동으로 고른다', () => {
    const single = conversion();
    (single.payloads[0].body.commuting_bus_timetables as BusRoute[])[0].route_info = [
      { name: '1회', running_days: ['MON'], arrival_time: ['08:10', '08:50'] },
    ];
    const problems: string[] = [];
    const patch = resolvePatch(
      {
        semester: '정규학기',
        region: '천안',
        direction: '등교',
        route: '천안역',
        field: 'arrival_time',
        trip: '',
        stop: '터미널',
        value: '08:05',
      } as RawPatch,
      [single],
      problems,
    );
    expect(patch).not.toBeNull();
    expect(patch?.tripName).toBe('1회');
    expect(problems).toHaveLength(0);
  });

  it('route hint 없이 region+direction만으로 노선을 찾는다', () => {
    const problems: string[] = [];
    const patch = resolvePatch(
      {
        semester: '정규학기',
        region: '천안',
        direction: '셔틀',
        route: '',
        field: 'arrival_time',
        trip: '1회',
        stop: '터미널',
        value: '12:00',
      } as RawPatch,
      [conversion()],
      problems,
    );
    expect(patch).not.toBeNull();
    expect(patch?.routeName).toBe('천안 셔틀');
    expect(problems).toHaveLength(0);
  });

  it('route hint로 부분 매칭해서 노선을 찾는다', () => {
    const problems: string[] = [];
    const patch = resolvePatch(
      {
        semester: '정규학기',
        region: '천안',
        direction: '셔틀',
        route: '셔틀',
        field: 'arrival_time',
        trip: '1회',
        stop: '터미널',
        value: '12:00',
      } as RawPatch,
      [conversion()],
      problems,
    );
    expect(patch).not.toBeNull();
    expect(patch?.routeName).toBe('천안 셔틀');
    expect(problems).toHaveLength(0);
  });

  it('route hint 없고 region+direction도 모호하면 에러 메시지에 지역·방향을 표시한다', () => {
    const problems: string[] = [];
    const patch = resolvePatch(
      {
        semester: '정규학기',
        region: '대전',
        direction: '등교',
        route: '',
        field: 'arrival_time',
        trip: '1회',
        stop: '터미널',
        value: '08:05',
      } as RawPatch,
      [conversion()],
      problems,
    );
    expect(patch).toBeNull();
    expect(problems.join(' ')).toMatch(/대전 등교.*찾지 못했습니다/);
  });

  // 실제로 겪은 버그: 하계 계절학기·방학기간 시간표만 있는 파일(정규학기 없음)에서
  // "!수정 천안 등교 터미널/천안역 운행요일 ..."처럼 학기를 말하지 않으면, LLM은
  // 노선 목록만 보고 학기는 못 봐서 "정규학기"로 찍는다. 예전 코드는 그 hallucination을
  // 그대로 믿고 conversions.length===1(학기가 하나뿐인지)만 확인했는데, 계절학기+방학기간
  // 두 개라 이 조건도 안 맞아 "정규학기의 변환 결과가 없습니다"로 잘못 반려했다.
  it('LLM이 존재하지 않는 학기를 내놓아도, 노선이 실제 학기 하나에서만 찾아지면 그 학기로 확정한다', () => {
    const seasonal = conversion({
      payloads: [
        {
          target: 'commuting',
          semester_type: 'SEASONAL',
          body: { commuting_bus_timetables: [route({ route_name: '터미널/천안역' })] },
        },
      ],
    });
    const vacation = conversion({
      payloads: [
        {
          target: 'commuting',
          semester_type: 'VACATION',
          body: {
            commuting_bus_timetables: [route({ route_name: '두정역/KTX' })],
          },
        },
      ],
    });
    const problems: string[] = [];
    const patch = resolvePatch(
      {
        semester: '정규학기', // LLM의 hallucination — 실제로는 REGULAR가 없다.
        region: '천안',
        direction: '등교',
        route: '터미널/천안역',
        field: 'running_days',
        trip: '1회',
        stop: '',
        value: '',
        days: '월화수목금',
      } as RawPatch,
      [seasonal, vacation],
      problems,
    );

    expect(problems).toHaveLength(0);
    expect(patch).not.toBeNull();
    expect(patch?.semester).toBe('SEASONAL');
    expect(patch?.routeName).toBe('터미널/천안역');
  });

  it('같은 이름의 노선이 여러 학기에 걸쳐 있으면 학기를 지정해달라고 안내한다', () => {
    const seasonal = conversion({
      payloads: [
        {
          target: 'commuting',
          semester_type: 'SEASONAL',
          body: { commuting_bus_timetables: [route({ route_name: '터미널/천안역' })] },
        },
      ],
    });
    const vacation = conversion({
      payloads: [
        {
          target: 'commuting',
          semester_type: 'VACATION',
          body: { commuting_bus_timetables: [route({ route_name: '터미널/천안역' })] },
        },
      ],
    });
    const problems: string[] = [];
    const patch = resolvePatch(
      {
        semester: '정규학기',
        region: '천안',
        direction: '등교',
        route: '터미널/천안역',
        field: 'running_days',
        trip: '1회',
        stop: '',
        value: '',
        days: '월화수목금',
      } as RawPatch,
      [seasonal, vacation],
      problems,
    );

    expect(patch).toBeNull();
    expect(problems.join(' ')).toMatch(/여러 학기에 걸쳐.*계절학기.*방학기간/);
  });

  it('실제 존재하는 학기를 명시하면 그 학기 안에서만 찾는다', () => {
    const seasonal = conversion({
      payloads: [
        {
          target: 'commuting',
          semester_type: 'SEASONAL',
          body: { commuting_bus_timetables: [route({ route_name: '터미널/천안역' })] },
        },
      ],
    });
    const vacation = conversion({
      payloads: [
        {
          target: 'commuting',
          semester_type: 'VACATION',
          body: { commuting_bus_timetables: [route({ route_name: '터미널/천안역' })] },
        },
      ],
    });
    const problems: string[] = [];
    const patch = resolvePatch(
      {
        semester: '방학기간',
        region: '천안',
        direction: '등교',
        route: '터미널/천안역',
        field: 'running_days',
        trip: '1회',
        stop: '',
        value: '',
        days: '월화수목금',
      } as RawPatch,
      [seasonal, vacation],
      problems,
    );

    expect(problems).toHaveLength(0);
    expect(patch?.semester).toBe('VACATION');
  });
});

describe('resolvePatches (회차 범위 전개)', () => {
  const shuttleWithSevenTrips = () =>
    conversion({
      payloads: [
        {
          target: 'shuttle',
          semester_type: 'REGULAR',
          body: {
            shuttle_bus_timetables: [
              route({
                route_type: '셔틀',
                route_name: '천안 셔틀',
                route_info: Array.from({ length: 7 }, (_, i) => ({
                  name: `${i + 1}회`,
                  arrival_time: ['08:00'],
                })),
              }),
            ],
          },
        },
      ],
    });

  // 실제로 겪은 버그: "1회부터 7회까지"/"1회~7회" 같은 회차 범위를 LLM이 스스로
  // 여러 patch로 쪼개려다 노선명에 이상한 값을 채우거나("천안 셔틀 천안 셔틀")
  // "확정할 수 없다"며 통째로 포기했다. 이제 범위 텍스트를 trip에 그대로 받아
  // 코드가 실제 회차 목록과 대조해서 펼친다.
  it("'1회부터 7회까지'를 실제 회차 7개로 펼친다", () => {
    const problems: string[] = [];
    const patches = resolvePatches(
      {
        semester: '정규학기',
        region: '천안',
        direction: '셔틀',
        route: '천안 셔틀',
        field: 'running_days',
        trip: '1회부터 7회까지',
        stop: '',
        value: '',
        days: '월화수목금',
      } as RawPatch,
      [shuttleWithSevenTrips()],
      problems,
    );

    expect(problems).toHaveLength(0);
    expect(patches).toHaveLength(7);
    expect(patches.map((p) => p.tripName)).toEqual(['1회', '2회', '3회', '4회', '5회', '6회', '7회']);
    expect(patches.every((p) => p.kind === 'running_days')).toBe(true);
  });

  it("'1~7회' 표기도 같은 범위로 해석한다", () => {
    const problems: string[] = [];
    const patches = resolvePatches(
      {
        semester: '정규학기',
        region: '천안',
        direction: '셔틀',
        route: '천안 셔틀',
        field: 'running_days',
        trip: '1~7회',
        stop: '',
        value: '',
        days: '월화수목금',
      } as RawPatch,
      [shuttleWithSevenTrips()],
      problems,
    );

    expect(problems).toHaveLength(0);
    expect(patches).toHaveLength(7);
  });

  it('범위에 해당하는 회차가 없으면 가능한 회차를 안내한다', () => {
    const problems: string[] = [];
    const patches = resolvePatches(
      {
        semester: '정규학기',
        region: '천안',
        direction: '셔틀',
        route: '천안 셔틀',
        field: 'running_days',
        trip: '10회부터 12회까지',
        stop: '',
        value: '',
        days: '월화수목금',
      } as RawPatch,
      [shuttleWithSevenTrips()],
      problems,
    );

    expect(patches).toHaveLength(0);
    expect(problems.join(' ')).toMatch(/가능한 회차/);
  });

  it('범위가 아닌 일반 요청은 그대로 단일 patch로 처리한다', () => {
    const problems: string[] = [];
    const patches = resolvePatches(
      {
        semester: '정규학기',
        region: '천안',
        direction: '등교',
        route: '천안역',
        field: 'arrival_time',
        trip: '1회',
        stop: '터미널',
        value: '08:05',
        days: '',
        newStop: '',
        referenceStop: '',
        position: '',
      } as RawPatch,
      [conversion()],
      problems,
    );
    expect(patches).toHaveLength(1);
    expect(problems).toHaveLength(0);
  });
});

const liveAiEnabled =
  process.env.RUN_AI_LIVE_TESTS === '1' &&
  Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN);

describe.skipIf(!liveAiEnabled)('버스 수정 요청 해석', () => {
  it('도착시각 수정을 한 건으로 만든다', async () => {
    const plan = await planBusPatches('천안역 노선 1회 터미널 시간을 08:05로 바꿔줘', [conversion()]);

    expect(plan.patches).toHaveLength(1);
    expect(plan.patches[0].kind).toBe('arrival_time');
    expect(plan.patches[0].after).toBe('08:05');
  });

  it('방향까지 지정해야 여러 노선을 구분한다', async () => {
    const withBoth = conversion();
    const plan = await planBusPatches('천안역 노선 1회 터미널을 08:05로', [withBoth]);

    // 등교·하교가 같은 노선명이면 추측하지 않고 알려준다.
    expect(plan.patches).toHaveLength(0);
    expect(plan.problems.join(' ')).toMatch(/여러 노선/);
  });

  it('없는 노선은 찾지 못했다고 알린다', async () => {
    const plan = await planBusPatches('대전 노선 1회 터미널을 08:05로 바꿔줘', [conversion()]);

    expect(plan.patches).toHaveLength(0);
    expect(plan.problems.join(' ')).toMatch(/찾지 못/);
  });
});

describe('프롬프트 노선 목록 생성', () => {
  it('지역·방향·노선명을 정렬해서 중복 없이 만든다', () => {
    const two = conversion();
    (two.payloads[0].body.commuting_bus_timetables as BusRoute[]).push(route({ route_name: '터미널' }));
    const list = buildRouteList([two]);

    expect(list).toContain('천안 | 등교 | 천안역');
    expect(list).toContain('천안 | 등교 | 터미널');
    expect(list).toContain('천안 | 셔틀 | 천안 셔틀');
    expect(list.split('\n').length).toBe(3);
  });

  // 실제로 겪은 버그: "천안 셔틀 천안 셔틀"처럼 region/route_type/route_name이
  // 공백으로만 이어지면 LLM이 필드 경계를 못 읽고 노선명 전체를 되읽어 노선을
  // 못 찾는다. 구분자로 필드를 나눠야 한다.
  it('지역·방향·노선명이 공백으로 뭉개지지 않게 구분자로 나눈다', () => {
    const list = buildRouteList([conversion()]);
    expect(list).toContain('천안 | 셔틀 | 천안 셔틀');
    expect(list).not.toContain('천안 셔틀 천안 셔틀');
  });

  // 회차 정보가 없으면 "1회부터 7회까지" 같은 범위가 실제로 있는지 LLM이 확인할
  // 방법이 없어 무조건 unclear로 넘겨버렸다.
  it('각 노선의 실제 회차 이름을 함께 보여준다', () => {
    const list = buildRouteList([conversion()]);
    expect(list).toContain('회차: 1회, 2회');
  });
});
