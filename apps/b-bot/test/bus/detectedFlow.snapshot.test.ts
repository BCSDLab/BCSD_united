import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pressBody, slackRecorder } from '../support/slackRecorder';

/** 버스 공지 감지 버튼의 흐름을 경우별로 고정한다. */
const mocks = vi.hoisted(() => ({
  fetchBusArticle: vi.fn(),
  downloadBusNoticeFile: vi.fn(),
  saveBusDetected: vi.fn(),
  loadBusDetected: vi.fn(),
  dropBusDetected: vi.fn(),
  acquireDetectLock: vi.fn(),
  releaseDetectLock: vi.fn(),
  resolveTarget: vi.fn(),
  convertBusToReview: vi.fn(),
  createBusJob: vi.fn(),
  linkBusThread: vi.fn(),
}));

vi.mock('~/services/bus/detected', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/services/bus/detected')>()),
  fetchBusArticle: mocks.fetchBusArticle,
  downloadBusNoticeFile: mocks.downloadBusNoticeFile,
  saveBusDetected: mocks.saveBusDetected,
  loadBusDetected: mocks.loadBusDetected,
  dropBusDetected: mocks.dropBusDetected,
}));
vi.mock('~/services/koin/detectLock', () => ({
  acquireDetectLock: mocks.acquireDetectLock,
  releaseDetectLock: mocks.releaseDetectLock,
}));
vi.mock('~/services/koin/target', () => ({
  resolveTarget: mocks.resolveTarget,
  labelOf: (env: string) => (env === 'prod' ? '프로덕션' : '스테이지'),
}));
vi.mock('~/services/bus/pipeline', () => ({
  convertBusToReview: mocks.convertBusToReview,
}));
vi.mock('~/services/slack/features/bus/blocks', () => ({
  buildReviewApprovalBlocks: vi.fn((outcome, target, actor) => [
    { type: 'section', text: { type: 'mrkdwn', text: `결과 ${outcome.token} ${target.fileName} <@${actor}>` } },
  ]),
}));
vi.mock('~/services/bus/jobStore', () => ({ createBusJob: mocks.createBusJob }));
vi.mock('~/services/bus/reviewStore', () => ({ linkBusThread: mocks.linkBusThread }));

import { handleBusDetectedAction } from '~/services/slack/features/bus/detectedActions';

const file = (name: string, id: number) => ({ name, url: `https://portal.koreatech.ac.kr/f/${id}` });

async function press(actionId: string, value: Record<string, unknown>) {
  const slack = slackRecorder();
  await handleBusDetectedAction(
    slack.client as never,
    pressBody() as never,
    { type: 'button', action_id: actionId, value: JSON.stringify(value) } as never,
  ).catch((error: Error) => slack.record('thrown', error.message));
  return {
    events: slack.events,
    locks: { acquire: mocks.acquireDetectLock.mock.calls, release: mocks.releaseDetectLock.mock.calls },
    saved: mocks.saveBusDetected.mock.calls,
    jobs: mocks.createBusJob.mock.calls,
  };
}

describe('버스 공지 감지 흐름', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveTarget.mockReturnValue({ ok: true, target: { env: 'stage', label: '스테이지' } });
    mocks.acquireDetectLock.mockResolvedValue({ ok: true });
    mocks.fetchBusArticle.mockResolvedValue({
      title: '2026학년도 2학기 통학버스 시간표',
      url: 'https://koreatech.in/articles/9',
      attachments: [{ name: '통학버스.xlsx(30 KB)', url: 'https://portal.koreatech.ac.kr/f/1' }],
    });
    mocks.downloadBusNoticeFile.mockResolvedValue(Buffer.from('PK'));
    mocks.convertBusToReview.mockResolvedValue({ token: 't'.repeat(32), routeCount: 12, semesterTypes: ['REGULAR'] });
    mocks.saveBusDetected.mockResolvedValue('s'.repeat(32));
    mocks.loadBusDetected.mockResolvedValue({
      target: 'stage',
      articleId: 9,
      articleTitle: '공지',
      articleUrl: 'u',
      files: [file('정규.xlsx', 1), file('계절.xlsx', 2)],
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('첨부 하나면 바로 변환한다', async () => {
    expect(await press('bus:detected', { article_id: 9 })).toMatchSnapshot();
  });

  it('반영 대상 채널이 아니면 원본에 알린다', async () => {
    mocks.resolveTarget.mockReturnValue({ ok: false, reason: '버스 반영 채널이 아닙니다.' });
    expect(await press('bus:detected', { article_id: 9 })).toMatchSnapshot();
  });

  it('다른 사람이 진행 중이면 누른 사람에게만 알린다', async () => {
    mocks.acquireDetectLock.mockResolvedValue({ ok: false, actor: 'U2' });
    expect(await press('bus:detected', { article_id: 9 })).toMatchSnapshot();
  });

  it('게시글 조회 실패', async () => {
    mocks.fetchBusArticle.mockRejectedValue(new Error('게시글 9을 찾지 못했습니다 (HTTP 404).'));
    expect(await press('bus:detected', { article_id: 9 })).toMatchSnapshot();
  });

  it('시간표 첨부 없음', async () => {
    mocks.fetchBusArticle.mockResolvedValue({ title: '버스 안내', attachments: [] });
    expect(await press('bus:detected', { article_id: 9 })).toMatchSnapshot();
  });

  it('첨부가 여럿이면 고르게 한다', async () => {
    mocks.fetchBusArticle.mockResolvedValue({
      title: '버스 시간표',
      attachments: [
        { name: '정규.xlsx', url: 'https://portal.koreatech.ac.kr/f/1' },
        { name: '계절.xls', url: 'https://portal.koreatech.ac.kr/f/2' },
      ],
    });
    expect(await press('bus:detected', { article_id: 9 })).toMatchSnapshot();
  });

  it('변환 실패해도 락을 푼다', async () => {
    mocks.convertBusToReview.mockRejectedValue(new Error('시트를 찾지 못했습니다.'));
    expect(await press('bus:detected', { article_id: 9 })).toMatchSnapshot();
  });

  it('고른 파일로 변환한다', async () => {
    expect(await press('bus:detected_start_1', { token: 's'.repeat(32), fileIndex: 1 })).toMatchSnapshot();
  });

  it('고르기가 만료됐으면 알린다', async () => {
    mocks.loadBusDetected.mockResolvedValue(null);
    expect(await press('bus:detected_start', { token: 's'.repeat(32), fileIndex: 0 })).toMatchSnapshot();
  });

  it('넘어가기(최초 알림)', async () => {
    expect(await press('bus:detected_ignore', {})).toMatchSnapshot();
  });

  it('넘어가기(고르던 중)', async () => {
    expect(await press('bus:detected_ignore', { token: 's'.repeat(32) })).toMatchSnapshot();
  });
});
