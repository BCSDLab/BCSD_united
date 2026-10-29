import { beforeEach, describe, expect, it, vi } from 'vitest';

const conversion = {
  payloads: [
    {
      target: 'commuting' as const,
      semester_type: 'REGULAR' as const,
      body: {
        commuting_bus_timetables: [
          {
            region: '천안',
            route_type: '등교',
            route_name: '천안역',
            node_info: [{ name: '천안역' }, { name: '대학' }],
            route_info: [{ name: '1회', arrival_time: ['08:10', '08:50'] }],
          },
        ],
      },
    },
  ],
  version_update: {
    type: 'shuttle_bus_timetable' as const,
    title: '정규학기' as const,
    content: '2026-03-02~2026-06-19',
  },
  provenance: {},
  warnings: [],
};

const storedReview = {
  html: '<html>original</html>',
  conversions: [conversion],
  meta: {
    env: 'stage' as const,
    sourceFileName: '버스시간표.xlsx',
    routeCount: 1,
    issueRouteCount: 0,
    noDaysRouteCount: 0,
    createdAt: '2026-08-08T00:00:00.000Z',
  },
};

const finishBusJob = vi.fn(async () => undefined);
const claimBusJob = vi.fn(async (): Promise<{ ok: boolean; reason?: string }> => ({ ok: true }));
const cancelBusJob = vi.fn(async () => true);
const setBusVersionSchedules = vi.fn(async () => undefined);
const findBusJob = vi.fn(async (): Promise<{ status: string } | null> => ({ status: 'PENDING' }));
vi.mock('~/services/bus/jobStore', () => ({
  cancelBusJob: (...args: unknown[]) => (cancelBusJob as (...a: unknown[]) => unknown)(...args),
  claimBusJob: (...args: unknown[]) => (claimBusJob as (...a: unknown[]) => unknown)(...args),
  finishBusJob: (...args: unknown[]) => (finishBusJob as (...a: unknown[]) => unknown)(...args),
  setBusVersionSchedules: (...args: unknown[]) => (setBusVersionSchedules as (...a: unknown[]) => unknown)(...args),
  findBusJob: (...args: unknown[]) => (findBusJob as (...a: unknown[]) => unknown)(...args),
}));

const loadBusReview = vi.fn(async () => storedReview);
const updateBusReview = vi.fn(async (_token: string, _review: unknown) => undefined);
const loadBusPatchPlan = vi.fn();
const dropBusPatchPlan = vi.fn(async () => undefined);
vi.mock('~/services/bus/reviewStore', () => ({
  loadBusReview: (...args: unknown[]) => (loadBusReview as (...a: unknown[]) => unknown)(...args),
  updateBusReview: (...args: unknown[]) => (updateBusReview as (...a: unknown[]) => unknown)(...args),
  loadBusPatchPlan: (...args: unknown[]) => (loadBusPatchPlan as (...a: unknown[]) => unknown)(...args),
  dropBusPatchPlan: (...args: unknown[]) => (dropBusPatchPlan as (...a: unknown[]) => unknown)(...args),
}));

vi.mock('~/services/koin/adminAuth', () => ({
  getKoinAdminAuth: vi.fn(async () => ({
    baseUrl: 'https://api.stage.koreatech.in',
    accessToken: 'koin-jwt',
  })),
}));

vi.mock('~/services/koin/target', () => ({
  labelOf: () => '스테이지',
  resolveTargetByEnv: () => ({
    ok: true,
    target: {
      env: 'stage',
      label: '스테이지',
      baseUrl: 'https://api.stage.koreatech.in',
      email: 'admin@example.com',
      password: 'password',
    },
  }),
}));

const submitBusTimetables = vi.fn();
vi.mock('~/services/bus/adminApi', () => ({
  submitBusTimetables: (...args: unknown[]) => (submitBusTimetables as (...a: unknown[]) => unknown)(...args),
}));

function client() {
  const chatUpdate = vi.fn().mockResolvedValue({ ok: true });
  const chatPostMessage = vi.fn().mockResolvedValue({ ok: true });
  const chatPostEphemeral = vi.fn().mockResolvedValue({ ok: true });
  return { chat: { update: chatUpdate, postMessage: chatPostMessage, postEphemeral: chatPostEphemeral } };
}

const body = (overrides = {}) => ({
  channel: { id: 'C1' },
  message: { ts: '111.222' },
  user: { id: 'U1' },
  ...overrides,
});

const button = (value: unknown, actionId: string) => ({
  type: 'button' as const,
  action_id: actionId,
  value: JSON.stringify(value),
});

beforeEach(() => {
  vi.clearAllMocks();
  claimBusJob.mockResolvedValue({ ok: true });
  cancelBusJob.mockResolvedValue(true);
  findBusJob.mockResolvedValue({ status: 'PENDING' });
  loadBusReview.mockResolvedValue(storedReview);
});

describe('bus:apply', () => {
  it('성공하면 반영 완료로 끝난다', async () => {
    submitBusTimetables.mockImplementation(async (_conversions, _auth, onApplied) => {
      onApplied?.({ target: 'commuting', semesterType: 'REGULAR' });
    });
    const { handleBusApplyAction } = await import('~/services/slack/features/bus/actions');
    const mock = client();

    await handleBusApplyAction(mock as never, body() as never, button({ token: 't1' }, 'bus:apply') as never);

    expect(finishBusJob).toHaveBeenCalledWith('t1', 'APPLIED');
    expect(mock.chat.update).toHaveBeenLastCalledWith(expect.objectContaining({ text: '버스 시간표 반영 완료' }));
    // 시간표 PUT과 별개로, 적용 전날 버전 문구 갱신도 예약해야 한다.
    expect(setBusVersionSchedules).toHaveBeenCalledWith('t1', [
      expect.objectContaining({ scheduled_at: '2026-02-28T15:05:00.000Z' }),
    ]);
    // "예약했습니다"라고만 하면 정확히 언제인지 알 수 없다 — KST 시각을 그대로 보여줘야 한다.
    const [[updateCall]] = mock.chat.update.mock.calls.slice(-1);
    expect(JSON.stringify(updateCall.blocks)).toContain('2026-03-01 00:05 KST');
  });

  it('클레임에 실패하면 이유를 개인 메시지로만 보여주고 반영을 시도하지 않는다', async () => {
    claimBusJob.mockResolvedValue({ ok: false, reason: '이미 <@U9>님이 반영했습니다.' });
    const { handleBusApplyAction } = await import('~/services/slack/features/bus/actions');
    const mock = client();

    await handleBusApplyAction(mock as never, body() as never, button({ token: 't1' }, 'bus:apply') as never);

    expect(mock.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'U1', text: '이미 <@U9>님이 반영했습니다.' }),
    );
    expect(submitBusTimetables).not.toHaveBeenCalled();
    expect(mock.chat.update).not.toHaveBeenCalled();
  });

  it('검토 링크가 만료됐으면 반영을 실패로 종결한다', async () => {
    loadBusReview.mockResolvedValue(null);
    const { handleBusApplyAction } = await import('~/services/slack/features/bus/actions');
    const mock = client();

    await handleBusApplyAction(mock as never, body() as never, button({ token: 't1' }, 'bus:apply') as never);

    expect(finishBusJob).toHaveBeenCalledWith('t1', 'FAILED', '검토 링크 만료');
    expect(submitBusTimetables).not.toHaveBeenCalled();
  });

  it('중간 실패는 어디까지 반영됐는지 알려준다', async () => {
    submitBusTimetables.mockImplementation(async (_conversions, _auth, onApplied) => {
      onApplied?.({ target: 'commuting', semesterType: 'REGULAR' });
      throw new Error('shuttle Admin API failed: 500');
    });
    const { handleBusApplyAction } = await import('~/services/slack/features/bus/actions');
    const mock = client();

    await handleBusApplyAction(mock as never, body() as never, button({ token: 't1' }, 'bus:apply') as never);

    expect(finishBusJob).toHaveBeenCalledWith(
      't1',
      'FAILED',
      expect.stringContaining('먼저 반영된 항목: commuting/REGULAR'),
    );
    const [[updateCall]] = mock.chat.update.mock.calls.slice(-1);
    expect(JSON.stringify(updateCall.blocks)).toContain('먼저 반영된 항목: commuting/REGULAR');
  });
});

describe('bus:cancel', () => {
  it('이미 진행 중이면 취소되지 않고 메시지도 갱신하지 않는다', async () => {
    cancelBusJob.mockResolvedValue(false);
    const { handleBusApplyAction } = await import('~/services/slack/features/bus/actions');
    const mock = client();

    await handleBusApplyAction(mock as never, body() as never, button({ token: 't1' }, 'bus:cancel') as never);

    expect(mock.chat.postEphemeral).toHaveBeenCalledWith(
      expect.objectContaining({ text: '이미 반영됐거나 진행 중이라 취소할 수 없습니다.' }),
    );
    expect(mock.chat.update).not.toHaveBeenCalled();
  });
});

describe('bus:patch_apply', () => {
  it('적용 후 검토 페이지 HTML도 함께 갱신한다', async () => {
    loadBusPatchPlan.mockResolvedValue({
      reviewToken: 't1',
      patches: [
        {
          semester: 'REGULAR',
          target: 'commuting',
          region: '천안',
          routeType: '등교',
          routeName: '천안역',
          kind: 'arrival_time',
          tripName: '1회',
          stopName: '천안역',
          before: '08:10',
          after: '09:00',
          rawValue: '09:00',
          value: '09:00',
        },
      ],
      problems: [],
      request: '천안역 1회 천안역 시간을 09:00으로',
      createdAt: '2026-08-08T00:00:00.000Z',
    });
    const { handleBusPatchAction } = await import('~/services/slack/features/bus/actions');
    const mock = client();

    await handleBusPatchAction(
      mock as never,
      body() as never,
      button({ patchToken: 'p1' }, 'bus:patch_apply') as never,
    );

    expect(updateBusReview).toHaveBeenCalledTimes(1);
    const [reviewToken, rebuilt] = updateBusReview.mock.calls[0]!;
    expect(reviewToken).toBe('t1');
    // 적용 전 HTML을 그대로 두면 검토 페이지가 수정 전 값을 보여준다.
    expect((rebuilt as { html: string }).html).not.toBe(storedReview.html);
    expect((rebuilt as { html: string }).html).toContain('09:00');
    // 버튼이 달린 원본 미리보기 메시지를 갱신해 버튼을 없애야 한다. 새 메시지만
    // 추가로 남기면 이미 적용한 뒤에도 버튼이 그대로 남아 다시 누를 수 있어 보인다.
    expect(mock.chat.update).toHaveBeenCalledWith(expect.objectContaining({ text: '버스 시간표 수정 적용' }));
    expect(mock.chat.postMessage).not.toHaveBeenCalled();
  });

  it('이미 반영된 작업이면 검토 페이지를 고치지 않는다', async () => {
    findBusJob.mockResolvedValue({ status: 'APPLIED' });
    loadBusPatchPlan.mockResolvedValue({
      reviewToken: 't1',
      patches: [],
      problems: [],
      request: '아무 요청',
      createdAt: '2026-08-08T00:00:00.000Z',
    });
    const { handleBusPatchAction } = await import('~/services/slack/features/bus/actions');
    const mock = client();

    await handleBusPatchAction(
      mock as never,
      body() as never,
      button({ patchToken: 'p1' }, 'bus:patch_apply') as never,
    );

    expect(updateBusReview).not.toHaveBeenCalled();
    expect(mock.chat.update).toHaveBeenLastCalledWith(expect.objectContaining({ text: '수정 적용 실패' }));
  });
});
