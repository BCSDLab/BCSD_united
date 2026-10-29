import type { LectureInfo } from './types';

const DAY_NAMES = ['월', '화', '수', '목', '금', '토', '일'];

/** 슬롯 0이 09:00, 한 슬롯이 30분. */
function slotToClock(slot: number): string {
  const minutes = 9 * 60 + slot * 30;
  const hour = Math.floor(minutes / 60);
  return `${String(hour).padStart(2, '0')}:${minutes % 60 === 0 ? '00' : '30'}`;
}

/** 교시 표기. 슬롯 12 → `7A`. */
function slotToPeriod(slot: number): string {
  return `${Math.floor(slot / 2) + 1}${slot % 2 === 0 ? 'A' : 'B'}`;
}

interface Span {
  days: number[];
  start: number;
  end: number;
}

/**
 * 같은 시간대를 여러 요일이 공유하면 하나로 묶는다.
 * 계절학기는 월~금 5일로 전개돼 그대로 두면 한 강의가 10줄이 된다.
 */
function groupByTime(infos: LectureInfo[]): Span[] {
  const byRange = new Map<string, Span>();

  for (const info of infos) {
    const start = info.start_time % 100;
    const end = info.end_time % 100;
    const key = `${start}-${end}`;
    const span = byRange.get(key);
    if (span) {
      if (!span.days.includes(info.day)) {
        span.days.push(info.day);
      }
    } else {
      byRange.set(key, { days: [info.day], start, end });
    }
  }

  return [...byRange.values()].sort((a, b) => a.start - b.start);
}

/** 연속한 요일은 `월~금`으로 줄인다. */
function describeDays(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  const runs: number[][] = [];

  for (const day of sorted) {
    const last = runs.at(-1);
    if (last && day === last.at(-1)! + 1) {
      last.push(day);
    } else {
      runs.push([day]);
    }
  }

  return runs
    .map((run) =>
      run.length >= 3 ? `${DAY_NAMES[run[0]]}~${DAY_NAMES[run.at(-1)!]}` : run.map((d) => DAY_NAMES[d]).join('·'),
    )
    .join(', ');
}

/**
 * 저장될 값을 사람이 읽는 문장으로. 검토 화면에서 원본과 나란히 놓고 비교한다.
 * `[{day:0,0~5}, {day:1,100~105}, …]` → `월~금 09:00~12:00 (1A~3B)`
 */
export function describeClassTime(infos: LectureInfo[]): string {
  if (infos.length === 0) {
    return '시간 없음';
  }

  return groupByTime(infos)
    .map((span) => {
      const clock = `${slotToClock(span.start)}~${slotToClock(span.end + 1)}`;
      const period = `${slotToPeriod(span.start)}~${slotToPeriod(span.end)}`;
      return `${describeDays(span.days)} ${clock} (${period})`;
    })
    .join(' / ');
}
