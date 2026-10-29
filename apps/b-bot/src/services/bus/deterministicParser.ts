import type { AnalysedWorkbook } from './excelAnalyzer';
import type { BusRoute } from './types';
import { normalizeTime } from './validation';
import { sourceDays } from './days';
import { sourceRegion } from './text';

const marker = new Set(['도착', '정차', '미정차', '하차', '미하차', '승하차', '종점']);
/** True when a cell looks like a section title rather than a stop or body value. */
export const headingLike = (value: unknown) =>
  typeof value === 'string' &&
  !/^\s*-/.test(value) &&
  (/^\s*■/.test(value) || /등(?:\s*\/\s*)?하교|통학|셔틀|순환|등교|하교/.test(value));
/** 위에서부터 처음 맞는 규칙을 쓴다. "등하교"는 "하교"보다 먼저 봐야 등교로 묶인다. */
const ROUTE_TYPE_RULES = [
  [/등하교|등\s*\/\s*하교/, '등교'],
  [/등교/, '등교'],
  [/하교/, '하교'],
  [/셔틀|순환/, '셔틀'],
] as const;
const sourceRouteType = (text = '') => ROUTE_TYPE_RULES.find(([pattern]) => pattern.test(text))?.[1];

/** Canonicalizes a source route title into a stable route_name for dedupe and review. */
export function normalizeRoute(value: string) {
  return String(value)
    .replaceAll('\n', ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\s*\((?![^)]*호차)[^)]*\d[^)]*\)\s*$/, '')
    .trim();
}

/** Parses repeated [코스, 승차장소, 시간] triples, including seasonal parallel layouts. */
export function parseCourseStopTimeTriples(workbook: AnalysedWorkbook, warnings: string[]): BusRoute[] {
  const routes: BusRoute[] = [];
  for (const sheet of workbook.sheets) {
    const values = new Map(sheet.cells.map((item) => [`${item.row}:${item.column}`, item.value]));
    const at = (row: number, column: number) => values.get(`${row}:${column}`);
    for (const header of sheet.cells.filter((item) => !item.merged_from && String(item.value).trim() === '코스')) {
      const stopColumn = header.column + 1;
      const timeColumn = header.column + 2;
      if (
        !/^(승차장소|정류장)$/.test(String(at(header.row, stopColumn) ?? '').trim()) ||
        !/(시간)/.test(String(at(header.row, timeColumn) ?? ''))
      )
        continue;
      const groups = new Map<string, Array<{ name: string; time: string | null }>>();
      let course = '';
      let empty = 0;
      for (let row = header.row + 1; row < header.row + 45; row++) {
        const courseValue = at(row, header.column);
        const stop = at(row, stopColumn);
        const value = normalizeTime(at(row, timeColumn));
        if (
          row > header.row + 1 &&
          (/^\s*■/.test(String(courseValue)) ||
            /^\s*■/.test(String(stop)) ||
            /기간/.test(String(courseValue)) ||
            /기간/.test(String(stop)) ||
            (String(courseValue).trim() === '코스' && /^(승차장소|정류장)$/.test(String(stop).trim())))
        )
          break;
        if (typeof courseValue === 'string' && courseValue.trim()) course = courseValue.replaceAll('\n', ' ').trim();
        if (typeof stop !== 'string') {
          if (++empty >= 2 && groups.size) break;
          continue;
        }
        empty = 0;
        const key = course || '1회';
        groups.set(key, [
          ...(groups.get(key) ?? []),
          {
            name: stop.replaceAll('\n', ' ').trim(),
            time:
              typeof value === 'string' && (/^([01]\d|2[0-3]):[0-5]\d$/.test(value) || marker.has(value))
                ? value
                : null,
          },
        ]);
      }
      // 병합된 병렬 표 안에는 모양만 같은 빈 헤더가 생길 수 있다. 실제 운행
      // 행이 하나도 없는 헤더는 노선으로 해석하거나 경고하지 않는다.
      if (!groups.size) continue;
      const nearby = sheet.cells
        .filter(
          (item) =>
            !item.merged_from &&
            item.row < header.row &&
            // 일부 병렬 표는 동일 지역의 두 번째 코스 표가 제목에서 10행보다
            // 멀리 떨어져 있다. 현재 semester 열 영역 안에서만 넓게 탐색한다.
            item.row >= header.row - 25 &&
            item.column >= header.column - 5 &&
            item.column <= timeColumn + 2,
        )
        .sort(
          (left, right) =>
            Math.abs(left.column - header.column) - Math.abs(right.column - header.column) || right.row - left.row,
        );
      // 병렬 표에서는 오른쪽 표의 제목이 행 기준으로 더 가까울 수 있다. 코스
      // 열의 왼쪽(또는 같은 열)에 있는 지역 제목만 후보로 삼아 표 경계를 지킨다.
      // 정류장 이름 같은 본문 값이 제목으로 오인되지 않도록 헤딩처럼 보이는
      // 셀(■ 시작 또는 방향·통학 단어 포함)로만 한정한다.
      const regionText = nearby.find(
        (item) =>
          item.column <= header.column && headingLike(item.value) && sourceRegion(String(item.value)) !== undefined,
      );
      const directionText = nearby.find(
        (item) => headingLike(item.value) && /등교|하교|셔틀|순환/.test(String(item.value)),
      );
      const context = `${String(regionText?.value ?? '')} ${String(directionText?.value ?? '')}`;
      const region = sourceRegion(String(regionText?.value ?? ''));
      const direction =
        sourceRouteType(String(regionText?.value ?? '')) ?? sourceRouteType(String(directionText?.value ?? ''));
      const days = sourceDays(context);
      if (!region || !direction) {
        warnings.push(`${sheet.name}: 코스 표의 지역 또는 방향이 원문에 없습니다.`);
        continue;
      }
      for (const [name, nodes] of groups)
        if (nodes.length) {
          const routeDirection = (['하교', '등교'] as const).find((word) => name.includes(word)) ?? direction;
          const routeDays = sourceDays(name) ?? days;
          routes.push({
            region,
            route_type: routeDirection,
            route_name: name,
            node_info: nodes.map((node) => ({ name: node.name })),
            route_info: [
              {
                name: '1회',
                ...(routeDays ? { running_days: routeDays } : {}),
                arrival_time: nodes.map((node) => node.time),
              },
            ],
          });
        }
    }
  }
  return routes;
}

/** Expands slash-separated shuttle times into aligned source-order trips. */
export function parseSlashShuttleTables(workbook: AnalysedWorkbook, warnings: string[]): BusRoute[] {
  const routes: BusRoute[] = [];
  for (const sheet of workbook.sheets) {
    const values = new Map(sheet.cells.map((item) => [`${item.row}:${item.column}`, item.value]));
    const at = (row: number, column: number) => values.get(`${row}:${column}`);
    for (const header of sheet.cells.filter((item) => !item.merged_from && String(item.value).trim() === '셔틀')) {
      const stopColumn = header.column + 1;
      const timeColumn = header.column + 2;
      if (!/(승차장소|정류장)/.test(String(at(header.row, stopColumn) ?? ''))) continue;
      const nodes: Array<{ name: string; values: Array<string | null> }> = [];
      let count = 0;
      for (let row = header.row + 1; row < header.row + 25; row++) {
        const name = at(row, stopColumn);
        const raw = at(row, timeColumn);
        if (typeof name !== 'string') {
          if (nodes.length) break;
          continue;
        }
        const parts =
          typeof raw === 'string'
            ? raw
                .split('/')
                .map((item) => normalizeTime(item.trim()))
                .filter(
                  (item): item is string =>
                    typeof item === 'string' && (/^([01]\d|2[0-3]):[0-5]\d$/.test(item) || marker.has(item)),
                )
            : [];
        if (!parts.length) continue;
        count = Math.max(count, parts.length);
        nodes.push({ name: name.replaceAll('\n', ' ').trim(), values: parts });
      }
      if (!nodes.length || count < 2) continue;
      const title = sheet.cells
        .filter(
          (item) =>
            !item.merged_from &&
            item.row < header.row &&
            item.row >= header.row - 5 &&
            Math.abs(item.column - header.column) <= 2 &&
            /셔틀/.test(String(item.value)),
        )
        .sort(
          (left, right) =>
            right.row - left.row || Math.abs(left.column - header.column) - Math.abs(right.column - header.column),
        )[0];
      const context = String(title?.value ?? '')
        .replaceAll('\n', ' ')
        .trim();
      const region = sourceRegion(context);
      const routeName = context
        .replace(/^■\s*/, '')
        .replace(/\s*\([^)]*\d[^)]*\).*$/, '')
        .trim();
      const days = sourceDays(context);
      if (!region || !routeName) {
        warnings.push(`${sheet.name}: 셔틀 표의 지역 또는 노선명이 원문에 없습니다.`);
        continue;
      }
      routes.push({
        region,
        route_type: '셔틀',
        route_name: routeName,
        node_info: nodes.map((node) => ({ name: node.name })),
        route_info: Array.from({ length: count }, (_, index) => ({
          name: String(index + 1) + '회',
          ...(days ? { running_days: days } : {}),
          arrival_time: nodes.map((node) => node.values[index] ?? null),
        })),
      });
    }
  }
  return routes;
}
