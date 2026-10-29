import { DAYS } from 'static/day';

/**
 * 절대 시각의 KST 날짜를 달력용 로컬 자정으로 옮긴다.
 * 반환값은 날짜 필드·달력끼리의 비교에만 쓰며, 경과 시간이나 실제 시각 비교에는 쓰지 않는다.
 */
export function toKoreanCalendarDate(instant: Date): Date {
  const korean = new Date(instant.getTime() + 9 * 60 * 60 * 1000);

  return new Date(korean.getUTCFullYear(), korean.getUTCMonth(), korean.getUTCDate());
}

export interface CalendarCell {
  date: Date;
  currentMonth: boolean;
}

export function getCalendarDates(year: number, month: number): CalendarCell[] {
  const firstDayOfMonth = new Date(year, month, 1);
  const startDay = firstDayOfMonth.getDay();
  const lastDate = new Date(year, month + 1, 0).getDate();
  const prevMonthLastDate = new Date(year, month, 0).getDate();

  const dates: CalendarCell[] = [];

  for (let i = startDay - 1; i >= 0; i -= 1) {
    dates.push({
      date: new Date(year, month - 1, prevMonthLastDate - i),
      currentMonth: false,
    });
  }

  for (let i = 1; i <= lastDate; i += 1) {
    dates.push({
      date: new Date(year, month, i),
      currentMonth: true,
    });
  }

  const nextMonthStart = new Date(year, month + 1, 1);
  while (dates.length % 7 !== 0) {
    dates.push({
      date: new Date(nextMonthStart.getFullYear(), nextMonthStart.getMonth(), dates.length - lastDate - startDay + 1),
      currentMonth: false,
    });
  }

  return dates;
}

export function formatKoreanDate(date: Date): string {
  return `${date.getFullYear()}년 ${date.getMonth() + 1}월 ${date.getDate()}일 (${DAYS[date.getDay()]})`;
}

export function formatISODateTime(date: Date, hour: number, minute: number) {
  const h = hour.toString().padStart(2, '0');
  const min = minute.toString().padStart(2, '0');

  return `${getYyyyMmDd(date)}T${h}:${min}:00`;
}

export function isSameDate(date1: Date, date2: Date): boolean {
  return (
    date1.getFullYear() === date2.getFullYear() &&
    date1.getMonth() === date2.getMonth() &&
    date1.getDate() === date2.getDate()
  );
}

export function getYyyyMmDd(date: Date, separator: string = '-'): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}${separator}${month}${separator}${day}`;
}

export function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

interface DateRangeOptions {
  selectedDate: Date;
  minDate?: Date;
  /** 선택 가능한 마지막 날. 호출부가 `useServerCalendarDate()`처럼 안정된 KST 달력 날짜를 넘긴다. */
  maxDate: Date;
}

interface DateRangeResult {
  years: number[];
  months: number[];
  days: number[];
  currentYear: number;
  currentMonth: number;
  currentDay: number;
}

export function getDateRange({ selectedDate, minDate, maxDate }: DateRangeOptions): DateRangeResult {
  const today = maxDate;
  const startDate = minDate ?? new Date(today.getFullYear() - 1, 0, 1);

  const currentYear = selectedDate.getFullYear();
  const currentMonth = selectedDate.getMonth() + 1;
  const currentDay = selectedDate.getDate();

  const years: number[] = [];
  const startYear = startDate.getFullYear();
  const endYear = today.getFullYear();
  for (let y = startYear; y <= endYear; y += 1) {
    years.push(y);
  }

  const months: number[] = [];
  const startMonth = currentYear === startDate.getFullYear() ? startDate.getMonth() + 1 : 1;
  const endMonth = currentYear === today.getFullYear() ? today.getMonth() + 1 : 12;
  for (let m = startMonth; m <= endMonth; m += 1) {
    months.push(m);
  }

  const days: number[] = [];
  const startDay =
    currentYear === startDate.getFullYear() && currentMonth === startDate.getMonth() + 1 ? startDate.getDate() : 1;
  let endDay = getDaysInMonth(currentYear, currentMonth);
  if (currentYear === today.getFullYear() && currentMonth === today.getMonth() + 1) {
    endDay = Math.min(endDay, today.getDate());
  }
  for (let d = startDay; d <= endDay; d += 1) {
    days.push(d);
  }

  return {
    years,
    months,
    days,
    currentYear,
    currentMonth,
    currentDay,
  };
}

export function clampDate(
  year: number,
  month: number,
  day: number,
  maxDate: Date,
): { year: number; month: number; day: number } {
  const newYear = year;
  let newMonth = month;
  let newDay = day;

  const maxMonth = newYear === maxDate.getFullYear() ? maxDate.getMonth() + 1 : 12;
  if (newMonth > maxMonth) newMonth = maxMonth;

  let maxDay = getDaysInMonth(newYear, newMonth);
  if (newYear === maxDate.getFullYear() && newMonth === maxDate.getMonth() + 1) {
    maxDay = Math.min(maxDay, maxDate.getDate());
  }
  if (newDay > maxDay) newDay = maxDay;

  return { year: newYear, month: newMonth, day: newDay };
}
