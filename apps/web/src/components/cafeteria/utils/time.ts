import type { DiningType } from 'api/dinings/entity';
import { kstDateKey } from 'utils/ts/calendar';

export const convertDateToSimpleString = (date: Date) => kstDateKey(date).slice(2).replaceAll('-', '');

const KST_OFFSET_MINUTES = 9 * 60;

// getHours/setHours는 실행 환경 타임존을 따라 서버·클라이언트가 다른 값을 낸다.
// 고정 +9시간 오프셋으로 직접 계산하면 실행 환경과 무관하게 항상 KST 기준이 된다(한국은 DST 없음).
export function kstTimeOn(base: Date, hours: number, minutes: number): Date {
  const kstNow = new Date(base.getTime() + KST_OFFSET_MINUTES * 60 * 1000);
  const y = kstNow.getUTCFullYear();
  const m = kstNow.getUTCMonth();
  const d = kstNow.getUTCDate();

  return new Date(Date.UTC(y, m, d, hours, minutes) - KST_OFFSET_MINUTES * 60 * 1000);
}

function kstHour(date: Date): number {
  const kst = new Date(date.getTime() + KST_OFFSET_MINUTES * 60 * 1000);

  return kst.getUTCHours();
}

/** KST 기준 요일(0=일 ~ 6=토). 실행 환경 타임존과 무관하다. */
export function kstDayOfWeek(date: Date): number {
  const kst = new Date(date.getTime() + KST_OFFSET_MINUTES * 60 * 1000);

  return kst.getUTCDay();
}

export class DiningTime {
  private now: Date;

  private lunchTransitionTime: Date;

  private dinnerTransitionTime: Date;

  private breakfastTransitionTime: Date;

  constructor(now: Date = new Date()) {
    this.now = now;
    this.lunchTransitionTime = kstTimeOn(now, 9, 0);
    this.dinnerTransitionTime = kstTimeOn(now, 13, 30);
    this.breakfastTransitionTime = kstTimeOn(now, 18, 30);
  }

  private isBreakfastTime() {
    return this.now >= this.breakfastTransitionTime || this.now < this.lunchTransitionTime;
  }

  private isLunchTime() {
    return this.now >= this.lunchTransitionTime && this.now < this.dinnerTransitionTime;
  }

  public getType(): DiningType {
    if (this.isBreakfastTime()) return 'BREAKFAST';
    if (this.isLunchTime()) return 'LUNCH';

    return 'DINNER';
  }

  public isTodayDining() {
    return !(this.isBreakfastTime() && kstHour(this.now) >= 18);
  }

  public isTomorrowDining() {
    return kstHour(this.now) >= 19;
  }

  public generateDiningDate() {
    return new Date(this.now.getTime() + (this.isTodayDining() ? 0 : 24 * 60 * 60 * 1000));
  }
}
