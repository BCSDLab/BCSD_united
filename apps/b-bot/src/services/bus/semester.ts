import type { SemesterType } from './types';

/** "계절학기 중" 같은 표기가 정규학기로 오분류되지 않게 앞의 "계절"을 배제한다. */
const REGULAR_LABEL = /정규학기|(?<!계절)학기\s*중/;

/** Infer the payload semester only from an explicit source label; never guess dates. */
export function semesterFromSource(text: string): SemesterType | undefined {
  if (/계절학기/.test(text)) return 'SEASONAL';
  if (/방학/.test(text)) return 'VACATION';
  if (REGULAR_LABEL.test(text)) return 'REGULAR';
  return undefined;
}
