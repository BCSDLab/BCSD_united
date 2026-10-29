import ExcelJS from 'exceljs';

/** 슬랙에서 받은 파일은 디스크를 거치지 않고 메모리에서 바로 읽는다. */
export async function readSheetFromBuffer(buffer: ArrayBuffer | Uint8Array): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as Parameters<typeof workbook.xlsx.load>[0]);
  return toRows(workbook, '업로드된 파일');
}

function toRows(workbook: ExcelJS.Workbook, label: string): string[][] {
  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new Error(`시트를 찾을 수 없습니다: ${label}`);
  }

  const rows: string[][] = [];
  worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const cells: string[] = [];
    // exceljs의 values는 1-based라 0번 자리가 비어 있다. 그대로 잘라 0-based로 맞춘다.
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    for (let i = 0; i < values.length; i += 1) {
      cells[i] = cellToString(values[i]);
    }
    rows[rowNumber - 1] = cells;
  });

  // eachRow는 빈 행을 건너뛸 수 있어 중간에 구멍이 남는다.
  for (let i = 0; i < rows.length; i += 1) {
    rows[i] ??= [];
  }

  return rows;
}

/** 서식 있는 셀은 객체로 들어온다. 우리가 쓰는 건 표시 문자열뿐이다. */
function cellToString(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'object') {
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.text === 'string') {
      return candidate.text.trim();
    }
    if (Array.isArray(candidate.richText)) {
      return candidate.richText
        .map((part) => String((part as { text?: string }).text ?? ''))
        .join('')
        .trim();
    }
    if (candidate.result !== undefined) {
      return cellToString(candidate.result);
    }
  }
  return String(value).trim();
}

/** 헤더 비교용. 셀 안에 줄바꿈이 들어간 컬럼(`학\n점`)이 있어 공백을 전부 지운다. */
export function normalizeHeader(text: string): string {
  return text.replace(/\s+/g, '');
}
