import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  computeBusVersionSchedules,
  describeBusVersionSchedules,
  formatBusVersionScheduleKst,
} from '~/services/bus/versionSchedule';
import type { BusConversion } from '~/services/bus/types';

afterEach(() => {
  vi.unstubAllGlobals();
});

const conversion = (content: string): BusConversion => ({
  payloads: [],
  version_update: { type: 'shuttle_bus_timetable', title: '정규학기', content },
  provenance: {},
  warnings: [],
});

describe('버전 갱신 예약 계산', () => {
  it('적용일 하루 전 00:05(KST)로 예약한다', () => {
    const schedules = computeBusVersionSchedules([conversion('2026-03-02~2026-06-19')]);
    expect(schedules).toEqual([
      {
        version_update: { type: 'shuttle_bus_timetable', title: '정규학기', content: '2026-03-02~2026-06-19' },
        scheduled_at: '2026-02-28T15:05:00.000Z',
      },
    ]);
  });

  it('conversion마다 각자의 일정을 만든다', () => {
    const schedules = computeBusVersionSchedules([
      conversion('2026-03-02~2026-06-19'),
      conversion('2026-06-22~2026-07-10'),
    ]);
    expect(schedules).toHaveLength(2);
    expect(schedules[1].scheduled_at).toBe('2026-06-20T15:05:00.000Z');
  });

  it('형식이 올바르지 않으면 예약을 만들지 않고 실패한다', () => {
    expect(() => computeBusVersionSchedules([conversion('잘못된 기간')])).toThrow(/content 형식이 올바르지 않습니다/);
  });
});

describe('버전 갱신 예약 안내 문구', () => {
  it('KST 시각으로 사람이 읽을 수 있게 바꾼다', () => {
    expect(formatBusVersionScheduleKst('2026-02-28T15:05:00.000Z')).toBe('2026-03-01 00:05 KST');
  });

  it('여러 학기 예약을 한 줄씩 나열한다', () => {
    const text = describeBusVersionSchedules(
      computeBusVersionSchedules([conversion('2026-03-02~2026-06-19'), conversion('2026-06-22~2026-07-10')]),
    );
    expect(text).toBe('정규학기 버전 문구 → 2026-03-01 00:05 KST\n정규학기 버전 문구 → 2026-06-21 00:05 KST');
  });
});

describe('버스 버전 Admin API', () => {
  it('현재 version을 보존해 title과 content를 POST 한다', async () => {
    const { updateBusVersionViaAdminApi } = await import('~/services/bus/adminApi');
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: '2026.1' })))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    await updateBusVersionViaAdminApi(
      { type: 'shuttle_bus_timetable', title: '정규학기', content: '2026-03-02~2026-06-19' },
      { baseUrl: 'https://api.stage.koreatech.in', accessToken: 'admin-token' },
    );

    expect(fetch).toHaveBeenNthCalledWith(1, 'https://api.stage.koreatech.in/admin/version/shuttle_bus_timetable', {
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      signal: expect.any(AbortSignal),
    });
    expect(fetch).toHaveBeenNthCalledWith(2, 'https://api.stage.koreatech.in/admin/version/shuttle_bus_timetable', {
      method: 'POST',
      signal: expect.any(AbortSignal),
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        version: '2026.1',
        title: '정규학기',
        content: '2026-03-02~2026-06-19',
      }),
    });
  });

  it('현재 version 조회 실패 시 POST 하지 않는다', async () => {
    const { updateBusVersionViaAdminApi } = await import('~/services/bus/adminApi');
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal('fetch', fetch);

    await expect(
      updateBusVersionViaAdminApi(
        { type: 'shuttle_bus_timetable', title: '정규학기', content: '2026-03-02~2026-06-19' },
        { baseUrl: 'https://api.stage.koreatech.in', accessToken: 'admin-token' },
      ),
    ).rejects.toThrow('Version Admin API GET failed: 404');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('예약된 버전 갱신 실행', () => {
  const job = (over: Record<string, unknown> = {}) => ({
    token: 'job-1',
    channel_id: 'C1',
    thread_ts: '111.222',
    source_file: '버스시간표.xlsx',
    route_count: 1,
    semester_types: ['REGULAR'],
    target_env: 'stage',
    status: 'APPLIED',
    actor: 'U1',
    error: null,
    version_schedules: [
      {
        version_update: { type: 'shuttle_bus_timetable', title: '정규학기', content: '2026-03-02~2026-06-19' },
        scheduled_at: '2020-01-01T00:00:00.000Z', // 이미 지남
      },
    ],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  it('때가 된 예약을 처리하고 완료 메시지를 보낸 뒤 비운다', async () => {
    const findBusJobsWithPendingVersionSchedules = vi.fn(async () => [job()]);
    const setBusVersionSchedules = vi.fn(async () => undefined);
    vi.doMock('~/services/bus/jobStore', () => ({
      findBusJobsWithPendingVersionSchedules,
      setBusVersionSchedules,
    }));
    vi.doMock('~/services/koin/adminAuth', () => ({
      getKoinAdminAuth: vi.fn(async () => ({ baseUrl: 'https://api.stage.koreatech.in', accessToken: 't' })),
    }));
    vi.doMock('~/services/koin/target', () => ({
      resolveTargetByEnv: () => ({ ok: true, target: { env: 'stage' } }),
    }));
    vi.doMock('~/services/bus/adminApi', () => ({
      updateBusVersionViaAdminApi: vi.fn(async () => undefined),
    }));

    vi.resetModules();
    const { runDueBusVersionUpdates } = await import('~/services/bus/versionSchedule');
    const postMessage = vi.fn().mockResolvedValue({ ok: true });

    await runDueBusVersionUpdates({ chat: { postMessage } } as never);

    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C1', thread_ts: '111.222' }));
    expect(setBusVersionSchedules).toHaveBeenCalledWith('job-1', []);

    vi.doUnmock('~/services/bus/jobStore');
    vi.doUnmock('~/services/koin/adminAuth');
    vi.doUnmock('~/services/koin/target');
    vi.doUnmock('~/services/bus/adminApi');
    vi.resetModules();
  });

  // 5분 주기가 겹쳤을 때 다음 실행이 이전 실행을 취소하는 협조적 취소(cooperative
  // cancellation) 계약: signal이 이미 abort된 채로 들어오면 아무 것도 처리하지 않는다.
  it('signal이 이미 취소됐으면 아무 작업도 처리하지 않는다', async () => {
    const findBusJobsWithPendingVersionSchedules = vi.fn(async () => [job()]);
    const setBusVersionSchedules = vi.fn(async () => undefined);
    vi.doMock('~/services/bus/jobStore', () => ({
      findBusJobsWithPendingVersionSchedules,
      setBusVersionSchedules,
    }));
    vi.doMock('~/services/koin/adminAuth', () => ({
      getKoinAdminAuth: vi.fn(async () => ({ baseUrl: 'https://api.stage.koreatech.in', accessToken: 't' })),
    }));
    vi.doMock('~/services/koin/target', () => ({
      resolveTargetByEnv: () => ({ ok: true, target: { env: 'stage' } }),
    }));
    const updateBusVersionViaAdminApi = vi.fn(async () => undefined);
    vi.doMock('~/services/bus/adminApi', () => ({ updateBusVersionViaAdminApi }));

    vi.resetModules();
    const { runDueBusVersionUpdates } = await import('~/services/bus/versionSchedule');
    const controller = new AbortController();
    controller.abort();

    await runDueBusVersionUpdates(undefined, controller.signal);

    expect(updateBusVersionViaAdminApi).not.toHaveBeenCalled();
    expect(setBusVersionSchedules).not.toHaveBeenCalled();

    vi.doUnmock('~/services/bus/jobStore');
    vi.doUnmock('~/services/koin/adminAuth');
    vi.doUnmock('~/services/koin/target');
    vi.doUnmock('~/services/bus/adminApi');
    vi.resetModules();
  });
});
