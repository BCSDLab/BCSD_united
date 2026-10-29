import { read, utils, type WorkSheet } from 'xlsx';
import { ApiError } from '@api/errors';
import { regions, routeTypes, runningDays } from '@api/domains/transport/algorithms';

function malformed(message: string): never {
  throw new ApiError(400, 'INVALID_EXCEL_FILE_FORMAT', message);
}
export function parseName(raw: string) {
  const match = /^(.*?)\s*(?:\((.*?)\))?$/.exec(raw.trim());
  return { name: match?.[1]?.trim() ?? raw.trim(), detail: match?.[2]?.trim() ?? null };
}
function formatted(sheet: WorkSheet, row: number, col: number) {
  const cell = sheet[utils.encode_cell({ r: row, c: col })];
  return cell ? (cell.f ? String(cell.f) : utils.format_cell(cell)).trim() : '';
}
function stringCell(sheet: WorkSheet, row: number, col: number): string | null {
  const cell = sheet[utils.encode_cell({ r: row, c: col })];
  if (!cell || cell.t === 'z') return null;
  if (cell.t !== 's' && !(cell.f && typeof cell.v === 'string'))
    throw new ApiError(400, 'INVALID_EXCEL_CELL_FORMAT', '셀 서식은 텍스트만 허용합니다.');
  return String(cell.v);
}
function enumLabel<T extends Record<string, string>>(values: T, key: string | null, message: string): T[keyof T] {
  if (!key || !(key in values)) throw new ApiError(400, 'INVALID_REQUEST_BODY', message);
  return values[key as keyof T];
}
function readWorkbook(bytes: Uint8Array) {
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;
  const compound = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((v, i) => bytes[i] === v);
  if (!zip && !compound)
    throw new ApiError(400, 'INVALID_EXCEL_FILE_TYPE', '엑셀 형식이 아닌 파일이 업로드 되었습니다.');
  try {
    return read(bytes, { type: 'array', cellDates: false, cellNF: true });
  } catch {
    throw new ApiError(400, 'INVALID_EXCEL_FILE_TYPE', '엑셀 형식이 아닌 파일이 업로드 되었습니다.');
  }
}
export function parseShuttleWorkbook(bytes: Uint8Array) {
  if (!bytes.length) malformed('엑셀 파일이 비어 있습니다.');
  const workbook = readWorkbook(bytes);
  const tables = workbook.SheetNames.flatMap((name, index) => {
    if (workbook.Workbook?.Sheets?.[index]?.Hidden) return [];
    const sheet = workbook.Sheets[name]!;
    const range = utils.decode_range(sheet['!ref'] ?? 'A1');
    const hasRow = (row: number) =>
      Object.keys(sheet).some((key) => !key.startsWith('!') && utils.decode_cell(key).r === row);
    if (!hasRow(4)) malformed('필수 행이 없습니다 (회차 세부 정보): 4');
    const columns: number[] = [];
    let ended = false;
    for (let c = 1; c <= range.e.c; c++) {
      if (!formatted(sheet, 3, c)) {
        ended = true;
        continue;
      }
      if (ended) malformed(`회차 헤더 사이에 빈 열이 있습니다: ${c}`);
      columns.push(c);
    }
    if (!columns.length) malformed('회차 헤더가 없습니다.');
    const last = columns[columns.length - 1]!;
    for (let c = last + 1; c <= range.e.c; c++)
      if (formatted(sheet, 4, c)) malformed(`회차 헤더가 없는 열에 값이 있습니다 (행/열): 4/${c}`);
    const rows: number[] = [];
    ended = false;
    for (let r = 5; r <= range.e.r; r++) {
      if (!formatted(sheet, r, 0)) {
        for (let c = 0; c <= range.e.c; c++)
          if (formatted(sheet, r, c)) malformed(`정류소 이름이 없는 행에 값이 있습니다: ${r}`);
        ended = true;
        continue;
      }
      if (ended) malformed(`정류소 행 사이에 빈 행이 있습니다: ${r}`);
      for (let c = last + 1; c <= range.e.c; c++)
        if (formatted(sheet, r, c)) malformed(`회차 헤더가 없는 열에 값이 있습니다 (행/열): ${r}/${c}`);
      rows.push(r);
    }
    if (!rows.length) malformed('정류소 행이 없습니다.');
    const route = parseName(name);
    return [
      {
        region: enumLabel(regions, formatted(sheet, 0, 1), '버스 지역 구분이 잘못되었습니다.'),
        route_type: enumLabel(routeTypes, formatted(sheet, 1, 1), '버스 노선 구분이 잘못되었습니다.'),
        route_name: route.name,
        sub_name: route.detail,
        node_info: rows.map((r) => parseName(formatted(sheet, r, 0))),
        route_info: columns.map((c) => {
          const name = formatted(sheet, 3, c);
          const detail = formatted(sheet, 4, c) || null;
          return {
            name,
            detail,
            running_days: runningDays(name, detail),
            arrival_time: rows.map((r) => formatted(sheet, r, c) || null),
          };
        }),
      },
    ];
  });
  if (!tables.length) malformed('유효한 공개 시트가 없습니다.');
  return { shuttle_bus_timetables: tables };
}
export function parseCommutingWorkbook(bytes: Uint8Array) {
  const workbook = readWorkbook(bytes);
  return {
    commuting_bus_timetables: workbook.SheetNames.map((name) => {
      const sheet = workbook.Sheets[name]!;
      const direction = stringCell(sheet, 0, 1);
      if (!direction || !['NORTH', 'SOUTH', 'BOTH'].includes(direction))
        throw new ApiError(400, 'INVALID_REQUEST_BODY', '정상적인 버스 방향이 아닙니다.');
      const region = enumLabel(regions, stringCell(sheet, 1, 1), '버스 지역 구분이 잘못되었습니다.');
      if (stringCell(sheet, 2, 1) !== 'WEEKDAYS')
        throw new ApiError(400, 'INVALID_SHUTTLE_ROUTE_TYPE', '등하교 버스 타입이 아닙니다.');
      let start = -1;
      let end = -1;
      for (let r = 0; r <= 30; r++) {
        const value = stringCell(sheet, r, 0);
        if (start === -1 && value === '정거장') start = r;
        if (end === -1 && value === '대학(본교)') end = r;
      }
      if (start < 0) throw new ApiError(400, 'INVALID_NODE_INFO_START_POINT', '올바른 정거장 시작 위치가 아닙니다.');
      if (end < 0) throw new ApiError(400, 'INVALID_NODE_INFO_END_POINT', '올바른 정거장 끝 위치가 아닙니다.');
      const rows: number[] = [];
      if (direction === 'SOUTH') {
        for (let r = end; r > start; r--) if (stringCell(sheet, r, 0)?.trim()) rows.push(r);
      } else {
        for (let r = start + 1; r <= end; r++) {
          const n = stringCell(sheet, r, 0);
          if (!n?.trim()) continue;
          rows.push(r);
          if (n.includes('대학(본교)')) break;
        }
      }
      return {
        region,
        route_type: '주중',
        route_name: stringCell(sheet, 3, 1),
        sub_name: stringCell(sheet, 4, 1),
        node_info: rows.map((r) => {
          const value = stringCell(sheet, r, 0)!;
          const m = /^(.+)\((.+)\)$/.exec(value);
          return { name: m ? m[1]!.trim() : value, detail: m ? m[2]!.trim() : null };
        }),
        route_info: (direction === 'NORTH' ? [1] : direction === 'SOUTH' ? [2] : [1, 2]).map((c) => ({
          name: stringCell(sheet, start, c),
          detail: null,
          arrival_time: rows.map((r) => stringCell(sheet, r, c)),
        })),
      };
    }),
  };
}
