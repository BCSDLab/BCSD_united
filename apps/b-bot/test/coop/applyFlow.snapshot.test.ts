import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 생협 반영 버튼이 Slack에 보내는 메시지와 작업 상태 기록을 경우별로 고정한다. */
const mocks = vi.hoisted(() => ({
  claimCoopJob: vi.fn(),
  finishCoopJob: vi.fn(),
  cancelCoopJob: vi.fn(),
  loadCoopReview: vi.fn(),
  applyCoopTimetable: vi.fn(),
  applyCoopTimetables: vi.fn(),
}));

vi.mock('~/services/coop/adminApi', () => ({
  applyCoopTimetable: mocks.applyCoopTimetable,
  applyCoopTimetables: mocks.applyCoopTimetables,
}));
vi.mock('~/services/coop/jobStore', () => ({
  claimCoopJob: mocks.claimCoopJob,
  finishCoopJob: mocks.finishCoopJob,
  cancelCoopJob: mocks.cancelCoopJob,
}));
vi.mock('~/services/coop/reviewStore', () => ({ loadCoopReview: mocks.loadCoopReview }));
vi.mock('~/services/koin/adminAuth', () => ({
  getKoinAdminAuth: vi.fn(async () => ({ baseUrl: 'https://api.stage.example.com', accessToken: 'token' })),
}));
vi.mock('~/services/koin/target', () => ({
  labelOf: vi.fn(() => '스테이지'),
  resolveTargetByEnv: vi.fn(() => ({ target: { env: 'stage' } })),
}));

import { handleCoopApplyAction } from '~/services/slack/features/coop/applyActions';

const TOKEN = 'c'.repeat(32);
const conversion = (semester: string, fromDate: string, toDate: string) => ({
  semester,
  fromDate,
  toDate,
  request: { coop_shops: [] },
  shops: [],
  excludedShops: [],
  issues: [],
});
const meta = { env: 'stage', year: 2026, termName: '1학기', sourceFileName: '생협.png', shopCount: 11 };

async function press(actionId: 'coop:apply' | 'coop:cancel') {
  const client = {
    chat: { update: vi.fn(async (_args: unknown) => ({})), postEphemeral: vi.fn(async (_args: unknown) => ({})) },
  };
  await handleCoopApplyAction(
    client as never,
    { channel: { id: 'C1' }, user: { id: 'U1' }, message: { ts: '100.1' } } as never,
    { type: 'button', action_id: actionId, value: JSON.stringify({ token: TOKEN }) } as never,
  );
  return {
    updates: client.chat.update.mock.calls.map(([args]) => args),
    ephemerals: client.chat.postEphemeral.mock.calls.map(([args]) => args),
    finishes: mocks.finishCoopJob.mock.calls,
  };
}

describe('생협 반영 흐름', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.claimCoopJob.mockResolvedValue({ ok: true });
    mocks.cancelCoopJob.mockResolvedValue(true);
    mocks.loadCoopReview.mockResolvedValue({
      request: { coop_shops: [] },
      conversion: conversion('26-1학기', '2026-03-03', '2026-06-19'),
      meta,
    });
    mocks.applyCoopTimetable.mockResolvedValue(17);
  });

  it('반영 성공', async () => {
    expect(await press('coop:apply')).toMatchSnapshot();
  });

  it('선점 실패', async () => {
    mocks.claimCoopJob.mockResolvedValue({ ok: false, reason: 'U2님이 반영 중입니다.' });
    expect(await press('coop:apply')).toMatchSnapshot();
  });

  it('검토 링크 만료', async () => {
    mocks.loadCoopReview.mockResolvedValue(null);
    expect(await press('coop:apply')).toMatchSnapshot();
  });

  it('학기 정보가 비어 있으면 반영하지 않는다', async () => {
    mocks.loadCoopReview.mockResolvedValue({
      request: { coop_shops: [] },
      conversion: conversion('', '2026-03-03', '2026-06-19'),
      meta,
    });
    expect(await press('coop:apply')).toMatchSnapshot();
    expect(mocks.applyCoopTimetable).not.toHaveBeenCalled();
  });

  it('방학 두 학기 중 하나만 반영하고 실패', async () => {
    const seasonal = conversion('26-하계계절학기', '2026-06-22', '2026-07-17');
    mocks.loadCoopReview.mockResolvedValue({
      request: seasonal.request,
      conversion: seasonal,
      periods: [
        { kind: '계절학기', request: seasonal.request, conversion: seasonal },
        {
          kind: '방학',
          request: { coop_shops: [] },
          conversion: conversion('26-하계방학', '2026-07-18', '2026-08-30'),
        },
      ],
      meta: { ...meta, termName: '하계계절학기·하계방학' },
    });
    mocks.applyCoopTimetables.mockImplementation(async (_inputs, _auth, onApplied) => {
      onApplied(21, 0);
      throw new Error('Admin API 500');
    });
    expect(await press('coop:apply')).toMatchSnapshot();
  });

  it('취소', async () => {
    expect(await press('coop:cancel')).toMatchSnapshot();
  });
});
