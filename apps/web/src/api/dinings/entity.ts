import type { APIResponse } from 'interfaces/APIResponse';

export type DiningType = 'BREAKFAST' | 'LUNCH' | 'DINNER';

export type DiningTypes = DiningType[];

export type DiningPlace = 'A코너' | 'B코너' | 'C코너' | '능수관' | '2캠퍼스';

export interface OriginalDining {
  id: number;
  date: string;
  type: DiningType;
  place: DiningPlace;
  /** 화면 언어로 번역한 식당 이름. 정렬·비교는 `place`를 쓴다. */
  display_place?: string;
  price_card: number | null;
  price_cash: number | null;
  kcal: number;
  menu: string[];
  image_url: string | null;
  created_at: string;
  updated_at: string;
  soldout_at: string | null;
  changed_at: string | null;
}

export interface MenuItem {
  id: number;
  name: string;
}

export type Dining = Omit<OriginalDining, 'menu'> & {
  menu: MenuItem[];
};

export interface DiningsResponseType extends APIResponse, Record<number, OriginalDining> {}
