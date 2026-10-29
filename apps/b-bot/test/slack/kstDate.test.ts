import { describe, expect, it } from 'vitest';
import { kstDateKey } from '~/utils/kstDate';

describe('KST 날짜 키', () => {
  it('한국 시간 기준 YYYY-MM-DD로 0을 채운다', () => {
    expect(kstDateKey(new Date('2026-03-09T03:00:00Z'))).toBe('2026-03-09');
  });

  it('UTC로는 전날이어도 한국 날짜를 쓴다', () => {
    expect(kstDateKey(new Date('2026-10-19T16:30:00Z'))).toBe('2026-10-20');
  });
});
