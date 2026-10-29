import { beforeEach, describe, expect, it, vi } from 'vitest';
import { slackRecorder } from '../support/slackRecorder';

/**
 * `!수정`은 스레드 주인 도메인(강의·생협·버스) 하나만 처리한다.
 * 어느 도메인 스레드인지에 따라 누가 답하는지를 등록표 전체를 통해 고정한다.
 */
const mocks = vi.hoisted(() => ({
  findTokenByThread: vi.fn(),
  loadReview: vi.fn(),
  findCoopTokenByThread: vi.fn(),
  loadCoopReview: vi.fn(),
  findBusTokenByThread: vi.fn(),
  loadBusReview: vi.fn(),
}));

vi.mock('~/services/lecture/reviewStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/services/lecture/reviewStore')>()),
  findTokenByThread: mocks.findTokenByThread,
  loadReview: mocks.loadReview,
}));
vi.mock('~/services/coop/reviewStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/services/coop/reviewStore')>()),
  findCoopTokenByThread: mocks.findCoopTokenByThread,
  loadCoopReview: mocks.loadCoopReview,
}));
vi.mock('~/services/bus/reviewStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/services/bus/reviewStore')>()),
  findBusTokenByThread: mocks.findBusTokenByThread,
  loadBusReview: mocks.loadBusReview,
}));

import { messageFunctionList } from '~/services/slack/registry/messages';

const TOKEN = 't'.repeat(32);

/** 이벤트 라우트처럼 맞는 핸들러를 전부 순서대로 돌린다. */
async function say(text: string, parentTs?: string) {
  const slack = slackRecorder();
  for (const setting of messageFunctionList) {
    const hit = typeof setting.regex === 'string' ? text.includes(setting.regex) : setting.regex.test(text);
    if (!hit) continue;
    await setting.handler({ client: slack.client as never, channel: 'C1', ts: '300.3', text, user: 'U1', parentTs });
  }
  return slack.events;
}

describe('!수정 스레드 주인 판별', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const mock of Object.values(mocks)) mock.mockResolvedValue(null);
  });

  it('스레드 밖에서 쓰면 스레드에서 쓰라고 안내한다', async () => {
    expect(await say('!수정 유체역학 03 교수 우창규로')).toMatchSnapshot();
  });

  it('어느 변환 스레드도 아니면 기록을 찾지 못했다고 안내한다', async () => {
    expect(await say('!수정 유체역학 03 교수 우창규로', '100.1')).toMatchSnapshot();
  });

  it('강의 스레드인데 검토가 만료됐으면 강의가 안내한다', async () => {
    mocks.findTokenByThread.mockResolvedValue(TOKEN);
    expect(await say('!수정 유체역학 03 교수 우창규로', '100.1')).toMatchSnapshot();
  });

  it('생협 스레드면 생협만 답한다', async () => {
    mocks.findCoopTokenByThread.mockResolvedValue(TOKEN);
    expect(await say('!수정 복지관식당 토요일 미운영', '100.1')).toMatchSnapshot();
  });

  it('버스 스레드인데 검토가 만료됐으면 아무도 답하지 않는다', async () => {
    mocks.findBusTokenByThread.mockResolvedValue(TOKEN);
    expect(await say('!수정 천안역 1회 08:05', '100.1')).toMatchSnapshot();
  });

  it('버스 스레드에서 내용 없이 쓰면 버스가 예시를 보여준다', async () => {
    mocks.findBusTokenByThread.mockResolvedValue(TOKEN);
    mocks.loadBusReview.mockResolvedValue({ conversions: [], meta: { env: 'stage' } });
    expect(await say('!수정', '100.1')).toMatchSnapshot();
  });

  it('강의 스레드에서 내용 없이 쓰면 강의가 예시를 보여준다', async () => {
    mocks.findTokenByThread.mockResolvedValue(TOKEN);
    mocks.loadReview.mockResolvedValue({ lectures: [], meta: { env: 'stage', timeFormat: 'period' } });
    expect(await say('!수정', '100.1')).toMatchSnapshot();
  });
});
