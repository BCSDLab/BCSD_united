const DAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
export type Day = (typeof DAYS)[number];
export const WEEKDAYS = DAYS.slice(0, 5);

const DAY_INDEX: Record<string, number> = {
  월: 0,
  화: 1,
  수: 2,
  목: 3,
  금: 4,
  토: 5,
  일: 6,
};
const TOKEN = /(?<![0-9])(월|화|수|목|금|토|일)(?:요일)?(?=[()\s,~·\-/]|$)/g;
/** "월화수목금"처럼 구분자 없이 연속된 요일. 2글자 이상만 매칭해 "운행일" 같은
 *  고유명사의 단독 일(日)을 요일로 오인하지 않는다. 조사 "으로"의 "으"도 허용한다. */
const SEQUENCE = /(?<![0-9])((?:월|화|수|목|금|토|일){2,})(?:요일)?(?=[()\s,~·\-/으]|$)/g;
const RANGE = /(?<![0-9])(월|화|수|목|금|토|일)(?:요일)?\s*~\s*(?<![0-9])(월|화|수|목|금|토|일)(?:요일)?/;

/**
 * 운행 요일을 원문에서 읽는다. "월~금", "주중", "금,일요일", "목·금 추가" 같은
 * 표기를 모두 받으며, 형식이 늘어나도 이 함수를 고치지 않아도 된다. 결과는
 * 항상 정규 순서(MON~SUN)로 돌려주고, 언급된 요일이 없으면 undefined다.
 */
export function sourceDays(text: string): Day[] | undefined {
  const normalized = text
    .replace(/[~～-]/g, '~')
    .replace(/[,·/、]/g, ',')
    // 공백을 없애면 "6/22~7/12 월~금"이 "7/12월~금"이 되어 날짜 숫자 때문에
    // 요일 범위로 읽지 못한다. 단일 공백으로만 줄인다.
    .replace(/\s+/g, ' ');

  if (/주중|평일/.test(normalized)) return [...WEEKDAYS];
  if (/주말/.test(normalized)) return ['SAT', 'SUN'];
  if (/매일|매주/.test(normalized)) return [...DAYS];

  const range = RANGE.exec(normalized);
  if (range) {
    const start = DAY_INDEX[range[1]];
    const end = DAY_INDEX[range[2]];
    return start <= end ? DAYS.slice(start, end + 1) : [...DAYS.slice(start), ...DAYS.slice(0, end + 1)];
  }

  const found = new Set<Day>();
  for (const match of normalized.matchAll(SEQUENCE)) {
    for (const ch of match[1]) {
      const day = DAYS[DAY_INDEX[ch]];
      if (day) found.add(day);
    }
  }
  if (found.size === 0) {
    for (const match of normalized.matchAll(TOKEN)) {
      found.add(DAYS[DAY_INDEX[match[1]]]);
    }
  }
  return found.size ? DAYS.filter((day) => found.has(day)) : undefined;
}
