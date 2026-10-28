import * as XLSX from 'xlsx';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { ApiError } from '@api/errors';
import { kstTimestamp, menuItems, type DiningRow } from '@api/domains/dining/protocol';

export interface CoopShopInput {
  coop_shop_info: { name: string | null; phone: string | null; location: string | null; remark: string | null };
  operation_hours: { type: string | null; day_of_week: string | null; open_time: string | null; close_time: string | null }[];
}
const corners = ['A코너', 'B코너', 'C코너', '능수관', '2캠퍼스'];
const meals = ['BREAKFAST', 'LUNCH', 'DINNER'];
export function diningWorkbook(dinings: DiningRow[], cafeteria: boolean): Uint8Array {
  const places = cafeteria ? corners.slice(0, 3) : corners;
  const dates = Array.from(new Set(dinings.map((dining) => dining.date))).sort();
  const rows: (string | null)[][] = Array.from({ length: 100 }, () => []);
  const merges: XLSX.Range[] = [];
  const positions = new Map<string, number>();
  let row = 1;
  for (const [mealIndex, meal] of meals.entries()) {
    const mealStart = row;
    for (const place of places) {
      const size = corners.indexOf(place) < 3 ? 4 : 2;
      positions.set(`${meal}:${place}`, row);
      for (let index = row; index < row + size; index++) rows[index]![1] = place;
      merges.push({ s: { r: row, c: 1 }, e: { r: row + size - 1, c: 1 } });
      row += size;
    }
    rows[mealStart]![0] = ['조식', '중식', '석식'][mealIndex]!;
    merges.push({ s: { r: mealStart, c: 0 }, e: { r: row - 1, c: 0 } });
  }
  dates.forEach((date, index) => { rows[0]![index + 2] = date; });
  const columns = new Map(dates.map((date, index) => [date, index + 2]));
  for (const dining of dinings) {
    const start = positions.get(`${dining.type}:${dining.place}`);
    if (start === undefined) throw new ApiError(404, 'NOT_FOUND_DATA', '식단 엑셀 위치를 찾을 수 없습니다.');
    const column = columns.get(dining.date)!;
    rows[start]![column] = menuItems(dining.menu).join('\n');
    if (corners.indexOf(dining.place) < 3) {
      rows[start + 1]![column] = dining.image_url;
      rows[start + 2]![column] = `${dining.kcal ?? 0} kcal`;
      rows[start + 3]![column] = dining.sold_out === null ? '미품절' : `품절 (${kstTimestamp(dining.sold_out)?.replace(' ', 'T').replace(/:00$/, '')})`;
    } else rows[start + 1]![column] = `${dining.kcal ?? 0} kcal`;
  }
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!merges'] = merges;
  sheet['!cols'] = [{ wch: 4000 / 256 }, { wch: 4000 / 256 }, ...dates.map(() => ({ wch: 6000 / 256 }))];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, '식단');
  const files = unzipSync(new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer));
  const content = files['xl/worksheets/sheet1.xml'];
  if (!content) throw new Error('식단 시트가 생성되지 않았습니다.');
  files['xl/worksheets/sheet1.xml'] = strToU8(strFromU8(content).replace(/<c\b([^>]*\br="([A-Z]+)(\d+)"[^>]*)>/g, (_match, attributes: string, col: string, index: string) => {
    const style = Number(index) === 1 ? 2 : col === 'A' || col === 'B' ? 3 : 1;
    return `<c${attributes.replace(/\s+s="\d+"/, '')} s="${style}">`;
  }));
  files['xl/styles.xml'] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF97BEC0"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFCEDBA"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border/><border><left style="thin"><color rgb="FFC0C0C0"/></left><right style="thin"><color rgb="FFC0C0C0"/></right><top style="thin"><color rgb="FFC0C0C0"/></top><bottom style="thin"><color rgb="FFC0C0C0"/></bottom></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>${[0, 2, 3].map((fill) => `<xf numFmtId="0" fontId="0" fillId="${fill}" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>`).join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`);
  return zipSync(files, { level: 6 });
}
export function parseCoopWorkbook(bytes: Uint8Array): CoopShopInput[] {
  if (!bytes.length) throw new ApiError(400, 'EMPTY_EXCEL_FILE', '엑셀 파일이 비어 있습니다.');
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((value, index) => bytes[index] === value);
  if (!zip && !ole) throw new ApiError(400, 'INVALID_EXCEL_FILE_FORMAT', '올바르지 않은 엑셀 파일 형식입니다.');
  let book: XLSX.WorkBook;
  try { book = XLSX.read(bytes, { type: 'array', cellFormula: true, sheetRows: 100 }); }
  catch (error) {
    if (/password|encrypted/i.test(String(error))) throw new ApiError(400, 'ENCRYPTED_EXCEL_FILE', '암호화된 엑셀 파일을 읽을 수 없습니다.');
    throw new ApiError(400, 'UNREADABLE_EXCEL_FILE', '엑셀 파일을 읽을 수 없습니다.');
  }
  const name = book.SheetNames[0];
  const sheet = name ? book.Sheets[name] : undefined;
  if (!sheet) throw new ApiError(400, 'INVALID_EXCEL_FILE_FORMAT', '올바르지 않은 엑셀 파일 형식입니다.');
  const readCell = (r: number, c: number, merge: boolean): string | null => {
    let cell = sheet[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
    if ((!cell || cell.v === undefined || (typeof cell.v === 'string' && !cell.v.trim())) && merge) {
      const merged = sheet['!merges']?.find((range) => range.s.r <= r && range.e.r >= r && range.s.c <= c && range.e.c >= c);
      if (merged) cell = sheet[XLSX.utils.encode_cell(merged.s)] as XLSX.CellObject | undefined;
    }
    if (!cell || cell.v === undefined || cell.v === null || cell.v === '') return null;
    if (cell.t !== 's' || cell.f) throw new ApiError(400, 'INVALID_EXCEL_CELL_FORMAT', '셀 서식은 텍스트만 허용합니다.');
    return String(cell.v).trim() ? String(cell.v) : null;
  };
  const groups = new Map<string, CoopShopInput>();
  for (let r = 2; r < 100; r++) {
    if (Array.from({ length: 8 }, (_, c) => readCell(r, c, false)).every((value) => value === null)) continue;
    const info = { name: readCell(r, 0, true), phone: readCell(r, 5, true), location: readCell(r, 7, true), remark: readCell(r, 6, true) };
    const key = JSON.stringify(info);
    let group = groups.get(key);
    if (!group) { group = { coop_shop_info: info, operation_hours: [] }; groups.set(key, group); }
    group.operation_hours.push({ type: readCell(r, 2, true), day_of_week: readCell(r, 1, true), open_time: readCell(r, 3, true), close_time: readCell(r, 4, true) });
  }
  return Array.from(groups.values());
}
