import { captureError } from '@koin/telemetry/runtime';
import { strFromU8, strToU8, unzipSync, Zip, ZipPassThrough, zipSync } from 'fflate';
import * as XLSX from 'xlsx';
import { menuItems } from '@api/domains/dining/protocol';
import { ApiError } from '@api/errors';
import type { DiningRow } from '@api/koin-db/dining-store';

type ExportDining = Pick<DiningRow, 'date' | 'type' | 'place' | 'kcal' | 'menu' | 'image_url' | 'sold_out'>;

export const CAFETERIA_PLACES = ['A코너', 'B코너', 'C코너'];
const ALL_PLACES = [...CAFETERIA_PLACES, '능수관', '2캠퍼스'];
const MEALS = ['BREAKFAST', 'LUNCH', 'DINNER'] as const;
const mealLabels = ['조식', '중식', '석식'];
export const diningNames: Record<ExportDining['type'], string> = { BREAKFAST: '아침', LUNCH: '점심', DINNER: '저녁' };

/** LocalDateTime.toString(): 초·나노초가 0이면 초를 생략한다. */
function javaLocalDateTime(value: string): string {
  const text = value.slice(0, 19).replace(' ', 'T');
  return text.endsWith(':00') ? text.slice(0, 16) : text;
}

// 셀 서식 0=기본, 1=공통(테두리·가운데·줄바꿈), 2=날짜 머리(97BEC0), 3=끼니·코너(FCEDBA).
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><color rgb="FF000000"/><name val="Calibri"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF97BEC0"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFCEDBA"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border/><border><left style="thin"><color rgb="FFC0C0C0"/></left><right style="thin"><color rgb="FFC0C0C0"/></right><top style="thin"><color rgb="FFC0C0C0"/></top><bottom style="thin"><color rgb="FFC0C0C0"/></bottom></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>${[0, 2, 3].map((fill) => `<xf numFmtId="0" fontId="0" fillId="${fill}" borderId="1" xfId="0" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>`).join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

/**
 * CoopService.createDiningExcelWithDetailedFormat: 시트 "식단", 1행 날짜, A열 끼니·B열 코너(병합),
 * 학식 코너는 메뉴·사진 URL·칼로리·품절 4행, 그 외 코너는 메뉴·칼로리 2행(ExcelDiningPosition과 같은 위치).
 */
export function coopWorkbook(dinings: ExportDining[], cafeteria: boolean): Uint8Array<ArrayBuffer> {
  const places = cafeteria ? CAFETERIA_PLACES : ALL_PLACES;
  const dates = Array.from(new Set(dinings.map((dining) => dining.date))).sort();
  const rows: (string | null)[][] = Array.from({ length: 100 }, () => []);
  const merges: XLSX.Range[] = [];
  const positions = new Map<string, number>();
  let row = 1;
  for (const [index, meal] of MEALS.entries()) {
    const mealStart = row;
    for (const place of places) {
      const size = CAFETERIA_PLACES.includes(place) ? 4 : 2;
      positions.set(`${meal}:${place}`, row);
      for (let line = row; line < row + size; line++) rows[line]![1] = place;
      merges.push({ s: { r: row, c: 1 }, e: { r: row + size - 1, c: 1 } });
      row += size;
    }
    rows[mealStart]![0] = mealLabels[index]!;
    merges.push({ s: { r: mealStart, c: 0 }, e: { r: row - 1, c: 0 } });
  }
  const columns = new Map(dates.map((date, index) => [date, index + 2]));
  for (const [date, column] of columns) rows[0]![column] = date;
  for (const dining of dinings) {
    const start = positions.get(`${dining.type}:${dining.place}`);
    if (start === undefined) {
      throw new ApiError(404, '', `유효하지 않은 ExcelDiningPosition: ${dining.type} and Place: ${dining.place} null`);
    }
    const column = columns.get(dining.date)!;
    const kcal = `${dining.kcal ?? 0} kcal`;
    rows[start]![column] = menuItems(dining.menu).join('\n');
    if (CAFETERIA_PLACES.includes(dining.place)) {
      rows[start + 1]![column] = dining.image_url;
      rows[start + 2]![column] = kcal;
      rows[start + 3]![column] = dining.sold_out === null ? '미품절' : `품절 (${javaLocalDateTime(dining.sold_out)})`;
    } else rows[start + 1]![column] = kcal;
  }
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!merges'] = merges;
  sheet['!cols'] = [{ wch: 4000 / 256 }, { wch: 4000 / 256 }, ...dates.map(() => ({ wch: 6000 / 256 }))];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, '식단');
  // SheetJS 커뮤니티판은 셀 서식을 쓰지 않으므로 Java POI 서식(배경·테두리·정렬)을 직접 넣는다.
  const files = unzipSync(new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer));
  const content = files['xl/worksheets/sheet1.xml'];
  if (!content) throw new Error('식단 시트가 생성되지 않았습니다.');
  files['xl/worksheets/sheet1.xml'] = strToU8(
    strFromU8(content).replace(
      /<c\b([^>]*\br="([A-Z]+)(\d+)"[^>]*)>/g,
      (_match, attributes: string, column: string, line: string) => {
        const style = Number(line) === 1 ? 2 : column === 'A' || column === 'B' ? 3 : 1;
        return `<c${attributes.replace(/\s+s="\d+"/, '')} s="${style}">`;
      },
    ),
  );
  files['xl/styles.xml'] = strToU8(STYLES);
  return zipSync(files, { level: 6 });
}

/** URLDecoder.decode(UTF-8): '+'는 공백, 잘못된 %XX는 IllegalArgumentException(→ ILLEGAL_ARGUMENT). */
function javaUrlDecode(value: string): string {
  const bytes: number[] = [];
  let decoded = '';
  const flush = () => {
    if (bytes.length) decoded += new TextDecoder().decode(new Uint8Array(bytes.splice(0)));
  };
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!;
    if (character === '%') {
      const hex = value.slice(index + 1, index + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new ApiError(400, 'ILLEGAL_ARGUMENT', '잘못된 인자가 전달되었습니다.');
      bytes.push(Number.parseInt(hex, 16));
      index += 2;
      continue;
    }
    flush();
    decoded += character === '+' ? ' ' : character;
  }
  flush();
  return decoded;
}

export interface ImageEntry {
  name: string;
  url: string;
}

/**
 * CoopService.generateZipFileOf: 정적 도메인 사진만 "YYYY-M-D-끼니-코너.확장자"로 모은다. 확장자 없는 키는
 * Java substring 예외와 같은 500이다. 원본은 CloudFront(S3 정적 도메인)에서 키 그대로 받는다.
 */
export function imageEntries(dinings: ExportDining[], prefix: string): ImageEntry[] {
  const entries = new Map<string, string>();
  for (const dining of dinings) {
    const imageUrl = dining.image_url;
    if (!imageUrl || !imageUrl.startsWith(prefix)) continue;
    const key = javaUrlDecode(imageUrl.slice(prefix.length));
    const dot = key.lastIndexOf('.');
    if (dot < 0) throw new ApiError(500, 'INTERNAL_SERVER_ERROR', '서버에서 오류가 발생했습니다.');
    const [year, month, day] = dining.date.split('-').map(Number);
    const name = `${year}-${month}-${day}-${diningNames[dining.type]}-${dining.place}${key.slice(dot)}`;
    entries.set(name, prefix + key.split('/').map(encodeURIComponent).join('/'));
  }
  return [...entries].map(([name, url]) => ({ name, url }));
}

/**
 * dining_images.zip을 스트리밍한다(dining_images/ 폴더 아래, 무압축). 원본 다운로드가 실패하면 스트림을 중단한다.
 * 메모리에 전체 파일을 쌓지 않도록 클라이언트 속도에 맞춰 읽는다.
 */
export function imageZip(entries: ImageEntry[]): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  // 실패 뒤(abort) 쌓인 write·close 거부는 스트림 오류로 이미 전달되므로 무시한다.
  const ignore = () => undefined;
  const zip = new Zip((error, chunk, final) => {
    if (error) return;
    writer.write(chunk).catch(ignore);
    if (final) writer.close().catch(ignore);
  });
  void (async () => {
    try {
      const folder = new ZipPassThrough('dining_images/');
      zip.add(folder);
      folder.push(new Uint8Array(0), true);
      for (const entry of entries) {
        const response = await fetch(entry.url, { redirect: 'follow' });
        if (!response.ok || !response.body) throw new Error(`Dining image download failed: HTTP ${response.status}`);
        const file = new ZipPassThrough(`dining_images/${entry.name}`);
        zip.add(file);
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          file.push(value);
          await writer.ready;
        }
        file.push(new Uint8Array(0), true);
      }
      zip.end();
    } catch (error) {
      captureError(error);
      await writer.abort(error).catch(() => undefined);
    }
  })();
  return readable;
}

/** CompressFileResponseBuilder: 1시간 캐시 허용, Expires는 RFC 1123(일자 0 채움 없음). */
export function zipHeaders(nowMs: number): Headers {
  const expires = new Date(nowMs + 3_600_000).toUTCString().replace(/, 0(\d) /, ', $1 ');
  return new Headers({
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': "attachment; filename*=UTF-8''dining_images.zip",
    'Cache-Control': 'public, max-age=3600',
    Pragma: 'public',
    Expires: expires,
  });
}
