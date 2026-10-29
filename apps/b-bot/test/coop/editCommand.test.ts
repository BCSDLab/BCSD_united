import { describe, expect, it } from 'vitest';
import { buildRegularCoopResultBlocks } from '~/services/slack/features/coop/blocks';
import { messages as coopMessages } from '~/services/slack/features/coop/messages';

describe('생협 검수 스레드 수정 안내', () => {
  it('!수정은 분배기 하나만 받고 생협 스레드면 생협에 넘긴다', async () => {
    // 어느 도메인 스레드인지에 따른 실제 분배는 test/slack/editRouting.test.ts가 본다.
    const { messageFunctionList } = await import('~/services/slack/registry/messages');
    const matching = messageFunctionList.filter((message) =>
      typeof message.regex === 'string'
        ? '!수정 복지관식당 토요일을 미운영으로 바꿔줘'.includes(message.regex)
        : message.regex.test('!수정 복지관식당 토요일을 미운영으로 바꿔줘'),
    );
    expect(matching).toHaveLength(1);
    expect(coopMessages.some((message) => String(message.regex) === '/^!수정/')).toBe(false);
  });

  it('변환 완료 메시지에 수정 예시를 보여준다', () => {
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
    const json = JSON.stringify(blocks);
    expect(json).toContain('`!수정`');
    expect(json).toContain('세탁소 평일 운영시간');
  });
});
