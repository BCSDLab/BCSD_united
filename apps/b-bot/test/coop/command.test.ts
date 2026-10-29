import { describe, expect, it } from 'vitest';
import { buildRegularCoopResultBlocks } from '~/services/slack/features/coop/blocks';
import { messages as coopMessages, parseVacationBoundary } from '~/services/slack/features/coop/messages';

describe('생협 후속 명령', () => {
  it('방학 시작일 명령은 ISO 날짜만 읽는다', () => {
    expect(parseVacationBoundary('!학기구분 2026-07-18')).toBe('2026-07-18');
    expect(parseVacationBoundary('!학기구분 7월 18일')).toBeNull();
  });

  it('생협 직접 반영 명령을 등록하지 않는다', () => {
    const matching = (text: string) =>
      coopMessages.filter((handler) =>
        typeof handler.regex === 'string' ? text.includes(handler.regex) : handler.regex.test(text),
      );

    expect(matching('!생협반영 2026 1학기')).toHaveLength(0);
  });
});

describe('생협 변환 완료 메시지', () => {
  it('검토 링크와 변환 건수를 보여준다', () => {
    const blocks = buildRegularCoopResultBlocks(
      {
        token: 'a'.repeat(32),
        reviewUrl: 'https://bot.example.com/review/token',
        shopCount: 11,
        excludedCount: 3,
        blockingCount: 0,
        infoCount: 3,
      },
      { env: 'stage', year: 2026, termName: '1학기', fileName: '시간표.png' },
      'U1',
    );

    expect(JSON.stringify(blocks)).toContain('반영 대상 *11개*');
    expect(JSON.stringify(blocks)).not.toContain('2캠 제외');
    expect(JSON.stringify(blocks)).toContain('https://bot.example.com/review/token');
    expect(JSON.stringify(blocks)).toContain('coop:apply');
  });
});
