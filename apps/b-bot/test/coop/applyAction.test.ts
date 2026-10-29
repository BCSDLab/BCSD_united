import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/services/coop/adminApi', () => ({
  applyCoopTimetable: vi.fn(async () => 17),
  applyCoopTimetables: vi.fn(async (_inputs, _auth, onApplied) => {
    onApplied?.(21, 0);
    onApplied?.(22, 1);
    return [21, 22];
  }),
}));

vi.mock('~/services/coop/jobStore', () => ({
  cancelCoopJob: vi.fn(async () => true),
  claimCoopJob: vi.fn(async () => ({ ok: true })),
  finishCoopJob: vi.fn(async () => undefined),
}));

vi.mock('~/services/coop/reviewStore', () => ({
  loadCoopReview: vi.fn(async () => ({
    html: '<html></html>',
    request: { coop_shops: [] },
    conversion: {
      semester: '26-1학기',
      fromDate: '2026-03-03',
      toDate: '2026-06-19',
      request: { coop_shops: [] },
      shops: [],
      excludedShops: [],
      issues: [],
    },
    meta: {
      env: 'stage',
      year: 2026,
      termName: '1학기',
      sourceFileName: '시설물-운영시간.png',
      shopCount: 11,
      blockingCount: 0,
      createdAt: '2026-08-08T00:00:00.000Z',
    },
  })),
}));

vi.mock('~/services/koin/adminAuth', () => ({
  getKoinAdminAuth: vi.fn(async () => ({
    baseUrl: 'https://api.stage.example.com',
    accessToken: 'token',
  })),
}));

vi.mock('~/services/koin/target', () => ({
  labelOf: vi.fn(() => '스테이지'),
  resolveTargetByEnv: vi.fn(() => ({
    ok: true,
    target: {
      env: 'stage',
      label: '스테이지',
      baseUrl: 'https://api.stage.example.com',
      email: 'admin@example.com',
      password: 'password',
    },
  })),
}));

import { applyCoopTimetable, applyCoopTimetables } from '~/services/coop/adminApi';
import { cancelCoopJob, claimCoopJob, finishCoopJob } from '~/services/coop/jobStore';
import { handleCoopApplyAction } from '~/services/slack/features/coop/applyActions';
import { loadCoopReview } from '~/services/coop/reviewStore';

function client() {
  return {
    chat: {
      update: vi.fn(async () => ({})),
      postEphemeral: vi.fn(async () => ({})),
    },
  };
}

const body = {
  channel: { id: 'C1' },
  user: { id: 'U1' },
  message: { ts: '100.1' },
};

describe('생협 반영 Slack 액션', () => {
  beforeEach(() => vi.clearAllMocks());

  it('반영 권한을 획득한 뒤 저장된 검수 데이터로 Admin API를 호출한다', async () => {
    const slack = client();
    await handleCoopApplyAction(
      slack as never,
      body as never,
      {
        type: 'button',
        action_id: 'coop:apply',
        value: JSON.stringify({ token: 'a'.repeat(32) }),
      } as never,
    );

    expect(claimCoopJob).toHaveBeenCalledWith('a'.repeat(32), 'U1');
    expect(applyCoopTimetable).toHaveBeenCalledWith(
      {
        semester: '26-1학기',
        from_date: '2026-03-03',
        to_date: '2026-06-19',
      },
      { coop_shops: [] },
      expect.objectContaining({ accessToken: 'token' }),
    );
    expect(finishCoopJob).toHaveBeenCalledWith('a'.repeat(32), 'APPLIED', { semesterId: 17 });
    expect(slack.chat.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        text: '생협 반영 완료',
        blocks: expect.arrayContaining([expect.objectContaining({ type: 'section' })]),
      }),
    );
  });

  it('확인 필요 항목이 남아 있어도 저장된 데이터로 반영한다', async () => {
    vi.mocked(loadCoopReview).mockResolvedValueOnce({
      html: '<html></html>',
      request: { coop_shops: [] },
      conversion: {
        semester: '26-1학기',
        fromDate: '2026-03-03',
        toDate: '2026-06-19',
        request: { coop_shops: [] },
        shops: [],
        excludedShops: [],
        issues: [
          {
            code: 'unmatched_shop',
            severity: 'blocking',
            shop: '기계실',
            detail: '기존 표준 매장과 연결하지 못했습니다.',
          },
        ],
      },
      meta: {
        env: 'stage',
        year: 2026,
        termName: '1학기',
        sourceFileName: '시설물-운영시간.png',
        shopCount: 11,
        blockingCount: 1,
        createdAt: '2026-08-08T00:00:00.000Z',
      },
    });
    const slack = client();

    await handleCoopApplyAction(
      slack as never,
      body as never,
      {
        type: 'button',
        action_id: 'coop:apply',
        value: JSON.stringify({ token: 'a'.repeat(32) }),
      } as never,
    );

    expect(applyCoopTimetable).toHaveBeenCalled();
    expect(finishCoopJob).toHaveBeenCalledWith('a'.repeat(32), 'APPLIED', { semesterId: 17 });
  });

  it('취소 버튼은 대기 작업만 취소한다', async () => {
    const slack = client();
    await handleCoopApplyAction(
      slack as never,
      body as never,
      {
        type: 'button',
        action_id: 'coop:cancel',
        value: JSON.stringify({ token: 'a'.repeat(32) }),
      } as never,
    );

    expect(cancelCoopJob).toHaveBeenCalledWith('a'.repeat(32), 'U1');
    expect(applyCoopTimetable).not.toHaveBeenCalled();
    expect(slack.chat.update).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '생협 반영 취소됨',
      }),
    );
  });

  it('방학 검토는 계절학기와 방학을 한 번에 순차 반영한다', async () => {
    const conversion = {
      semester: '26-하계계절학기',
      fromDate: '2026-06-22',
      toDate: '2026-07-17',
      request: { coop_shops: [] },
      shops: [],
      excludedShops: [],
      issues: [],
    };
    vi.mocked(loadCoopReview).mockResolvedValueOnce({
      html: '<html></html>',
      request: conversion.request,
      conversion,
      periods: [
        { kind: '계절학기', request: conversion.request, conversion },
        {
          kind: '방학',
          request: { coop_shops: [] },
          conversion: {
            ...conversion,
            semester: '26-하계방학',
            fromDate: '2026-07-18',
            toDate: '2026-08-30',
          },
        },
      ],
      meta: {
        env: 'stage',
        year: 2026,
        termName: '하계계절학기·하계방학',
        sourceFileName: '하계방학.png',
        shopCount: 11,
        blockingCount: 0,
        createdAt: '2026-08-08T00:00:00.000Z',
      },
    });
    const slack = client();
    await handleCoopApplyAction(
      slack as never,
      body as never,
      {
        type: 'button',
        action_id: 'coop:apply',
        value: JSON.stringify({ token: 'a'.repeat(32) }),
      } as never,
    );

    expect(applyCoopTimetables).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ semester: expect.objectContaining({ semester: '26-하계계절학기' }) }),
        expect.objectContaining({ semester: expect.objectContaining({ semester: '26-하계방학' }) }),
      ]),
      expect.objectContaining({ accessToken: 'token' }),
      expect.any(Function),
    );
    expect(finishCoopJob).toHaveBeenCalledWith('a'.repeat(32), 'APPLIED', { semesterId: 21, semesterIds: [21, 22] });
  });
});
