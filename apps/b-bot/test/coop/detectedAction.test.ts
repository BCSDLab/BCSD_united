import { beforeEach, describe, expect, it, vi } from 'vitest';

// 락은 실제 Postgres에 붙는다. 여기서는 항상 통과시킨다 —
// 잠금 자체는 test/koin/detectLock.test.ts가 실제 DB로 확인한다.
vi.mock('~/services/koin/detectLock', () => ({
  acquireDetectLock: vi.fn(async () => ({ ok: true })),
  releaseDetectLock: vi.fn(async () => undefined),
}));

vi.mock('~/services/coop/detected', () => ({
  collectCoopImages: vi.fn(() => [
    {
      name: '2026-1학기.png',
      url: 'https://portal.koreatech.ac.kr/file?id=1',
      mimeType: 'image/png',
    },
  ]),
  downloadCoopNoticeImage: vi.fn(async () => new ArrayBuffer(4)),
  dropDetectedCoop: vi.fn(async () => undefined),
  fetchCoopArticle: vi.fn(async () => ({
    title: '2026학년도 1학기 생협 운영시간 안내',
    url: 'https://koreatech.in/articles/123',
    attachments: [],
  })),
  guessCoopSemester: vi.fn(() => ({ year: 2026, termName: '1학기' })),
  loadDetectedCoop: vi.fn(async () => null),
  saveDetectedCoop: vi.fn(async () => 'a'.repeat(32)),
}));

vi.mock('~/services/coop/pipeline', () => ({
  extractCoopImage: vi.fn(async () => ({
    title: '2026년 1학기 시설물 운영 시간',
    semesterLabel: '26-1학기',
    fromDate: '2026-03-03',
    toDate: '2026-06-19',
    shops: [],
  })),
  convertRegularRawCoopToReview: vi.fn(async () => ({
    token: 'b'.repeat(32),
    reviewUrl: 'https://bot.example.com/review/token',
    shopCount: 11,
    excludedCount: 3,
    blockingCount: 0,
    infoCount: 0,
  })),
}));
vi.mock('~/services/slack/features/coop/blocks', () => ({
  buildRegularCoopResultBlocks: vi.fn(() => [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '변환 완료' },
    },
  ]),
}));

vi.mock('~/services/coop/vacationStore', () => ({
  savePendingCoopVacation: vi.fn(async () => undefined),
}));

vi.mock('~/services/coop/reviewStore', () => ({
  linkCoopThread: vi.fn(async () => undefined),
}));

vi.mock('~/services/coop/jobStore', () => ({
  createCoopJob: vi.fn(async () => undefined),
}));

vi.mock('~/services/koin/target', () => ({
  resolveTarget: vi.fn(() => ({
    ok: true,
    target: {
      env: 'stage',
      label: '스테이지',
      baseUrl: 'https://api.stage.example.com',
      email: 'admin@example.com',
      password: 'password',
    },
  })),
  labelOf: vi.fn(() => '스테이지'),
}));

import {
  collectCoopImages,
  downloadCoopNoticeImage,
  fetchCoopArticle,
  guessCoopSemester,
  saveDetectedCoop,
} from '~/services/coop/detected';
import { convertRegularRawCoopToReview, extractCoopImage } from '~/services/coop/pipeline';
import { linkCoopThread } from '~/services/coop/reviewStore';
import { createCoopJob } from '~/services/coop/jobStore';
import { handleCoopDetectedAction } from '~/services/slack/features/coop/detectedActions';
import { savePendingCoopVacation } from '~/services/coop/vacationStore';

function slackClient() {
  return {
    chat: {
      postMessage: vi.fn(async () => ({ ts: '100.1' })),
      update: vi.fn(async (_request: unknown) => ({})),
    },
  };
}

describe('생협 공지 감지 Slack 액션', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('예를 누르면 게시글 이미지를 기존 변환 파이프라인에 연결한다', async () => {
    const client = slackClient();
    await handleCoopDetectedAction(
      client as never,
      {
        channel: { id: 'C1' },
        user: { id: 'U1' },
      } as never,
      {
        type: 'button',
        action_id: 'coop:detected',
        value: JSON.stringify({ article_id: 123 }),
      } as never,
    );

    expect(fetchCoopArticle).toHaveBeenCalledWith(123);
    expect(downloadCoopNoticeImage).toHaveBeenCalledWith(expect.objectContaining({ name: '2026-1학기.png' }));
    expect(extractCoopImage).toHaveBeenCalledWith({
      image: expect.any(ArrayBuffer),
      mimeType: 'image/png',
      fileName: '2026-1학기.png',
    });
    expect(convertRegularRawCoopToReview).toHaveBeenCalledWith(expect.objectContaining({ semesterLabel: '26-1학기' }), {
      env: 'stage',
      year: 2026,
      termName: '1학기',
      fileName: '2026-1학기.png',
    });
    expect(linkCoopThread).toHaveBeenCalledWith('C1', '100.1', 'b'.repeat(32));
    expect(createCoopJob).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'b'.repeat(32),
        targetEnv: 'stage',
        shopCount: 11,
      }),
    );
    expect(client.chat.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channel: 'C1',
        ts: '100.1',
        text: expect.stringContaining('변환 완료'),
      }),
    );
  });

  it('공지 제목에 학기가 없어도 선택한 이미지에서 학기를 읽어 변환한다', async () => {
    vi.mocked(guessCoopSemester).mockReturnValueOnce(null);
    const client = slackClient();

    await handleCoopDetectedAction(
      client as never,
      {
        channel: { id: 'C1' },
        user: { id: 'U1' },
      } as never,
      {
        type: 'button',
        action_id: 'coop:detected',
        value: JSON.stringify({ article_id: 123 }),
      } as never,
    );

    expect(extractCoopImage).toHaveBeenCalled();
    expect(convertRegularRawCoopToReview).toHaveBeenCalledWith(
      expect.objectContaining({ semesterLabel: '26-1학기' }),
      expect.objectContaining({ year: 2026, termName: '1학기' }),
    );
    expect(JSON.stringify(client.chat.update.mock.calls.at(-1)?.[0])).not.toContain('제목에서 학기를 읽지 못했습니다');
  });

  it('공지 제목에 학기가 없어도 방학 이미지는 시작일 입력 단계로 진행한다', async () => {
    vi.mocked(guessCoopSemester).mockReturnValueOnce(null);
    vi.mocked(extractCoopImage).mockResolvedValueOnce({
      title: '2026년 하계방학 생협 사업장 운영시간 안내',
      semesterLabel: '2026년 하계방학',
      fromDate: '2026-06-22',
      toDate: '2026-08-30',
      shops: [],
    });
    const client = slackClient();

    await handleCoopDetectedAction(
      client as never,
      {
        channel: { id: 'C1' },
        user: { id: 'U1' },
      } as never,
      {
        type: 'button',
        action_id: 'coop:detected',
        value: JSON.stringify({ article_id: 123 }),
      } as never,
    );

    expect(savePendingCoopVacation).toHaveBeenCalledWith(
      'C1',
      '100.1',
      expect.objectContaining({
        year: 2026,
        season: '하계',
        fileName: '2026-1학기.png',
      }),
    );
    expect(client.chat.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: '방학 시작일 입력 대기',
      }),
    );
    expect(convertRegularRawCoopToReview).not.toHaveBeenCalled();
  });

  it('아니요를 누르면 원본 감지 메시지를 종료 상태로 바꾼다', async () => {
    const client = slackClient();
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    await handleCoopDetectedAction(
      client as never,
      {
        channel: { id: 'C1' },
        user: { id: 'U1' },
        response_url: 'https://hooks.slack.com/actions/1',
      } as never,
      {
        type: 'button',
        action_id: 'coop:detected_ignore',
        value: JSON.stringify({ article_id: 123 }),
      } as never,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://hooks.slack.com/actions/1',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('replace_original'),
      }),
    );
    expect(client.chat.postMessage).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it('이미지가 여럿이면 변환하지 않고 선택 버튼을 보여준다', async () => {
    vi.mocked(collectCoopImages).mockReturnValueOnce([
      { name: '운영시간.png', url: 'https://portal.koreatech.ac.kr/file?id=1', mimeType: 'image/png' },
      { name: '참고.jpg', url: 'https://portal.koreatech.ac.kr/file?id=2', mimeType: 'image/jpeg' },
    ]);
    const client = slackClient();
    await handleCoopDetectedAction(
      client as never,
      {
        channel: { id: 'C1' },
        user: { id: 'U1' },
      } as never,
      {
        type: 'button',
        action_id: 'coop:detected',
        value: JSON.stringify({ article_id: 123 }),
      } as never,
    );

    expect(saveDetectedCoop).toHaveBeenCalledWith(
      expect.objectContaining({
        articleId: 123,
        year: 2026,
        termName: '1학기',
        images: expect.arrayContaining([expect.objectContaining({ name: '운영시간.png' })]),
      }),
    );
    expect(downloadCoopNoticeImage).not.toHaveBeenCalled();
    expect(JSON.stringify(client.chat.update.mock.calls.at(-1)?.[0])).toContain('coop:detected_start_1');
  });
});
