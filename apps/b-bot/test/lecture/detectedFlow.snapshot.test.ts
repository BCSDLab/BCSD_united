import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pressBody, slackRecorder } from '../support/slackRecorder';

/** 강의 공지 감지 버튼의 흐름을 경우별로 고정한다. */
const mocks = vi.hoisted(() => ({
  fetchArticle: vi.fn(),
  downloadNoticeFile: vi.fn(),
  saveDetected: vi.fn(),
  loadDetected: vi.fn(),
  dropDetected: vi.fn(),
  acquireDetectLock: vi.fn(),
  releaseDetectLock: vi.fn(),
  resolveTarget: vi.fn(),
  convertToReview: vi.fn(),
  createJob: vi.fn(),
  linkThread: vi.fn(),
}));

vi.mock('~/services/lecture/detected', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/services/lecture/detected')>()),
  fetchArticle: mocks.fetchArticle,
  downloadNoticeFile: mocks.downloadNoticeFile,
  saveDetected: mocks.saveDetected,
  loadDetected: mocks.loadDetected,
  dropDetected: mocks.dropDetected,
}));
vi.mock('~/services/koin/detectLock', () => ({
  acquireDetectLock: mocks.acquireDetectLock,
  releaseDetectLock: mocks.releaseDetectLock,
}));
vi.mock('~/services/koin/target', () => ({
  resolveTarget: mocks.resolveTarget,
  labelOf: (env: string) => (env === 'prod' ? '프로덕션' : '스테이지'),
}));
vi.mock('~/services/lecture/pipeline', () => ({
  convertToReview: mocks.convertToReview,
}));
vi.mock('~/services/slack/features/lecture/blocks', () => ({
  buildResultBlocks: vi.fn((outcome, target, actor) => [
    { type: 'section', text: { type: 'mrkdwn', text: `결과 ${outcome.token} ${target.termName} <@${actor}>` } },
  ]),
}));
vi.mock('~/services/lecture/jobStore', () => ({ createJob: mocks.createJob }));
vi.mock('~/services/lecture/reviewStore', () => ({ linkThread: mocks.linkThread }));

import { lectureDetectedActions } from '~/services/slack/features/lecture/detectedActions';

const file = (name: string, id: number) => ({ name, url: `https://portal.koreatech.ac.kr/f/${id}` });

async function press(actionId: string, value: Record<string, unknown>) {
  const slack = slackRecorder();
  const setting = lectureDetectedActions.find((candidate) => candidate.actionId === actionId)!;
  await setting
    .handler({
      client: slack.client as never,
      body: pressBody() as never,
      action: { type: 'button', action_id: actionId, value: JSON.stringify(value) } as never,
    })
    .catch((error: Error) => slack.record('thrown', error.message));
  return {
    events: slack.events,
    locks: { acquire: mocks.acquireDetectLock.mock.calls, release: mocks.releaseDetectLock.mock.calls },
    saved: mocks.saveDetected.mock.calls,
    jobs: mocks.createJob.mock.calls,
  };
}

describe('강의 공지 감지 흐름', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveTarget.mockReturnValue({ ok: true, target: { env: 'stage', label: '스테이지' } });
    mocks.acquireDetectLock.mockResolvedValue({ ok: true });
    mocks.fetchArticle.mockResolvedValue({
      title: '2026학년도 2학기 개설교과목 안내',
      url: 'https://koreatech.in/articles/7',
      attachments: [{ name: '개설교과목.xlsx(21 KB)', url: 'https://portal.koreatech.ac.kr/f/1' }],
    });
    mocks.downloadNoticeFile.mockResolvedValue(new ArrayBuffer(4));
    mocks.convertToReview.mockResolvedValue({ token: 't'.repeat(32), lectureCount: 812 });
    mocks.saveDetected.mockResolvedValue('s'.repeat(32));
    mocks.loadDetected.mockResolvedValue({
      target: 'stage',
      articleId: 7,
      articleTitle: '공지',
      articleUrl: 'u',
      year: 2026,
      term: '2학기',
      files: [file('개설교과목.xlsx', 1), file('폐강.xlsx', 2)],
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('첨부 하나면 바로 변환한다', async () => {
    expect(await press('lecture:detected', { article_id: 7 })).toMatchSnapshot();
  });

  it('반영 대상 채널이 아니면 원본에 알린다', async () => {
    mocks.resolveTarget.mockReturnValue({ ok: false, reason: '강의 반영 채널이 아닙니다.' });
    expect(await press('lecture:detected', { article_id: 7 })).toMatchSnapshot();
  });

  it('다른 사람이 진행 중이면 누른 사람에게만 알린다', async () => {
    mocks.acquireDetectLock.mockResolvedValue({ ok: false, actor: 'U2' });
    expect(await press('lecture:detected', { article_id: 7 })).toMatchSnapshot();
  });

  it('게시글 조회 실패', async () => {
    mocks.fetchArticle.mockRejectedValue(new Error('게시글 7을 찾지 못했습니다 (HTTP 404).'));
    expect(await press('lecture:detected', { article_id: 7 })).toMatchSnapshot();
  });

  it('엑셀 첨부 없음', async () => {
    mocks.fetchArticle.mockResolvedValue({ title: '2026학년도 2학기 안내', attachments: [] });
    expect(await press('lecture:detected', { article_id: 7 })).toMatchSnapshot();
  });

  it('제목에서 학기를 못 읽으면 멈춘다', async () => {
    mocks.fetchArticle.mockResolvedValue({
      title: '개설교과목 안내',
      attachments: [{ name: '개설교과목.xlsx', url: 'https://portal.koreatech.ac.kr/f/1' }],
    });
    expect(await press('lecture:detected', { article_id: 7 })).toMatchSnapshot();
  });

  it('첨부가 여럿이면 고르게 한다', async () => {
    mocks.fetchArticle.mockResolvedValue({
      title: '2026학년도 2학기 개설교과목 안내',
      attachments: [
        { name: '폐강강좌.xlsx', url: 'https://portal.koreatech.ac.kr/f/2' },
        { name: '개설교과목.xlsx', url: 'https://portal.koreatech.ac.kr/f/1' },
      ],
    });
    expect(await press('lecture:detected', { article_id: 7 })).toMatchSnapshot();
  });

  it('변환 실패해도 락을 푼다', async () => {
    mocks.convertToReview.mockRejectedValue(new Error('시트를 찾지 못했습니다.'));
    expect(await press('lecture:detected', { article_id: 7 })).toMatchSnapshot();
  });

  it('고른 파일로 변환한다', async () => {
    expect(await press('lecture:detected_start_1', { token: 's'.repeat(32), fileIndex: 1 })).toMatchSnapshot();
  });

  it('고르기가 만료됐으면 알린다', async () => {
    mocks.loadDetected.mockResolvedValue(null);
    expect(await press('lecture:detected_start', { token: 's'.repeat(32), fileIndex: 0 })).toMatchSnapshot();
  });

  it('넘어가기(최초 알림)', async () => {
    expect(await press('lecture:detected_ignore', {})).toMatchSnapshot();
  });

  it('넘어가기(고르던 중)', async () => {
    expect(await press('lecture:detected_ignore', { token: 's'.repeat(32) })).toMatchSnapshot();
  });
});
