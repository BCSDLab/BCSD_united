import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildReviewUrl,
  createCoopReviewToken,
  isCoopReviewExpired,
  isValidCoopToken,
} from '~/services/coop/reviewStore';

describe('생협 검토 링크', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('강의 저장소와 무관한 128비트 토큰을 만든다', () => {
    const token = createCoopReviewToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(isValidCoopToken(token)).toBe(true);
    expect(isValidCoopToken('../lecture')).toBe(false);
  });

  it('생성 후 7일이 지난 링크를 만료시킨다', () => {
    expect(isCoopReviewExpired('2026-08-01T00:00:00.000Z', new Date('2026-08-07T23:59:59.000Z'))).toBe(false);
    expect(isCoopReviewExpired('2026-08-01T00:00:00.000Z', new Date('2026-08-08T00:00:01.000Z'))).toBe(true);
  });

  it('생협 전용 검토 경로를 만든다', () => {
    vi.stubEnv('APP_BASE_URL', 'https://bot.example.com');
    expect(buildReviewUrl('a'.repeat(32))).toBe(`https://bot.example.com/coop-review/${'a'.repeat(32)}`);
  });
});
