import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pressBody, slackRecorder } from '../support/slackRecorder';

/** 생협 공지 감지 버튼의 흐름을 경우별로 고정한다. */
const mocks = vi.hoisted(() => ({
  fetchCoopArticle: vi.fn(),
  downloadCoopNoticeImage: vi.fn(),
  saveDetectedCoop: vi.fn(),
  loadDetectedCoop: vi.fn(),
  dropDetectedCoop: vi.fn(),
  acquireDetectLock: vi.fn(),
  releaseDetectLock: vi.fn(),
  resolveTarget: vi.fn(),
  extractCoopImage: vi.fn(),
  convertRegularRawCoopToReview: vi.fn(),
  createCoopJob: vi.fn(),
  linkCoopThread: vi.fn(),
  savePendingCoopVacation: vi.fn(),
  resolveExtractedCoopSemester: vi.fn(),
}));

vi.mock('~/services/coop/detected', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/services/coop/detected')>()),
  fetchCoopArticle: mocks.fetchCoopArticle,
  downloadCoopNoticeImage: mocks.downloadCoopNoticeImage,
  saveDetectedCoop: mocks.saveDetectedCoop,
  loadDetectedCoop: mocks.loadDetectedCoop,
  dropDetectedCoop: mocks.dropDetectedCoop,
}));
vi.mock('~/services/koin/detectLock', () => ({
  acquireDetectLock: mocks.acquireDetectLock,
  releaseDetectLock: mocks.releaseDetectLock,
}));
vi.mock('~/services/koin/target', () => ({
  resolveTarget: mocks.resolveTarget,
  labelOf: (env: string) => (env === 'prod' ? '프로덕션' : '스테이지'),
}));
vi.mock('~/services/coop/pipeline', () => ({
  extractCoopImage: mocks.extractCoopImage,
  convertRegularRawCoopToReview: mocks.convertRegularRawCoopToReview,
}));
vi.mock('~/services/slack/features/coop/blocks', () => ({
  buildRegularCoopResultBlocks: vi.fn((outcome, target, actor) => [
    { type: 'section', text: { type: 'mrkdwn', text: `결과 ${outcome.token} ${target.termName} <@${actor}>` } },
  ]),
}));
vi.mock('~/services/coop/jobStore', () => ({ createCoopJob: mocks.createCoopJob }));
vi.mock('~/services/coop/reviewStore', () => ({ linkCoopThread: mocks.linkCoopThread }));
vi.mock('~/services/coop/vacationStore', () => ({ savePendingCoopVacation: mocks.savePendingCoopVacation }));
vi.mock('~/services/coop/vision', () => ({ resolveExtractedCoopSemester: mocks.resolveExtractedCoopSemester }));

import { handleCoopDetectedAction } from '~/services/slack/features/coop/detectedActions';

const image = (name: string, id: number) => ({
  name,
  url: `https://portal.koreatech.ac.kr/f/${id}`,
  mimeType: 'image/png',
});
const REGULAR = { kind: 'regular', year: 2026, termName: '1학기', normalizedLabel: '26-1학기' };

async function press(actionId: string, value: Record<string, unknown>) {
  const slack = slackRecorder();
  await handleCoopDetectedAction(
    slack.client as never,
    pressBody() as never,
    { type: 'button', action_id: actionId, value: JSON.stringify(value) } as never,
  ).catch((error: Error) => slack.record('thrown', error.message));
  return {
    events: slack.events,
    locks: { acquire: mocks.acquireDetectLock.mock.calls, release: mocks.releaseDetectLock.mock.calls },
    saved: mocks.saveDetectedCoop.mock.calls,
    jobs: mocks.createCoopJob.mock.calls,
    vacations: mocks.savePendingCoopVacation.mock.calls,
  };
}

describe('생협 공지 감지 흐름', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveTarget.mockReturnValue({ ok: true, target: { env: 'stage', label: '스테이지' } });
    mocks.acquireDetectLock.mockResolvedValue({ ok: true });
    mocks.fetchCoopArticle.mockResolvedValue({
      title: '2026학년도 1학기 생협 운영시간 안내',
      url: 'https://koreatech.in/articles/5',
      attachments: [{ name: '운영시간.png(120 KB)', url: 'https://portal.koreatech.ac.kr/f/1' }],
    });
    mocks.downloadCoopNoticeImage.mockResolvedValue(new ArrayBuffer(4));
    mocks.extractCoopImage.mockResolvedValue({
      semesterLabel: '2026학년도 1학기',
      title: '운영시간',
      fromDate: '2026-03-02',
      toDate: '2026-06-19',
    });
    mocks.resolveExtractedCoopSemester.mockReturnValue(REGULAR);
    mocks.convertRegularRawCoopToReview.mockResolvedValue({ token: 't'.repeat(32), shopCount: 11 });
    mocks.saveDetectedCoop.mockResolvedValue('s'.repeat(32));
    mocks.loadDetectedCoop.mockResolvedValue({
      env: 'stage',
      articleId: 5,
      articleTitle: '공지',
      articleUrl: 'u',
      year: 2026,
      termName: '1학기',
      images: [image('운영시간.png', 1), image('시설물.png', 2)],
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('첨부 하나면 바로 변환한다', async () => {
    expect(await press('coop:detected', { article_id: 5 })).toMatchSnapshot();
  });

  it('반영 대상 채널이 아니면 원본에 알린다', async () => {
    mocks.resolveTarget.mockReturnValue({ ok: false, reason: '생협 반영 채널이 아닙니다.' });
    expect(await press('coop:detected', { article_id: 5 })).toMatchSnapshot();
  });

  it('다른 사람이 진행 중이면 누른 사람에게만 알린다', async () => {
    mocks.acquireDetectLock.mockResolvedValue({ ok: false });
    expect(await press('coop:detected', { article_id: 5 })).toMatchSnapshot();
  });

  it('게시글 조회 실패', async () => {
    mocks.fetchCoopArticle.mockRejectedValue(new Error('게시글 5을 찾지 못했습니다 (HTTP 404).'));
    expect(await press('coop:detected', { article_id: 5 })).toMatchSnapshot();
  });

  it('이미지 첨부 없음', async () => {
    mocks.fetchCoopArticle.mockResolvedValue({ title: '생협 안내', attachments: [] });
    expect(await press('coop:detected', { article_id: 5 })).toMatchSnapshot();
  });

  it('첨부가 여럿이면 고르게 한다', async () => {
    mocks.fetchCoopArticle.mockResolvedValue({
      title: '2026학년도 1학기 생협 운영시간 안내',
      attachments: [
        { name: '시설물.png', url: 'https://portal.koreatech.ac.kr/f/2' },
        { name: '운영시간.png', url: 'https://portal.koreatech.ac.kr/f/1' },
      ],
    });
    expect(await press('coop:detected', { article_id: 5 })).toMatchSnapshot();
  });

  it('제목과 이미지의 학기가 다르면 멈춘다', async () => {
    mocks.resolveExtractedCoopSemester.mockReturnValue({ ...REGULAR, termName: '2학기' });
    expect(await press('coop:detected', { article_id: 5 })).toMatchSnapshot();
  });

  it('방학 이미지면 시작일 입력을 기다린다', async () => {
    mocks.fetchCoopArticle.mockResolvedValue({
      title: '생협 운영시간',
      attachments: [{ name: '운영시간.png', url: 'https://portal.koreatech.ac.kr/f/1' }],
    });
    mocks.resolveExtractedCoopSemester.mockReturnValue({
      kind: 'vacation',
      year: 2026,
      season: '하계',
      termName: '하계방학',
    });
    expect(await press('coop:detected', { article_id: 5 })).toMatchSnapshot();
  });

  it('고른 이미지로 변환한다', async () => {
    expect(await press('coop:detected_start_1', { token: 's'.repeat(32), fileIndex: 1 })).toMatchSnapshot();
  });

  it('고르기가 만료됐으면 알린다', async () => {
    mocks.loadDetectedCoop.mockResolvedValue(null);
    expect(await press('coop:detected_start', { token: 's'.repeat(32), fileIndex: 0 })).toMatchSnapshot();
  });

  it('넘어가기(고르던 중)', async () => {
    expect(await press('coop:detected_ignore', { token: 's'.repeat(32) })).toMatchSnapshot();
  });
});
