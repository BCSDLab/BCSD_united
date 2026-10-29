import { generateStructured } from '@koin/b-bot-ai';
import { convertRows } from './convert';
import { normalizeHeader } from './sheet';
import type { MappingSpec } from './types';

/** 모델에 보낼 행 수. 헤더 위치를 찾을 만큼의 앞부분 + 값 형태를 볼 만큼의 표본. */
const PREVIEW_HEAD_ROWS = 6;
const PREVIEW_SAMPLE_ROWS = 8;
/** 셀 하나가 길어도 판단에는 앞부분이면 충분하다. 비고란이 프롬프트를 잡아먹는 걸 막는다. */
const MAX_CELL_LENGTH = 40;

const COLUMN_KEYS = [
  'code',
  'name',
  'lectureClass',
  'professor',
  'grades',
  'regularNumber',
  'department',
  'target',
  'designScore',
  'classTime',
  'isEnglish',
] as const;

type ColumnKey = (typeof COLUMN_KEYS)[number];

/** 이게 없으면 강의를 식별하거나 시간표에 올릴 수 없다. */
const REQUIRED_COLUMNS: ColumnKey[] = ['code', 'name', 'lectureClass', 'classTime', 'grades'];

const SPEC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['headerRow', 'timeFormat', 'columns'],
  properties: {
    headerRow: {
      type: 'integer',
      description: '헤더가 있는 행 번호(1-based). 미리보기 각 줄 앞의 r번호를 그대로 쓴다.',
    },
    timeFormat: {
      type: 'string',
      enum: ['period', 'range'],
      description: '강의시간이 `월07A~09B` 같은 교시 표기면 period, `09:00~12:00` 같은 시간 범위면 range.',
    },
    columns: {
      type: 'object',
      additionalProperties: false,
      required: [...COLUMN_KEYS],
      properties: Object.fromEntries(
        COLUMN_KEYS.map((key) => [
          key,
          { type: 'string', description: `${key} 컬럼의 헤더 이름을 그대로 옮겨 적는다. 없으면 빈 문자열.` },
        ]),
      ),
    },
  },
} as const;

const SYSTEM_PROMPT = `너는 한국기술교육대학교 수강신청 편람 엑셀을 읽고 컬럼 위치를 알려주는 도구다.

컬럼명과 순서는 학기마다 바뀐다. 이름이 아니라 **값의 형태**로 판단해라.

- code: 과목코드. \`MEB201\`처럼 영문 3자 + 숫자 3자.
- name: 교과목명. \`교과명(한)\`, \`교과목명\` 등으로 불린다.
- lectureClass: 분반. \`01\` 또는 \`1\`.
- classTime: 강의시간. \`월07A~09B\` 또는 \`09:00~12:00\`.
- grades: 학점. \`학점\`, 한 글자 \`학\`, 줄바꿈이 낀 \`학 점\` 전부 같은 뜻이다.
  바로 옆의 강의(\`강\`)·실습(\`실\`)·설계(\`설\`)와 헷갈리지 마라. 넷이 나란히 오는 파일이 많다.
- designScore: 설계 학점. \`설계\` 또는 \`설\`. 실습이 아니다.
- regularNumber: 정원. \`정원\`, \`수강정원\`.
- department: 개설 학과. \`개설학과\`, \`개설학부(과)\`.
- target: 수강 대상 학부. \`대상학부(과)\`, \`수강대상\`.
- isEnglish: 영어 강의 여부. \`영어강의여부\`, \`영어강의\`. 값이 N/Y다. 계절학기엔 없다.

답하는 법:
- 각 항목에 **헤더 칸에 적힌 글자를 그대로 옮겨 적어라.** 위치를 세지 마라.
  예: 헤더가 \`과목코드\`면 code에 "과목코드", \`교과명(한)\`이면 "교과명(한)".
- 헤더 행에 없는 이름을 지어내지 마라. 반드시 그 행에 실제로 있는 글자여야 한다.
- 1행이 제목이고 2~3행이 헤더인 파일이 흔하다.
- 해당하는 컬럼이 없으면 빈 문자열.`;

/**
 * 컬럼이 진짜 그 컬럼인지 값의 형태로 확인한다.
 * 헤더가 비어 있지 않다는 것만으로는 부족하다 — 한 칸 밀린 스펙도 그 검사는 통과한다.
 * (실제로 `개설학부(과)`를 과목코드로 지목한 답이 통과한 적이 있다.)
 */
const VALUE_SHAPES: Partial<Record<ColumnKey, { test: (v: string) => boolean; expected: string }>> = {
  code: { test: (v) => /^[A-Za-z]{2,4}\d{2,4}$/.test(v), expected: 'MEB201 같은 과목코드' },
  name: { test: (v) => !/^[A-Za-z]{2,4}\d{2,4}$/.test(v), expected: '교과목명(과목코드가 아님)' },
  lectureClass: { test: (v) => /^\d{1,2}$/.test(v), expected: '01 같은 분반 번호' },
  grades: { test: (v) => /^\d{1,2}(\.\d)?$/.test(v), expected: '학점 숫자' },
  designScore: { test: (v) => /^\d{1,2}(\.\d)?$/.test(v), expected: '설계 학점 숫자' },
  regularNumber: { test: (v) => /^\d{1,4}$/.test(v), expected: '정원 숫자' },
  isEnglish: { test: (v) => /^[YNyn]$/.test(v), expected: 'N 또는 Y' },
};

/**
 * 지금까지 실제로 본 헤더 이름들. **매핑에는 쓰지 않는다** — 그러면 새 학기에 또 깨진다.
 * 반증에만 쓴다: 어떤 컬럼이 *다른* 컬럼의 이름을 가리키고 있으면 확실히 틀린 것이다.
 * 처음 보는 이름은 판단하지 않고 넘긴다. 그 경우를 맡으라고 LLM을 쓰는 것이다.
 *
 * `설계`와 `실습`은 둘 다 작은 정수라 값만 봐서는 구분되지 않아 이 검사가 필요하다.
 */
const HEADER_ALIASES: Record<string, string[]> = {
  code: ['과목코드', '교과목코드'],
  name: ['교과목명', '교과명(한)', '교과명'],
  lectureClass: ['분반'],
  professor: ['담당교수'],
  grades: ['학점', '학'],
  designScore: ['설계', '설'],
  regularNumber: ['정원', '수강정원'],
  department: ['개설학과', '개설학부', '개설학부(과)'],
  target: ['대상학부(과)', '대상학부', '수강대상'],
  classTime: ['강의시간'],
  isEnglish: ['영어강의여부', '영어강의'],
  // 우리가 쓰지 않는 컬럼. 여기를 가리키면 무조건 오답이다.
  __unused: ['실습', '실', '강의', '강', '이수구분', '대표이수구분', '이수영역', '학년', '대상학년'],
};

function foreignHeaderOwner(headerText: string, ownKey: string): string | null {
  for (const [key, names] of Object.entries(HEADER_ALIASES)) {
    if (key !== ownKey && names.includes(headerText)) {
      return key === '__unused' ? '사용하지 않는 컬럼' : key;
    }
  }
  return null;
}

function checkHeaderNames(spec: MappingSpec, header: string[]): string[] {
  const problems: string[] = [];

  for (const [key, index] of Object.entries(spec.columns)) {
    const text = normalizeHeader(header[index] ?? '');
    if (text === '' || HEADER_ALIASES[key]?.includes(text)) {
      continue;
    }
    const owner = foreignHeaderOwner(text, key);
    if (owner) {
      problems.push(`${key}가 가리키는 c${index}의 헤더는 "${text}"입니다. 이건 ${owner}입니다.`);
    }
  }

  return problems;
}

/** 표 아래 안내문 같은 잡음이 섞여도 흔들리지 않게 다수결로 본다. */
const SHAPE_SAMPLE_ROWS = 30;
const SHAPE_PASS_RATIO = 0.8;

function checkValueShapes(spec: MappingSpec, rows: string[][]): string[] {
  const problems: string[] = [];
  const dataRows = rows.slice(spec.headerRow, spec.headerRow + SHAPE_SAMPLE_ROWS);

  for (const [key, shape] of Object.entries(VALUE_SHAPES)) {
    const index = spec.columns[key as ColumnKey];
    if (index === undefined || !shape) {
      continue;
    }

    const values = dataRows.map((row) => row[index] ?? '').filter((v) => v !== '');
    if (values.length === 0) {
      problems.push(`${key}가 가리키는 c${index}는 데이터가 전부 비어 있습니다.`);
      continue;
    }

    const passed = values.filter(shape.test).length;
    if (passed / values.length < SHAPE_PASS_RATIO) {
      const sample = values
        .slice(0, 3)
        .map((v) => `"${v}"`)
        .join(', ');
      problems.push(`${key}가 가리키는 c${index}의 값은 ${sample} 입니다. ${shape.expected}이어야 합니다.`);
    }
  }

  return problems;
}

/** 헤더 셀에 개행이 들어 있어(`학\n점`) 그대로 두면 미리보기의 행 구조가 깨진다. */
function cellText(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_CELL_LENGTH ? `${flat.slice(0, MAX_CELL_LENGTH)}…` : flat;
}

/**
 * 모델에 보낼 시트 미리보기.
 * 전체를 보내지 않는 건 비용 때문만이 아니다. 모델이 데이터를 옮겨 적게 두면
 * 조용히 틀린 값이 섞이므로, 판단에 필요한 만큼만 주고 변환은 코드가 한다.
 */
export function buildPreview(rows: string[][]): string {
  // 위치가 아니라 헤더 이름을 물으므로 인덱스 라벨을 붙이지 않는다.
  // 라벨을 붙여봤더니 모델이 그걸 무시하고 자기 방식으로 세어 한 칸씩 밀린 답을 냈다.
  const render = (row: string[], index: number) => `r${index + 1}: ${row.map(cellText).join(' | ')}`;

  const head = rows.slice(0, PREVIEW_HEAD_ROWS).map(render);
  const sample = rows
    .slice(PREVIEW_HEAD_ROWS, PREVIEW_HEAD_ROWS + PREVIEW_SAMPLE_ROWS)
    .map((row, i) => render(row, PREVIEW_HEAD_ROWS + i));

  return [...head, '...', ...sample].join('\n');
}

interface RawSpec {
  headerRow: number;
  timeFormat: 'period' | 'range';
  columns: Record<ColumnKey, string>;
}

/**
 * 모델이 옮겨 적은 헤더 이름을 실제 위치로 바꾼다.
 * 위치를 세는 건 코드가 훨씬 잘하고, 모델은 이름만 읽으면 된다.
 * 헤더 행에 없는 이름을 답했다면 그 컬럼은 못 찾은 것으로 두고 검증에서 걸러낸다.
 */
function toSpec(raw: RawSpec, header: string[]): { spec: MappingSpec; unresolved: string[] } {
  const normalized = header.map(normalizeHeader);
  const columns = {} as MappingSpec['columns'];
  const unresolved: string[] = [];

  for (const key of COLUMN_KEYS) {
    const wanted = normalizeHeader(raw.columns[key] ?? '');
    if (wanted === '') {
      continue;
    }
    const index = normalized.indexOf(wanted);
    if (index === -1) {
      unresolved.push(`${key}에 적은 "${raw.columns[key]}"는 ${raw.headerRow}행에 없는 이름입니다.`);
      continue;
    }
    (columns as Record<string, number>)[key] = index;
  }

  return { spec: { headerRow: raw.headerRow, timeFormat: raw.timeFormat, columns }, unresolved };
}

/**
 * 스펙이 실제로 쓸 만한지 코드가 판정한다.
 * 모델이 그럴듯한 값을 줘도 여기서 걸리면 다시 물어본다.
 */
function validate(spec: MappingSpec, rows: string[][]): string[] {
  const problems: string[] = [];

  const header = rows[spec.headerRow - 1];
  if (!header || header.every((cell) => cell === '')) {
    problems.push(`headerRow ${spec.headerRow}행이 비어 있습니다.`);
    return problems;
  }

  for (const key of REQUIRED_COLUMNS) {
    if (spec.columns[key] === undefined) {
      problems.push(`필수 컬럼 ${key}를 찾지 못했습니다.`);
    }
  }

  for (const [key, index] of Object.entries(spec.columns)) {
    if (index >= header.length || normalizeHeader(header[index] ?? '') === '') {
      problems.push(`${key}가 가리키는 c${index}는 ${spec.headerRow}행에서 빈 칸입니다.`);
    }
  }

  if (problems.length > 0) {
    return problems;
  }

  problems.push(...checkHeaderNames(spec, header));
  problems.push(...checkValueShapes(spec, rows));
  if (problems.length > 0) {
    return problems;
  }

  // 실제로 돌려본다. 스펙이 그럴듯해도 변환에서 깨지면 쓸 수 없다.
  const result = convertRows(rows, spec);
  if (result.stats.converted === 0) {
    problems.push('변환된 강의가 0건입니다. headerRow나 code/name 위치가 틀렸을 수 있습니다.');
  }
  if (result.issues.length > 0) {
    const sample = result.issues
      .slice(0, 3)
      .map((i) => `${i.row}행 "${i.value}"`)
      .join(', ');
    problems.push(
      `강의시간 파싱 실패 ${result.issues.length}건 (${sample}). classTime 위치나 timeFormat이 틀렸을 수 있습니다.`,
    );
  }

  return problems;
}

/**
 * 엑셀 미리보기 → 매핑 스펙. 검증에 실패하면 사유를 붙여 다시 물어본다.
 * 재시도해도 안 되면 사람이 봐야 하므로 실패를 감추지 않고 던진다.
 */
export async function generateMappingSpec(
  rows: string[][],
  { maxAttempts = 3 }: { maxAttempts?: number } = {},
): Promise<MappingSpec> {
  const preview = buildPreview(rows);
  let feedback = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const raw = await generateStructured<RawSpec>({
      system: SYSTEM_PROMPT,
      schema: SPEC_SCHEMA as unknown as Record<string, unknown>,
      prompt: `다음은 강의 편람 엑셀의 앞부분이다. 각 컬럼의 헤더 이름을 알려줘.\n\n${preview}${feedback}`,
    });

    const header = rows[raw.headerRow - 1] ?? [];
    const { spec, unresolved } = toSpec(raw, header);
    const problems = [...unresolved, ...validate(spec, rows)];
    if (problems.length === 0) {
      return spec;
    }

    console.warn(`매핑 스펙 ${attempt}차 시도 실패:`, problems);

    feedback = [
      '',
      '',
      `직전 답변(headerRow ${raw.headerRow}, ${raw.timeFormat}, ${JSON.stringify(raw.columns)})은 아래 문제로 실패했다.`,
      ...problems.map((p) => `- ${p}`),
      '',
      `${raw.headerRow}행에 실제로 있는 이름은 이게 전부다. 여기서 골라라.`,
      header
        .map(normalizeHeader)
        .filter((t) => t !== '')
        .join(' | '),
      '',
      '고쳐서 다시 답해라.',
    ].join('\n');
  }

  throw new Error(`매핑 스펙 생성 실패(${maxAttempts}회 시도). 엑셀 형식을 사람이 확인해야 합니다.`);
}
