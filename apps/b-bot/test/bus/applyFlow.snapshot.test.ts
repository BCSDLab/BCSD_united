import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 버스 반영 버튼이 Slack에 보내는 메시지와 작업 상태 기록을 경우별로 고정한다. */
const mocks = vi.hoisted(() => ({
  claimBusJob: vi.fn(),
  finishBusJob: vi.fn(),
  cancelBusJob: vi.fn(),
  setBusVersionSchedules: vi.fn(),
  loadBusReview: vi.fn(),
  submitBusTimetables: vi.fn(),
}));

vi.mock('~/services/bus/adminApi', () => ({ submitBusTimetables: mocks.submitBusTimetables }));
vi.mock('~/services/bus/jobStore', () => ({
  claimBusJob: mocks.claimBusJob,
  finishBusJob: mocks.finishBusJob,
  cancelBusJob: mocks.cancelBusJob,
  setBusVersionSchedules: mocks.setBusVersionSchedules,
  findBusJob: vi.fn(),
}));
vi.mock('~/services/bus/reviewStore', () => ({
  loadBusReview: mocks.loadBusReview,
  dropBusPatchPlan: vi.fn(),
  loadBusPatchPlan: vi.fn(),
  updateBusReview: vi.fn(),
}));
vi.mock('~/services/bus/versionSchedule', () => ({
  computeBusVersionSchedules: vi.fn(() => [{ runAt: '2026-03-01T15:05:00.000Z' }]),
  describeBusVersionSchedules: vi.fn(() => '• 3/2 00:05 정규학기'),
}));
vi.mock('~/services/koin/adminAuth', () => ({
  getKoinAdminAuth: vi.fn(async () => ({ baseUrl: 'https://api.stage.example.com', accessToken: 'token' })),
}));
vi.mock('~/services/koin/target', () => ({
  labelOf: vi.fn(() => '스테이지'),
  resolveTargetByEnv: vi.fn(() => ({ target: { env: 'stage' } })),
}));

import { handleBusApplyAction } from '~/services/slack/features/bus/actions';

const TOKEN = 'b'.repeat(32);

async function press(actionId: 'bus:apply' | 'bus:cancel') {
  const client = {
    chat: { update: vi.fn(async (_args: unknown) => ({})), postEphemeral: vi.fn(async (_args: unknown) => ({})) },
  };
  await handleBusApplyAction(
    client as never,
    { channel: { id: 'C1' }, user: { id: 'U1' }, message: { ts: '100.1' } } as never,
    { type: 'button', action_id: actionId, value: JSON.stringify({ token: TOKEN }) } as never,
  );
  return {
    updates: client.chat.update.mock.calls.map(([args]) => args),
    ephemerals: client.chat.postEphemeral.mock.calls.map(([args]) => args),
    finishes: mocks.finishBusJob.mock.calls,
    schedules: mocks.setBusVersionSchedules.mock.calls,
  };
}

describe('버스 반영 흐름', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimBusJob.mockResolvedValue({ ok: true });
    mocks.cancelBusJob.mockResolvedValue(true);
    mocks.loadBusReview.mockResolvedValue({
      conversions: [],
      meta: { env: 'stage', routeCount: 12, sourceFileName: '버스.xlsx' },
    });
    mocks.submitBusTimetables.mockResolvedValue(undefined);
  });

  it('반영 성공', async () => {
    expect(await press('bus:apply')).toMatchSnapshot();
  });

  it('선점 실패', async () => {
    mocks.claimBusJob.mockResolvedValue({ ok: false });
    expect(await press('bus:apply')).toMatchSnapshot();
  });

  it('검토 링크 만료', async () => {
    mocks.loadBusReview.mockResolvedValue(null);
    expect(await press('bus:apply')).toMatchSnapshot();
  });

  it('일부 반영 후 실패', async () => {
    mocks.submitBusTimetables.mockImplementation(async (_conversions, _auth, onApplied) => {
      onApplied({ target: 'commuting', semesterType: 'REGULAR' });
      throw new Error('Admin API 500');
    });
    expect(await press('bus:apply')).toMatchSnapshot();
  });

  it('취소', async () => {
    expect(await press('bus:cancel')).toMatchSnapshot();
  });

  it('취소 불가', async () => {
    mocks.cancelBusJob.mockResolvedValue(false);
    expect(await press('bus:cancel')).toMatchSnapshot();
  });
});
