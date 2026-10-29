import type { AnalysedWorkbook } from './excelAnalyzer';
import { normalizeRoute } from './deterministicParser';
import { synthesizeReturnRoutes } from './deterministicSynthesis';
import { parseStructuredWorkbook } from './regularParser';
import { parseSeasonalParallelPayloads, seasonalWorkbook } from './seasonalPayload';
import { semesterFromSource } from './semester';
import type { BusConversion, BusPayload, BusRoute, BusTarget, SemesterType } from './types';

const titles = {
  REGULAR: '정규학기',
  SEASONAL: '계절학기',
  VACATION: '방학기간',
} as const;

const iso = (year: string, month: string, day: string) => {
  const fullYear = year.length === 2 ? `20${year}` : year;
  return `${fullYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
};

/** 합성(등교 역순)으로 만든 하교 노선도 원래 노선과 같은 target으로 분류한다. */
const routeKey = (route: BusRoute) => `${route.region}:${route.route_type}:${route.route_name}`;

export function sourcePeriods(text: string): string[] {
  const pattern =
    /(20\d{2}|\d{2})\s*[.년\-/]\s*(\d{1,2})\s*[.월\-/]\s*(\d{1,2})\s*(?:[.일]?)\s*(?:\([^)]*\))?\s*[.]?\s*~\s*(?:(20\d{2}|\d{2})\s*[.년\-/]\s*)?(\d{1,2})\s*[.월\-/]\s*(\d{1,2})\s*(?:[.일]?)\s*(?:\([^)]*\))?/g;
  return [
    ...new Set(
      [...text.matchAll(pattern)].map((match) => {
        const start = iso(match[1], match[2], match[3]);
        const end = iso(match[4] ?? match[1], match[5], match[6]);
        if (match[4] || end >= start) return `${start}~${end}`;
        const nextYear = String(Number(start.slice(0, 4)) + 1);
        return `${start}~${iso(nextYear, match[5], match[6])}`;
      }),
    ),
  ];
}

function text(workbook: AnalysedWorkbook): string {
  return workbook.sheets
    .flatMap((sheet) => sheet.cells.filter((cell) => !cell.merged_from).map((cell) => String(cell.value)))
    .join(' ');
}

function periodEnvelope(periods: string[]): string {
  if (periods.length === 0) throw new Error('원문에서 적용 기간을 확정할 수 없습니다.');
  if (periods.length === 1) return periods[0];
  const starts = periods.map((period) => period.split('~')[0]).sort();
  const ends = periods.map((period) => period.split('~')[1]).sort();
  return `${starts[0]}~${ends.at(-1)}`;
}

function payloads(semesterType: SemesterType, routes: Array<{ target: BusTarget; route: BusRoute }>): BusPayload[] {
  return (['commuting', 'shuttle'] as const).flatMap((target) => {
    const selected = routes
      .filter((item) => item.target === target)
      .map((item) => ({
        ...item.route,
        route_name: normalizeRoute(item.route.route_name),
      }));
    if (!selected.length) return [];
    return [
      {
        target,
        semester_type: semesterType,
        body: target === 'commuting' ? { commuting_bus_timetables: selected } : { shuttle_bus_timetables: selected },
      },
    ];
  });
}

function regularWorkbook(workbook: AnalysedWorkbook): AnalysedWorkbook | undefined {
  const sheets = workbook.sheets.filter((sheet) => semesterFromSource(sheet.name) === 'REGULAR');
  if (!sheets.length) return undefined;
  const names = new Set(sheets.map((sheet) => sheet.name));
  return {
    sheets,
    tables: workbook.tables.filter((table) => names.has(table.sheet)),
  };
}

function titlePeriods(source: AnalysedWorkbook): string[] {
  return source.sheets.flatMap((sheet) => {
    const masterCells = sheet.cells.filter((cell) => !cell.merged_from);
    const topRow = Math.min(...masterCells.map((cell) => cell.row));
    return sourcePeriods(
      masterCells
        .filter((cell) => cell.row === topRow)
        .map((cell) => String(cell.value))
        .join(' '),
    );
  });
}

function conversion(
  semesterType: SemesterType,
  source: AnalysedWorkbook,
  selectedPayloads: BusPayload[],
  warnings: string[],
): BusConversion {
  if (!selectedPayloads.length)
    throw new Error(`${titles[semesterType]}에서 publish 가능한 버스 노선을 찾지 못했습니다.`);
  const allPeriods = sourcePeriods(text(source));
  const explicitTitlePeriods = titlePeriods(source);
  const versionPeriod = periodEnvelope(explicitTitlePeriods.length ? explicitTitlePeriods : allPeriods);
  return {
    payloads: selectedPayloads,
    version_update: {
      type: 'shuttle_bus_timetable',
      title: titles[semesterType],
      content: versionPeriod,
    },
    provenance: {
      parser: 'deterministic-layout',
      sheets: source.sheets.map((sheet) => sheet.name),
      source_periods: allPeriods,
      version_period_source: explicitTitlePeriods.length > 0 ? 'title' : 'route-envelope',
    },
    warnings: [...warnings],
  };
}

/** Returns one API contract per semester represented by the workbook. */
export function convertExcelDeterministically(workbook: AnalysedWorkbook): BusConversion[] {
  const regular = regularWorkbook(workbook);
  if (regular) {
    const warnings: string[] = [];
    const parsed = parseStructuredWorkbook(regular);
    const targets = new Map(parsed.map(({ route, target }) => [routeKey(route), target]));
    const routes = synthesizeReturnRoutes(
      parsed.map(({ route }) => route),
      regular,
      warnings,
    );
    return [
      conversion(
        'REGULAR',
        regular,
        payloads(
          'REGULAR',
          routes.map((route) => ({
            target: targets.get(routeKey(route)) ?? 'commuting',
            route,
          })),
        ),
        warnings,
      ),
    ];
  }

  const parsed = parseSeasonalParallelPayloads(workbook);
  const conversions = (['SEASONAL', 'VACATION'] as const).flatMap((semesterType) => {
    const selected = parsed.payloads.filter((payload) => payload.semester_type === semesterType);
    if (!selected.length) return [];
    const source = seasonalWorkbook(workbook, semesterType);
    return [conversion(semesterType, source, selected, parsed.warningsBySemester[semesterType])];
  });
  if (!conversions.length) throw new Error('원문에서 semester_type을 확정할 수 없습니다.');
  return conversions;
}
