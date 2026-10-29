import ExcelJS from 'exceljs';
import XLSX from 'xlsx';
import { normalizeTime } from './validation';

export interface AnalysedCell {
  row: number;
  column: number;
  value: unknown;
  merged_from?: { row: number; column: number };
}

export interface TableCandidate {
  sheet: string;
  header_row: number;
  start_column: number;
  end_column: number;
  context_heading?: string;
  kind: 'vertical' | 'horizontal' | 'unknown';
}

export interface AnalysedSheet {
  name: string;
  cells: AnalysedCell[];
  merges: string[];
}

export interface AnalysedWorkbook {
  sheets: AnalysedSheet[];
  tables: TableCandidate[];
}

const heading = /(등교|하교|셔틀|통학버스|순환|시간표|일학습병행|대학원)/;
const stopHeader = /^(정류장|승차장소)$/;
const timeHeader = /(시간|운행시간|예정시간)/;

/** Reads OOXML workbooks with the same ExcelJS dependency used by the lecture workflow. */
export async function analyseXlsx(buffer: Buffer): Promise<AnalysedWorkbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheets = workbook.worksheets.map((worksheet): AnalysedSheet => {
    const cells: AnalysedCell[] = [];
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      row.eachCell({ includeEmpty: false }, (cell, columnNumber) => {
        const master = cell.isMerged ? cell.master : cell;
        if (cell.isMerged && cell.address !== master.address) return;
        const raw = master.text || master.value;
        if (raw === null || raw === undefined || raw === '') return;
        cells.push({
          row: rowNumber - 1,
          column: columnNumber - 1,
          value: normalizeTime(raw),
        });
      });
    });
    return expandMergedCells({
      name: worksheet.name,
      cells,
      merges: [...worksheet.model.merges],
    });
  });
  return { sheets, tables: discoverTables(sheets) };
}

/** ExcelJS cannot read BIFF .xls files, so legacy uploads use this isolated fallback. */
export function analyseExcel(buffer: Buffer): AnalysedWorkbook {
  const workbook = XLSX.read(buffer, {
    type: 'buffer',
    raw: false,
    cellDates: false,
  });
  const sheets = workbook.SheetNames.map((name): AnalysedSheet => {
    const worksheet = workbook.Sheets[name];
    const range = XLSX.utils.decode_range(worksheet['!ref'] ?? 'A1');
    const merges = (worksheet['!merges'] ?? []).map((merge) => XLSX.utils.encode_range(merge));
    const cells: AnalysedCell[] = [];
    for (let row = range.s.r; row <= range.e.r; row += 1) {
      for (let column = range.s.c; column <= range.e.c; column += 1) {
        const cell = worksheet[XLSX.utils.encode_cell({ r: row, c: column })];
        if (!cell || cell.v === undefined || cell.v === null || cell.v === '') continue;
        cells.push({ row, column, value: normalizeTime(cell.v) });
      }
    }
    return expandMergedCells({ name, cells, merges });
  });
  return { sheets, tables: discoverTables(sheets) };
}

function expandMergedCells(sheet: AnalysedSheet): AnalysedSheet {
  const cells = new Map(sheet.cells.map((cell) => [`${cell.row}:${cell.column}`, cell]));
  for (const address of sheet.merges) {
    const range = XLSX.utils.decode_range(address);
    const master = cells.get(`${range.s.r}:${range.s.c}`);
    if (!master) continue;
    for (let row = range.s.r; row <= range.e.r; row += 1) {
      for (let column = range.s.c; column <= range.e.c; column += 1) {
        const key = `${row}:${column}`;
        if (!cells.has(key)) {
          cells.set(key, {
            row,
            column,
            value: master.value,
            merged_from: { row: range.s.r, column: range.s.c },
          });
        }
      }
    }
  }
  return {
    ...sheet,
    cells: [...cells.values()].sort((left, right) => left.row - right.row || left.column - right.column),
  };
}

function discoverTables(sheets: AnalysedSheet[]): TableCandidate[] {
  const tables: TableCandidate[] = [];
  for (const sheet of sheets) {
    const rows = new Map<number, Array<{ column: number; value: string }>>();
    for (const cell of sheet.cells) {
      const value = String(cell.value).trim();
      if (value) rows.set(cell.row, [...(rows.get(cell.row) ?? []), { column: cell.column, value }]);
    }
    for (const [row, values] of rows) {
      const contextHeading = [...rows.entries()]
        .filter(([candidate]) => candidate < row && candidate >= row - 24)
        .flatMap(([, candidates]) => candidates.map((cell) => cell.value))
        .find((value) => heading.test(value));
      for (const cell of values) {
        const sourceCell = sheet.cells.find((candidate) => candidate.row === row && candidate.column === cell.column);
        if (sourceCell?.merged_from) continue;
        if (stopHeader.test(cell.value)) {
          const hasTimes =
            values.some((value) => timeHeader.test(value.value)) ||
            (rows.get(row + 1) ?? []).some((value) => /\d+회/.test(value.value));
          tables.push({
            sheet: sheet.name,
            header_row: row,
            start_column: cell.column,
            end_column: headerClusterEnd(values, cell.column),
            context_heading: contextHeading,
            kind: hasTimes ? 'horizontal' : 'unknown',
          });
        }
        if (cell.value === '코스' && values.some((value) => timeHeader.test(value.value))) {
          tables.push({
            sheet: sheet.name,
            header_row: row,
            start_column: cell.column,
            end_column: headerClusterEnd(values, cell.column),
            context_heading: contextHeading,
            kind: 'vertical',
          });
        }
      }
    }
  }
  return tables;
}

function headerClusterEnd(values: Array<{ column: number; value: string }>, start: number) {
  const columns = new Set(values.map((value) => value.column));
  const maximum = Math.max(...columns);
  let end = start;
  let emptyColumns = 0;
  for (let column = start + 1; column <= maximum; column += 1) {
    if (columns.has(column)) {
      end = column;
      emptyColumns = 0;
      continue;
    }
    emptyColumns += 1;
    if (emptyColumns >= 2) break;
  }
  return end;
}
