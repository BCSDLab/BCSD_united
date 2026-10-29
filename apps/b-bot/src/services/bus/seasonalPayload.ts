import type { AnalysedWorkbook } from './excelAnalyzer';
import { normalizeRoute, parseCourseStopTimeTriples, parseSlashShuttleTables } from './deterministicParser';
import { synthesizeReturnRoutes } from './deterministicSynthesis';
import type { BusPayload, BusRoute, SemesterType } from './types';
import { parseStructuredWorkbook } from './regularParser';

export function seasonalWorkbook(workbook: AnalysedWorkbook, semester: SemesterType): AnalysedWorkbook {
  const label = semester === 'SEASONAL' ? /계절학기/ : /방학/;
  const sheets = workbook.sheets.map((sheet) => {
    const topRow = Math.min(...sheet.cells.map((cell) => cell.row));
    const headings = sheet.cells
      .filter(
        (cell) =>
          cell.row === topRow &&
          !cell.merged_from &&
          typeof cell.value === 'string' &&
          /계절학기|방학/.test(cell.value as string),
      )
      .sort((a, b) => a.column - b.column);
    const start = headings.find((cell) => label.test(String(cell.value)));
    if (!start) return { ...sheet, cells: [] };
    const end = headings.find((cell) => cell.column > start.column)?.column ?? Infinity;
    return {
      ...sheet,
      cells: sheet.cells.filter((cell) => cell.column >= start.column && cell.column < end),
    };
  });
  const ranges = new Map(
    sheets.map((sheet) => {
      const columns = sheet.cells.map((cell) => cell.column);
      return [sheet.name, columns.length ? { start: Math.min(...columns), end: Math.max(...columns) } : undefined];
    }),
  );
  return {
    sheets,
    tables: workbook.tables.filter((table) => {
      const range = ranges.get(table.sheet);
      return range && table.start_column >= range.start && table.start_column <= range.end;
    }),
  };
}
function unique(routes: BusRoute[]) {
  const seen = new Set<string>();
  return routes.filter((route) => {
    const key = JSON.stringify(route);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function payload(semester_type: SemesterType, routes: BusRoute[]): BusPayload[] {
  const commuting = routes.filter((route) => route.route_type !== '셔틀');
  const shuttle = routes.filter((route) => route.route_type === '셔틀');
  return [
    commuting.length
      ? {
          target: 'commuting' as const,
          semester_type,
          body: { commuting_bus_timetables: commuting },
        }
      : undefined,
    shuttle.length
      ? {
          target: 'shuttle' as const,
          semester_type,
          body: { shuttle_bus_timetables: shuttle },
        }
      : undefined,
  ].filter(Boolean) as BusPayload[];
}

/** Separates the two visible source rectangles before parsing; no title-based guesswork. */
export function parseSeasonalParallelPayloads(workbook: AnalysedWorkbook) {
  const bySemester = (['SEASONAL', 'VACATION'] as const).map((semester) => {
    const warnings: string[] = [];
    const scoped = seasonalWorkbook(workbook, semester);
    const routes = unique(
      [
        ...parseCourseStopTimeTriples(scoped, warnings),
        ...parseSlashShuttleTables(scoped, warnings),
        ...parseStructuredWorkbook(scoped).map(({ route }) => route),
      ].map((route) => ({
        ...route,
        route_name: normalizeRoute(route.route_name),
      })),
    );
    const withReturns = synthesizeReturnRoutes(routes, scoped, warnings);
    return {
      semester_type: semester,
      payloads: payload(semester, withReturns),
      warnings,
    };
  });
  return {
    payloads: bySemester.flatMap(({ payloads }) => payloads),
    warningsBySemester: Object.fromEntries(
      bySemester.map(({ semester_type, warnings }) => [semester_type, warnings]),
    ) as Record<SemesterType, string[]>,
  };
}
