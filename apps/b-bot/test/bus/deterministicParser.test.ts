import { describe, expect, it } from 'vitest';
import { normalizeRoute, parseCourseStopTimeTriples } from '~/services/bus/deterministicParser';
import type { AnalysedWorkbook } from '~/services/bus/excelAnalyzer';

const workbook = (cells: Array<{ row: number; column: number; value: unknown }>): AnalysedWorkbook => ({
  sheets: [{ name: '시간표', cells, merges: [] }],
  tables: [],
});

describe('normalizeRoute', () => {
  it('슬래시 주변 공백을 없애고 여백을 축소한다', () => {
    expect(normalizeRoute('천안 등하교  /  통학')).toBe('천안 등하교/통학');
  });

  it('숫자가 든 괄호 노트(운행대수)를 잘라낸다', () => {
    expect(normalizeRoute('청주 셔틀 (수 2대)')).toBe('청주 셔틀');
  });

  it('차호 괄호(1호차)는 라우트명으로 보존한다', () => {
    expect(normalizeRoute('서울 월(1호차)')).toBe('서울 월(1호차)');
    expect(normalizeRoute('서울 월(3호차)')).toBe('서울 월(3호차)');
  });

  it('시간이 든 괄호 노트(운행 방향)를 잘라낸다', () => {
    expect(normalizeRoute('세종 등교 / 하교(18:10 등교 노선 역순)')).toBe('세종 등교/하교');
  });

  it('줄바꿈을 공백으로 치환한다', () => {
    expect(normalizeRoute('세종\n통학버스')).toBe('세종 통학버스');
  });
});

describe('parseCourseStopTimeTriples', () => {
  it('유효하지 않은 시간도 정류장은 남기고 시간만 null로 둔다', () => {
    const routes = parseCourseStopTimeTriples(
      workbook([
        { row: 0, column: 0, value: '천안 등하교' },
        { row: 1, column: 0, value: '코스' },
        { row: 1, column: 1, value: '승차장소' },
        { row: 1, column: 2, value: '시간' },
        { row: 2, column: 0, value: '1코스' },
        { row: 2, column: 1, value: '정문' },
        { row: 2, column: 2, value: '08:00' },
        { row: 3, column: 0, value: '' },
        { row: 3, column: 1, value: '대학' },
        { row: 3, column: 2, value: '08:30' },
        { row: 4, column: 0, value: '' },
        { row: 4, column: 1, value: '여사울' },
        { row: 4, column: 2, value: '미정' },
      ]),
      [],
    );
    expect(routes).toHaveLength(1);
    expect(routes[0].node_info.map((node) => node.name)).toEqual(['정문', '대학', '여사울']);
    expect(routes[0].route_info[0].arrival_time).toEqual(['08:00', '08:30', null]);
  });

  it('지역·방향 탐지에 정류장 이름은 쓰지 않고 헤딩만 쓴다', () => {
    const routes = parseCourseStopTimeTriples(
      workbook([
        { row: 0, column: 0, value: '천안 등하교' },
        { row: 1, column: 0, value: '청주시청' },
        { row: 2, column: 0, value: '코스' },
        { row: 2, column: 1, value: '승차장소' },
        { row: 2, column: 2, value: '시간' },
        { row: 3, column: 0, value: '1코스' },
        { row: 3, column: 1, value: '정문' },
        { row: 3, column: 2, value: '08:00' },
        { row: 4, column: 0, value: '' },
        { row: 4, column: 1, value: '대학' },
        { row: 4, column: 2, value: '08:30' },
      ]),
      [],
    );
    expect(routes).toHaveLength(1);
    expect(routes[0].region).toBe('천안');
    expect(routes[0].route_type).toBe('등교');
  });

  it('기간 라벨 행에서 코스 표를 끊는다', () => {
    const routes = parseCourseStopTimeTriples(
      workbook([
        { row: 0, column: 0, value: '천안 등하교' },
        { row: 1, column: 0, value: '코스' },
        { row: 1, column: 1, value: '승차장소' },
        { row: 1, column: 2, value: '시간' },
        { row: 2, column: 0, value: '1코스' },
        { row: 2, column: 1, value: '정문' },
        { row: 2, column: 2, value: '08:00' },
        { row: 3, column: 0, value: '' },
        { row: 3, column: 1, value: '대학' },
        { row: 3, column: 2, value: '08:30' },
        { row: 4, column: 0, value: '계절학기 이후 방학기간' },
        { row: 4, column: 1, value: '' },
        { row: 4, column: 2, value: '' },
      ]),
      [],
    );
    expect(routes).toHaveLength(1);
    expect(routes[0].route_name).toBe('1코스');
    expect(routes[0].node_info.map((node) => node.name)).toEqual(['정문', '대학']);
  });

  it('■ 섹션 헤딩에서 코스 표를 끊는다', () => {
    const routes = parseCourseStopTimeTriples(
      workbook([
        { row: 0, column: 0, value: '천안 등하교' },
        { row: 1, column: 0, value: '코스' },
        { row: 1, column: 1, value: '승차장소' },
        { row: 1, column: 2, value: '시간' },
        { row: 2, column: 0, value: '1코스' },
        { row: 2, column: 1, value: '정문' },
        { row: 2, column: 2, value: '08:00' },
        { row: 3, column: 0, value: '' },
        { row: 3, column: 1, value: '대학' },
        { row: 3, column: 2, value: '08:30' },
        { row: 4, column: 0, value: '■ 아산 셔틀' },
        { row: 4, column: 1, value: '터미널' },
        { row: 4, column: 2, value: '09:00' },
      ]),
      [],
    );
    expect(routes).toHaveLength(1);
    expect(routes[0].route_name).toBe('1코스');
    expect(routes[0].node_info.map((node) => node.name)).toEqual(['정문', '대학']);
    expect(routes[0].route_info[0].arrival_time).toEqual(['08:00', '08:30']);
  });

  it('금,일요일처럼 나열된 요일을 running_days로 추출한다', () => {
    const routes = parseCourseStopTimeTriples(
      workbook([
        { row: 0, column: 0, value: '■ 대전 등교/하교 - 계절학기 기간 1대(금,일요일)' },
        { row: 1, column: 0, value: '코스' },
        { row: 1, column: 1, value: '승차장소' },
        { row: 1, column: 2, value: '시간' },
        { row: 2, column: 0, value: '등교시' },
        { row: 2, column: 1, value: '대전역' },
        { row: 2, column: 2, value: '18:20' },
        { row: 3, column: 0, value: '' },
        { row: 3, column: 1, value: '터미널' },
        { row: 3, column: 2, value: '18:25' },
      ]),
      [],
    );
    expect(routes).toHaveLength(1);
    expect(routes[0].route_info[0].running_days).toEqual(['FRI', 'SUN']);
  });
});
