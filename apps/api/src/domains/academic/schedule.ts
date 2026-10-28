export const terms = {
  WINTER: { label: '겨울학기', suffix: '-겨울', priority: 1 },
  SECOND: { label: '2학기', suffix: '2', priority: 2 },
  SUMMER: { label: '여름학기', suffix: '-여름', priority: 3 },
  FIRST: { label: '1학기', suffix: '1', priority: 4 },
} as const;
export type Term = keyof typeof terms;
export type LectureInfo = { day: number; start_time: number; end_time: number; place: string };
export type ClassInfo = { class_time: number[]; class_place: string | null };
export function parseTimes(value: string | null | undefined): number[] {
  if (!value) return [];
  return value.replace(/[\[\]]/g, '').split(',').map((part) => part.trim()).filter(Boolean).map(Number);
}
export function regularLectureInfo(time: string | null, place: string | null): LectureInfo[] {
  const times = parseTimes(time);
  if (!times.length) return [];
  const places = place?.trim() ? place.split(',').map((part) => part.trim()) : [];
  const result: LectureInfo[] = [];
  let start = times[0];
  let end = start;
  const add = () => result.push({ day: Math.trunc(start / 100), start_time: start, end_time: end, place: places[result.length] ?? '' });
  for (const slot of times.slice(1)) {
    if (slot === end + 1) end = slot;
    else { add(); start = slot; end = slot; }
  }
  add();
  return result;
}
export function customLectureInfo(time: string | null, place: string | null): LectureInfo[] {
  if (time === null || place === null) return [];
  const times = parseTimes(time);
  if (!times.length) return [];
  const places = place.trim() ? place.split(',').map((part) => part.trim()) : [];
  const result: LectureInfo[] = [];
  let start = times[0];
  let end = start;
  let placeIndex = 0;
  const add = () => result.push({ day: Math.trunc(start / 100), start_time: start, end_time: end, place: places[placeIndex] ?? '' });
  // `-1`은 장소 구분자다. 연속 슬롯은 한 구간으로 묶고, 구분자를 만나면 다음 장소로 넘어간다.
  for (const slot of times.slice(1)) {
    if (end === -1) {
      start = slot;
      end = slot;
      continue;
    }
    if (slot === end + 1) {
      end = slot;
      continue;
    }
    add();
    if (slot === -1) placeIndex++;
    start = slot;
    end = slot;
  }
  if (end !== -1) add();
  return result;
}
export function legacyClassInfo(time: string | null, place: string | null): ClassInfo[] {
  const times = parseTimes(time);
  if (!times.length) return [];
  if (place === null) return [{ class_time: times, class_place: null }];
  const places = place.split(/,\s*/);
  const result: ClassInfo[] = [];
  let slots: number[] = [];
  const add = () => {
    if (!slots.length) return;
    result.push({ class_time: slots, class_place: places[result.length] ?? '' });
    slots = [];
  };
  for (const slot of times) {
    if (slot === -1) add();
    else slots.push(slot);
  }
  add();
  return result;
}
export function encodeClassInfo(infos: ClassInfo[] | null | undefined) {
  if (infos == null) return { class_time: null, class_place: null };
  return { class_time: `[${infos.flatMap((info, index) => index ? [-1, ...info.class_time] : info.class_time).join(', ')}]`, class_place: infos.map((info) => info.class_place ?? '').join(', ') };
}
export function encodeLectureInfo(infos: { start_time: number; end_time: number; place?: string | null }[]) {
  return encodeClassInfo(infos.map((info) => ({ class_time: Array.from({ length: Math.max(0, info.end_time - info.start_time + 1) }, (_, index) => info.start_time + index), class_place: info.place ?? '' })));
}
export function courseTimeText(times: number[]): string {
  const days = ['월', '화', '수', '목', '금'];
  const result: string[] = [];
  const code = (period: number) => `${String(Math.trunc(period / 2) + 1).padStart(2, '0')}${period % 2 === 0 ? 'A' : 'B'}`;
  for (let day = 0; day < days.length; day++) {
    const periods = times.filter((slot) => Math.trunc(slot / 100) === day && slot % 100 <= 5).map((slot) => slot % 100).sort((a, b) => a - b);
    if (periods.length) result.push(days[day] + code(periods[0]) + (periods[0] === periods[periods.length - 1] ? '' : `~${code(periods[periods.length - 1])}`));
  }
  return result.join(',');
}
export function semesterOrder(a: { year: number; term: string }, b: { year: number; term: string }) {
  return b.year - a.year || terms[a.term as Term].priority - terms[b.term as Term].priority;
}
export function earnedCredits(lectures: { grades: string; lecture_grades?: string | null }[], isMain: boolean, legacy = false): number {
  if (!isMain && !legacy) return 0;
  return lectures.reduce((sum, lecture) => {
    const value = lecture.lecture_grades ?? (legacy ? '0' : lecture.grades);
    const credit = Number(value);
    if (!/^[+-]?\d+$/.test(value) || !Number.isInteger(credit) || credit < -2147483648 || credit > 2147483647) throw new Error(`For input string: "${value}"`);
    return sum + credit;
  }, 0);
}
