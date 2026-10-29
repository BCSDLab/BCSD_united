import { normalizePeriodInput, normalizeRangeInput, parsePeriodFormat, parseRangeFormat } from './classTime';
import { describeClassTime } from './describeTime';
import { generateStructured } from '@koin/b-bot-ai';
import type { Lecture, TimeFormat } from './types';

/** 계절학기는 요일이 없어 월~금으로 전개한다. 변환 때와 같은 규칙이다. */
const SEASONAL_DAYS = [0, 1, 2, 3, 4];

const DAY_INDEX: Record<string, number> = { 월: 0, 화: 1, 수: 2, 목: 3, 금: 4, 토: 5, 일: 6 };

/**
 * 정규학기 강의시간은 교시로도 시각으로도 말할 수 있다.
 * 슬롯 0이 09:00이라 저장 구조상 둘 다 표현되므로, 값만 봐서는 구분되지 않는다.
 * `교시`나 A/B가 있으면 교시, `:`나 `시`가 있으면 시각, 아무 신호도 없으면 물어본다.
 */
function timeSignal(value: string): 'period' | 'clock' | 'unknown' {
  if (/교시/.test(value) || /[ABab]/.test(value)) {
    return 'period';
  }
  // `9교시`의 `시`를 시각 신호로 오해하지 않도록 교시를 먼저 걷어낸다.
  if (/:/.test(value) || /시/.test(value.replace(/교시/g, ''))) {
    return 'clock';
  }
  return 'unknown';
}

/** 같은 입력을 시각으로 읽으면 어떻게 되는지. 요일은 입력이나 원래 값에서 가져온다. */
function readAsClock(value: string, current: string): Lecture['lecture_infos'] | null {
  const dayChar = (value.match(/[월화수목금토일]/) ?? current.match(/[월화수목금토일]/))?.[0];
  if (!dayChar) {
    return null;
  }
  try {
    const withoutDay = value.replace(/[월화수목금토일]|요일/g, '').trim();
    return parseRangeFormat(normalizeRangeInput(withoutDay), [DAY_INDEX[dayChar]]);
  } catch {
    return null;
  }
}

const FIELDS = {
  name: { label: '교과목명', limit: 50 },
  professor: { label: '담당교수', limit: 30 },
  grades: { label: '학점', limit: 2 },
  regular_number: { label: '정원', limit: 4 },
  department: { label: '개설학과', limit: 30 },
  target: { label: '수강대상', limit: 200 },
  design_score: { label: '설계학점', limit: 2 },
  is_english: { label: '영어강의', limit: 2 },
  is_elearning: { label: '이러닝', limit: 2 },
  class_time: { label: '강의시간', limit: 0 },
  code: { label: '과목코드', limit: 10 },
  lecture_class: { label: '분반', limit: 3 },
} as const;

type FieldKey = keyof typeof FIELDS;

const PATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['patches', 'unclear'],
  properties: {
    patches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['identifier', 'lectureClass', 'field', 'value'],
        properties: {
          identifier: { type: 'string', description: '과목코드 또는 교과목명. 사용자가 부른 대로.' },
          lectureClass: { type: 'string', description: '분반. 말하지 않았으면 빈 문자열.' },
          field: { type: 'string', enum: Object.keys(FIELDS), description: '바꿀 항목' },
          value: { type: 'string', description: '바꿀 값. 강의시간은 `월07A~09B` 또는 `09:00~12:00` 형태 그대로.' },
        },
      },
    },
    unclear: {
      type: 'array',
      items: { type: 'string' },
      description: '무슨 뜻인지 확실하지 않아 손대지 않은 부분. 추측하지 말고 여기 적는다.',
    },
  },
} as const;

const SYSTEM_PROMPT = `너는 강의 데이터 수정 요청을 구조화하는 도구다.

사용자가 자연어로 말한 수정 사항을 항목 단위로 쪼갠다.

- 값을 지어내지 마라. 사용자가 말하지 않은 건 바꾸지 않는다.
- 한 문장에 여러 강의가 있으면 각각 따로 적는다.
- 무슨 뜻인지 애매하면 patches에 넣지 말고 unclear에 적어라. 추측해서 바꾸면
  되돌릴 방법이 없다.
- 강의시간은 사용자가 쓴 표기를 그대로 옮긴다. 해석은 코드가 한다.
  \`월6A~6B\` 처럼 한 자리로 써도 그대로 둔다.
- 직전 대화가 함께 주어지면 참고만 해라. **지금 메시지가 요청하는 것만** 내놓는다.
  이미 처리된 앞선 요청을 다시 내지 마라.
  다만 지금 메시지가 앞선 질문에 대한 답이면(예: "시각으로 해줘") 앞 대화에서
  대상 강의와 값을 가져와 완성한다.
- 앞 대화에서 교시인지 시각인지 되물었고 사용자가 한쪽을 골랐다면,
  **고른 쪽이 분명히 드러나는 형태로 적어라.**
  시각을 골랐으면 \`09:00~10:00\`처럼, 교시를 골랐으면 \`9교시~10교시\`처럼 쓴다.
  \`09~10\` 같이 애매한 표기를 그대로 옮기면 또 되묻게 된다.

바꿀 수 있는 항목: ${Object.entries(FIELDS)
  .map(([key, { label }]) => `${key}(${label})`)
  .join(', ')}`;

export interface Patch {
  lecture: Lecture;
  field: FieldKey;
  label: string;
  before: string;
  after: string;
  /** class_time만 해당. 적용할 때 파싱 결과를 다시 쓰지 않으려고 들고 있는다. */
  parsed?: Lecture['lecture_infos'];
  rawValue: string;
}

/** 교시인지 시각인지 정하지 못한 요청. 사람이 고르면 코드가 확정한다. */
export interface TimeAmbiguity {
  lecture: Lecture;
  rawValue: string;
  asPeriod: { normalized: string; infos: Lecture['lecture_infos'] };
  asClock: { normalized: string; infos: Lecture['lecture_infos'] };
}

export interface PatchPlan {
  patches: Patch[];
  problems: string[];
  ambiguities: TimeAmbiguity[];
}

/**
 * 어떻게 다시 말해야 하는지 알려준다.
 * 원래 시간이 없는 강의는 요일을 물려받을 수 없어 안내가 달라야 한다.
 */
function hint(lecture: Lecture, timeFormat: TimeFormat): string {
  if (timeFormat === 'range') {
    return '`09:00~12:00` 형태로 적어주세요.';
  }
  const hasDay = /[월화수목금토일]/.test(lecture.raw_class_time);
  return hasDay
    ? `현재 값은 \`${lecture.raw_class_time}\` 형태입니다. 요일과 교시를 함께 적어주세요.`
    : '이 강의는 원래 강의시간이 없어 요일을 물려받을 수 없습니다. `수09A~10B`처럼 요일을 함께 적어주세요.';
}

/** 계절학기(range)는 `9~12`도 시각 범위로 읽고, 정규학기는 시각 한 점으로 읽는다. */
function parseClockInput(value: string, current: string, timeFormat: TimeFormat): Lecture['lecture_infos'] | null {
  if (timeFormat === 'range') {
    return tryParse(() => parseRangeFormat(normalizeRangeInput(value), SEASONAL_DAYS));
  }
  return readAsClock(value, current);
}

function tryParse(read: () => Lecture['lecture_infos']): Lecture['lecture_infos'] | null {
  try {
    return read();
  } catch {
    return null;
  }
}

function findLecture(
  lectures: Lecture[],
  identifier: string,
  lectureClass: string,
): { lecture?: Lecture; problem?: string } {
  const wanted = identifier.trim().toLowerCase();
  let matches = lectures.filter((l) => l.code.toLowerCase() === wanted || l.name.toLowerCase() === wanted);

  if (matches.length === 0) {
    return { problem: `"${identifier}"에 해당하는 강의를 찾지 못했습니다.` };
  }
  if (lectureClass.trim() !== '') {
    const padded = lectureClass.trim().padStart(2, '0');
    matches = matches.filter((l) => l.lecture_class === padded);
    if (matches.length === 0) {
      return { problem: `"${identifier}"의 ${lectureClass}분반을 찾지 못했습니다.` };
    }
  }
  if (matches.length > 1) {
    const classes = matches.map((l) => l.lecture_class).join(', ');
    return { problem: `"${identifier}"는 분반이 여러 개입니다(${classes}). 분반을 지정해주세요.` };
  }

  return { lecture: matches[0] };
}

/**
 * 자연어 → 검증된 수정 계획.
 *
 * LLM은 "무엇을 무엇으로"만 뽑고, 그게 말이 되는지는 전부 코드가 본다.
 * 강의시간은 실제로 파싱해봐서 통과해야만 계획에 들어간다.
 */
export async function planPatches(
  text: string,
  lectures: Lecture[],
  timeFormat: TimeFormat,
  /** 스레드 앞부분. "시각으로 해줘" 같은 답을 알아들으려면 필요하다. */
  context = '',
): Promise<PatchPlan> {
  const raw = await generateStructured<{
    patches: { identifier: string; lectureClass: string; field: FieldKey; value: string }[];
    unclear: string[];
  }>({
    system: SYSTEM_PROMPT,
    schema: PATCH_SCHEMA as unknown as Record<string, unknown>,
    prompt: context
      ? `직전 대화:\n${context}\n\n지금 메시지(이것만 처리해라):\n${text}`
      : `다음 수정 요청을 구조화해줘.\n\n${text}`,
  });

  const patches: Patch[] = [];
  const ambiguities: TimeAmbiguity[] = [];
  const problems = raw.unclear.map((line) => `무슨 뜻인지 확실하지 않아 넘겼습니다: ${line}`);

  for (const item of raw.patches) {
    const { lecture, problem } = findLecture(lectures, item.identifier, item.lectureClass);
    if (!lecture || problem) {
      problems.push(problem ?? '강의를 찾지 못했습니다.');
      continue;
    }

    const spec = FIELDS[item.field];
    const where = `${lecture.code} ${lecture.lecture_class} ${lecture.name}`;

    if (item.field === 'class_time') {
      // 계절학기는 교시 개념이 없어 항상 시각이다.
      const signal = timeFormat === 'range' ? 'clock' : timeSignal(item.value);

      if (signal === 'unknown') {
        const asPeriod = tryParse(() => parsePeriodFormat(normalizePeriodInput(item.value, lecture.raw_class_time)));
        const asClock = readAsClock(item.value, lecture.raw_class_time);

        // 둘 다 말이 되면 추측하지 않는다. 고르는 건 사람이, 확정은 코드가 한다.
        if (asPeriod && asClock) {
          ambiguities.push({
            lecture,
            rawValue: item.value,
            asPeriod: {
              normalized: normalizePeriodInput(item.value, lecture.raw_class_time),
              infos: asPeriod,
            },
            asClock: { normalized: item.value, infos: asClock },
          });
          continue;
        }
      }

      const normalized = signal === 'clock' ? item.value : normalizePeriodInput(item.value, lecture.raw_class_time);

      const parsed =
        signal === 'clock'
          ? parseClockInput(item.value, lecture.raw_class_time, timeFormat)
          : tryParse(() => parsePeriodFormat(normalized));

      if (!parsed) {
        problems.push(
          [`${where}: 강의시간 "${item.value}"를 해석하지 못했습니다.`, hint(lecture, timeFormat)].join(' '),
        );
        continue;
      }

      patches.push({
        lecture,
        field: item.field,
        label: spec.label,
        before: describeClassTime(lecture.lecture_infos),
        after: describeClassTime(parsed),
        parsed,
        // 검토 화면의 "원본" 열에 들어갈 값. 사람이 말한 대로 남긴다.
        rawValue: signal === 'clock' ? item.value : normalized,
      });
      continue;
    }

    if (item.value.length > spec.limit) {
      problems.push(`${where}: ${spec.label}이 ${item.value.length}자입니다 (상한 ${spec.limit}).`);
      continue;
    }

    patches.push({
      lecture,
      field: item.field,
      label: spec.label,
      before: String(lecture[item.field as keyof Lecture] ?? ''),
      after: item.value,
      rawValue: item.value,
    });
  }

  return { patches, problems, ambiguities };
}

/**
 * 사람이 고른 쪽으로 확정한다.
 * 이 단계엔 LLM이 끼지 않는다 — 이미 계산해둔 두 해석 중 하나를 고르는 것뿐이다.
 */
export function resolveAmbiguities(ambiguities: TimeAmbiguity[], mode: 'period' | 'clock'): Patch[] {
  return ambiguities.map((item) => {
    const chosen = mode === 'period' ? item.asPeriod : item.asClock;
    return {
      lecture: item.lecture,
      field: 'class_time' as const,
      label: FIELDS.class_time.label,
      before: describeClassTime(item.lecture.lecture_infos),
      after: describeClassTime(chosen.infos),
      parsed: chosen.infos,
      rawValue: chosen.normalized,
    };
  });
}

/** 원본을 건드리지 않고 수정본을 새로 만든다. 적용 전 미리보기와 실제 적용이 갈라지지 않게. */
export function applyPatches(lectures: Lecture[], patches: Patch[]): Lecture[] {
  const byKey = new Map<string, Patch[]>();
  for (const patch of patches) {
    const id = `${patch.lecture.code}|${patch.lecture.lecture_class}`;
    byKey.set(id, [...(byKey.get(id) ?? []), patch]);
  }

  return lectures.map((lecture) => {
    const own = byKey.get(`${lecture.code}|${lecture.lecture_class}`);
    if (!own) {
      return lecture;
    }

    let next = { ...lecture };
    for (const patch of own) {
      if (patch.field === 'class_time') {
        next = { ...next, lecture_infos: patch.parsed ?? [], raw_class_time: patch.rawValue };
      } else {
        next = { ...next, [patch.field]: patch.after };
      }
    }
    return next;
  });
}
