import { describe, expect, it } from 'vitest';
import { synthesizeReturnRoutes } from '~/services/bus/deterministicSynthesis';
import type { AnalysedWorkbook } from '~/services/bus/excelAnalyzer';
import type { BusRoute } from '~/services/bus/types';

const cell = (row: number, column: number, value: unknown) => ({ row, column, value });

const workbookOf = (cells: Array<{ row: number; column: number; value: unknown }>): AnalysedWorkbook => ({
  sheets: [{ name: '노선표', cells, merges: [] }],
  tables: [],
});

const cheonanStation = (): BusRoute => ({
  region: '천안',
  route_type: '등교',
  route_name: '천안역',
  node_info: [
    { name: '천안역' },
    { name: '한양수자인' },
    { name: '청당동' },
    { name: '부영@' },
    { name: '동우@,신계초' },
    { name: '중앙@' },
    { name: '대학(본교)' },
  ],
  route_info: [
    {
      name: '1회',
      running_days: ['MON', 'TUE', 'WED', 'THU', 'FRI'],
      arrival_time: ['08:10', '08:18', '08:21', '08:26', '승하차', '승하차', '08:50'],
    },
  ],
});

describe('synthesizeReturnRoutes: 등교 노선 역순 하교 자동 생성', () => {
  it('REGULAR 섹션 제목의 역행 규칙을 읽어 대학 종차행 노선을 역순으로 미러링한다', () => {
    const wb = workbookOf([cell(1, 6, '천안 지역 등교 / 하교(18:10 등교 노선 역순)')]);
    const warnings: string[] = [];

    const result = synthesizeReturnRoutes([cheonanStation()], wb, warnings);

    expect(result).toHaveLength(2);
    const 하교 = result[1];
    expect(하교).toMatchObject({ region: '천안', route_type: '하교', route_name: '천안역' });
    // KOIN 사이트는 route_type이 WEEKDAYS(통학)인 노선의 등교/하교를
    // route_info[].name이 정확히 "등교"/"하교"인지로 구분한다. 등교 원본의
    // trip.name("1회")을 그대로 베끼면 하교도 "등교"로 잘못 분류된다.
    for (const trip of 하교.route_info) expect(trip.name).toBe('하교');
    // 정류장 순서는 등교와 그대로 같다(뒤집지 않는다) — 실제 반영 시 등교/
    // 하교가 한 문서의 route_info 배열로 병합되려면 같은 node_info 순서를
    // 공유해야 한다.
    expect(하교.node_info.map((node) => node.name)).toEqual([
      '천안역',
      '한양수자인',
      '청당동',
      '부영@',
      '동우@,신계초',
      '중앙@',
      '대학(본교)',
    ]);
    expect(하교.route_info[0].arrival_time).toEqual(['18:50', '18:42', '18:39', '18:34', '하차', '하차', '18:10']);
    expect(하교.route_info[0].running_days).toEqual(['MON', 'TUE', 'WED', 'THU', 'FRI']);
    expect(warnings).toEqual(['천안 하교는 등교 노선 역순(18:10 출발)으로 자동 계산해 추가했습니다.']);
  });

  it('계절 시트의 노트 셀에서 안내를 읽고, 같은 열 위 헤딩에서 지역을 찾는다', () => {
    const wb = workbookOf([cell(10, 13, '청주 지역 등교 / 하교'), cell(20, 13, '■ 하교는 역순으로 18:10 출발')]);
    const route: BusRoute = { ...cheonanStation(), region: '청주', route_name: '동남지구' };
    const warnings: string[] = [];

    const result = synthesizeReturnRoutes([route], wb, warnings);

    const 하교 = result.at(-1);
    expect(하교?.region).toBe('청주');
    expect(하교?.route_type).toBe('하교');
    expect(하교?.route_name).toBe('동남지구');
    expect(warnings).toEqual(['청주 하교는 등교 노선 역순(18:10 출발)으로 자동 계산해 추가했습니다.']);
  });

  it('정차 마커는 하차로, null은 null로 역전시킨다', () => {
    const wb = workbookOf([cell(1, 6, '청주 지역 등교 / 하교(18:10 등교 노선 역순)')]);
    const route: BusRoute = {
      region: '청주',
      route_type: '등교',
      route_name: 'KTX',
      node_info: [{ name: '온양온천역' }, { name: '정차장A' }, { name: '대학(본교)' }],
      route_info: [{ name: '1회', arrival_time: ['08:00', null, '08:50'] }],
    };
    const warnings: string[] = [];

    const [, 하교] = synthesizeReturnRoutes([route], wb, warnings);

    expect(하교).toBeDefined();
    expect(하교!.node_info.map((node) => node.name)).toEqual(['온양온천역', '정차장A', '대학(본교)']);
    expect(하교!.route_info[0].arrival_time).toEqual(['19:00', null, '18:10']);
    expect(warnings).toEqual(['청주 하교는 등교 노선 역순(18:10 출발)으로 자동 계산해 추가했습니다.']);
  });

  it('같은 지역·노선명의 명시 하교가 있으면 중복 생성을 건너뜬다', () => {
    const wb = workbookOf([cell(1, 6, '천안 지역 등교 / 하교(18:10 등교 노선 역순)')]);
    const handwritten: BusRoute = { ...cheonanStation(), route_type: '하교' };
    const warnings: string[] = [];

    const result = synthesizeReturnRoutes([cheonanStation(), handwritten], wb, warnings);

    expect(result).toEqual([cheonanStation(), handwritten]);
    expect(warnings).toEqual([]);
  });

  it('명시 하교가 다른 지역이면 합성한다', () => {
    const wb = workbookOf([cell(1, 6, '천안 지역 등교 / 하교(18:10 등교 노선 역순)')]);
    const handwritten: BusRoute = { ...cheonanStation(), region: '청주', route_type: '하교', route_name: '터널' };
    const warnings: string[] = [];

    const result = synthesizeReturnRoutes([cheonanStation(), handwritten], wb, warnings);

    expect(result.map((route) => route.route_type)).toEqual(['등교', '하교', '하교']);
    expect(result.at(-1)?.region).toBe('천안');
    expect(warnings).toEqual(['천안 하교는 등교 노선 역순(18:10 출발)으로 자동 계산해 추가했습니다.']);
  });

  it('종착이 대학/본교가 아닌 노선은 합성하지 않는다', () => {
    const wb = workbookOf([cell(1, 6, '천안 지역 등교 / 하교(18:10 등교 노선 역순)')]);
    const route: BusRoute = {
      ...cheonanStation(),
      node_info: [...cheonanStation().node_info.slice(0, -1), { name: '터미널' }],
    };
    const warnings: string[] = [];

    const result = synthesizeReturnRoutes([route], wb, warnings);

    expect(result).toEqual([route]);
    expect(warnings).toEqual([]);
  });

  it('역행 규칙이 없으면 입력을 그대로 돌려주고 경고도 없다', () => {
    const warnings: string[] = [];
    const result = synthesizeReturnRoutes([cheonanStation()], workbookOf([]), warnings);
    expect(result).toEqual([cheonanStation()]);
    expect(warnings).toEqual([]);
  });

  it('마지막 도착시각이 시각이 아니면 해당 노선을 건너뛰고 경고를 남긴다', () => {
    const wb = workbookOf([cell(1, 6, '천안 지역  등교 / 하교(18:10 등교 노선 역순)')]);
    const route: BusRoute = {
      ...cheonanStation(),
      route_info: [{ name: '1회', arrival_time: ['08:10', '종점'] }],
    };
    const warnings: string[] = [];

    const result = synthesizeReturnRoutes([route], wb, warnings);

    expect(result).toEqual([route]);
    expect(warnings).toEqual(['천안 천안역: 종착 도착시각을 읽을 수 없어 하교 자동 생성을 건너뜁니다.']);
  });

  it('같은 지역 여러 노선은 하나의 요약 경고만 남긴다', () => {
    const wb = workbookOf([cell(1, 6, '천안 지역 등교 / 하교(18:10 등교 노선 역순)')]);
    const second: BusRoute = { ...cheonanStation(), route_name: '터미널' };
    const warnings: string[] = [];

    synthesizeReturnRoutes([cheonanStation(), second], wb, warnings);

    expect(warnings).toEqual(['천안 하교는 등교 노선 역순(18:10 출발)으로 자동 계산해 추가했습니다.']);
  });
});
