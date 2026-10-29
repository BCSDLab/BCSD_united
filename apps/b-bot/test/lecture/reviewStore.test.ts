import { describe, expect, it } from 'vitest';
import { buildReviewUrl, createReviewToken, isExpired, isValidToken } from '~/services/lecture/reviewStore';

describe('검토 링크 토큰', () => {
  it('추측할 수 없을 만큼 길다', () => {
    const token = createReviewToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  it('매번 다른 값이 나온다', () => {
    const tokens = new Set(Array.from({ length: 100 }, createReviewToken));
    expect(tokens.size).toBe(100);
  });

  it('형식이 아닌 값은 스토리지를 조회하기 전에 막는다', () => {
    expect(isValidToken(createReviewToken())).toBe(true);
    // 경로 조작·대문자·길이 불일치는 전부 거절한다.
    expect(isValidToken('../../etc/passwd')).toBe(false);
    expect(isValidToken('lecture-review:abc')).toBe(false);
    expect(isValidToken('A'.repeat(32))).toBe(false);
    expect(isValidToken('a'.repeat(31))).toBe(false);
    expect(isValidToken('')).toBe(false);
  });
});

describe('검토 링크 만료', () => {
  const now = new Date('2026-08-07T00:00:00Z');
  const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

  it('7일 안쪽은 유효하다', () => {
    expect(isExpired(daysAgo(0), now)).toBe(false);
    expect(isExpired(daysAgo(6), now)).toBe(false);
  });

  it('7일이 지나면 만료된다', () => {
    expect(isExpired(daysAgo(8), now)).toBe(true);
  });

  it('날짜가 깨져 있으면 만료로 본다', () => {
    // 열어주는 쪽으로 실수하지 않는다.
    expect(isExpired('올해쯤', now)).toBe(true);
  });
});

describe('검토 링크 주소', () => {
  it('APP_BASE_URL이 없으면 링크를 만들지 않는다', () => {
    // 슬랙 버튼은 절대 주소만 받는다. 상대 경로를 넘기면 변환을 다 마친 뒤
    // 메시지를 올리는 단계에서 실패해 원인이 보이지 않는다.
    expect(() => buildReviewUrl(createReviewToken())).toThrow(/APP_BASE_URL/);
  });
});
