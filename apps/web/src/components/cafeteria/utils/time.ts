import type { DiningType } from 'api/dinings/entity';
import { kstDateKey, kstHour, kstTimeOn } from 'utils/ts/calendar';

export const convertDateToSimpleString = (date: Date) => kstDateKey(date).slice(2).replaceAll('-', '');

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
