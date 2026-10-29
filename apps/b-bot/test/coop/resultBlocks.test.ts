import { describe, expect, it } from 'vitest';
import { buildRegularCoopResultBlocks, buildVacationCoopResultBlocks } from '~/services/slack/features/coop/blocks';

const outcome = {
  token: 'a'.repeat(32),
  reviewUrl: 'https://bot.example.com/review/token',
  shopCount: 11,
  excludedCount: 3,
  blockingCount: 0,
  infoCount: 3,
};

describe('생협 반영 버튼', () => {
  it('차단 이슈가 없으면 스테이지 반영 버튼을 보여준다', () => {
    const blocks = buildRegularCoopResultBlocks(
      outcome,
      { env: 'stage', year: 2026, termName: '1학기', fileName: '시간표.png' },
      'U1',
    );
    const json = JSON.stringify(blocks);
    expect(json).toContain('스테이지');
    expect(json).toContain('coop:apply');
    expect(json).toContain('coop:cancel');
  });

  it('확인 필요 항목이 있어도 경고와 반영 버튼을 함께 보여준다', () => {
    const blocks = buildRegularCoopResultBlocks(
      { ...outcome, blockingCount: 1 },
      { env: 'stage', year: 2026, termName: '1학기', fileName: '시간표.png' },
      'U1',
    );
    const json = JSON.stringify(blocks);
    expect(json).toContain('확인이 필요한 항목');
    expect(json).toContain('coop:apply');
    expect(json).toContain('coop:cancel');
  });

  it('프로덕션 반영에는 확인 대화상자를 붙인다', () => {
    const blocks = buildRegularCoopResultBlocks(
      outcome,
      { env: 'prod', year: 2026, termName: '1학기', fileName: '시간표.png' },
      'U1',
    );
    const json = JSON.stringify(blocks);
    expect(json).toContain('프로덕션에 반영');
    expect(json).toContain('프로덕션에 반영할까요?');
  });

  it('방학 결과에는 두 학기와 학기 지정 수정법을 안내한다', () => {
    const blocks = buildVacationCoopResultBlocks(
      { ...outcome, semesterCount: 2, blockingCount: 2 },
      { env: 'stage', year: 2026, season: '하계', fileName: '하계방학.png' },
      'U1',
    );
    const json = JSON.stringify(blocks);
    expect(json).toContain('학기 *2개*');
    expect(json).toContain('확인이 필요한 항목');
    expect(json).toContain('!수정 방학');
    expect(json).toContain('coop:apply');
  });
});
