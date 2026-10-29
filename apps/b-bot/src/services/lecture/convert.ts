import { ClassTimeParseError, parsePeriodFormat, parseRangeFormat } from './classTime';
import type { ConvertIssue, ConvertResult, Lecture, LectureInfo, MappingSpec } from './types';

/** 계절학기는 월~금 매일 같은 시간에 수업한다. */
const DEFAULT_SEASONAL_DAYS = [0, 1, 2, 3, 4];

function cell(row: string[], index: number | undefined): string {
  if (index === undefined) {
    return '';
  }
  return row[index] ?? '';
}

/**
 * 엑셀 행렬 + 매핑 스펙 → 강의 목록.
 *
 * 스펙만 학기마다 달라지고 이 변환 자체는 결정적이다.
 * 나중에 스펙을 LLM이 만들어도 여기는 바뀌지 않는다.
 */
export function convertRows(rows: string[][], spec: MappingSpec): ConvertResult {
  const { columns } = spec;
  const days = spec.seasonalDays ?? DEFAULT_SEASONAL_DAYS;

  const lectures: Lecture[] = [];
  const issues: ConvertIssue[] = [];
  let skipped = 0;
  let withoutTime = 0;

  const dataRows = rows.slice(spec.headerRow);

  dataRows.forEach((row, offset) => {
    const rowNumber = spec.headerRow + offset + 1;
    const code = cell(row, columns.code);
    const name = cell(row, columns.name);
    const rawTime = cell(row, columns.classTime);
    const lectureClass = padClass(cell(row, columns.lectureClass));

    // 한 강의가 하루에 두 시간대를 쓰면 시간대마다 행이 하나씩 생긴다.
    // 엑셀에서는 나머지 칸이 병합돼 비어 보이지만, exceljs는 병합된 칸을
    // 원본 값으로 채워주기 때문에 "앞 강의와 같은 과목코드·분반"으로 판별한다.
    const previous = lectures.at(-1);
    const isContinuation =
      previous !== undefined &&
      rawTime !== '' &&
      ((code === '' && name === '') || (code === previous.code && lectureClass === previous.lecture_class));

    if (isContinuation) {
      const extra = parseTime(rawTime, spec, days, rowNumber, issues);
      if (extra) {
        previous.lecture_infos = mergeInfos(previous.lecture_infos, extra);
      }
      // 추가 시간대를 다른 교수가 맡기도 한다. 프로덕션은 `/`로 이어 붙여 저장한다.
      const extraProfessor = cell(row, columns.professor);
      if (extraProfessor !== '' && !previous.professor.includes(extraProfessor)) {
        previous.professor = previous.professor === '' ? extraProfessor : `${previous.professor}/${extraProfessor}`;
      }
      return;
    }

    if (code === '' || name === '') {
      // 표 아래 안내문·빈 행. 강의가 아니므로 조용히 건너뛴다.
      if (row.some((value) => value !== '')) {
        skipped += 1;
      }
      return;
    }

    const infos = parseTime(rawTime, spec, days, rowNumber, issues);
    if (infos === null) {
      skipped += 1;
      return;
    }
    if (infos.length === 0) {
      withoutTime += 1;
    }

    lectures.push({
      code,
      name,
      lecture_class: lectureClass,
      professor: cell(row, columns.professor),
      grades: cell(row, columns.grades),
      regular_number: cell(row, columns.regularNumber),
      department: cell(row, columns.department),
      target: cell(row, columns.target),
      design_score: cell(row, columns.designScore),
      // 엑셀에 있으면 원본(N/Y)을 쓴다. 계절학기엔 컬럼이 없어 기본값으로 둔다.
      is_english: cell(row, columns.isEnglish) || '0',
      is_elearning: rawTime.includes('온라인') ? '1' : '0',
      lecture_infos: infos,
      raw_class_time: rawTime,
    });
  });

  return {
    lectures,
    issues,
    stats: {
      totalRows: dataRows.length,
      converted: lectures.length,
      skipped,
      withoutTime,
    },
  };
}

/** 파싱에 실패하면 그 행만 버리고 사유를 남긴다. 한 줄 때문에 전체가 멈추면 안 된다. */
function parseTime(
  raw: string,
  spec: MappingSpec,
  days: number[],
  rowNumber: number,
  issues: ConvertIssue[],
): LectureInfo[] | null {
  try {
    return spec.timeFormat === 'period' ? parsePeriodFormat(raw) : parseRangeFormat(raw, days);
  } catch (error) {
    if (error instanceof ClassTimeParseError) {
      issues.push({
        row: rowNumber,
        kind: 'unparsable_time',
        value: raw,
        message: error.message,
      });
      return null;
    }
    throw error;
  }
}

/** 계절학기 엑셀은 분반을 `1`로, 정규는 `01`로 쓴다. 저장은 두 자리로 통일돼 있다. */
function padClass(raw: string): string {
  return /^\d+$/.test(raw) ? raw.padStart(2, '0') : raw;
}

function mergeInfos(base: LectureInfo[], extra: LectureInfo[]): LectureInfo[] {
  return [...base, ...extra].sort((a, b) => a.start_time - b.start_time);
}
