import CHANNEL_ID from '@/constant/CHANNEL_ID.json';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decideReport } from '~/services/dining/decision';
import type { BotReportDetail } from '~/services/dining/types';
import { envOfChannel } from '~/services/dining/worker';

const auth = { baseUrl: 'https://api.stage.example.com', serviceToken: 'service-token' };
const actor = { workspace_id: 'T0M5RJ3V2', user_id: 'U_REVIEWER', display_name: '처리 담당자' };

const report = (status: BotReportDetail['status']): BotReportDetail => ({
  report_id: 1,
  dining: { id: 398296, date: '2026-10-08', type: 'BREAKFAST', place: 'A코너' },
  status,
  processing_type: status === 'PENDING' ? null : 'MANUAL',
  reason: null,
  created_at: '2026-10-08 15:34:14',
  processed_at: null,
  processor: null,
  image_url: 'https://stage-static.koreatech.in/upload/COOP/96.jpg',
  processing_id: null,
  source_report_id: null,
  updated_at: '2026-10-08 15:34:14',
});

const decision = (affected: number[], alreadyProcessed = false) =>
  Response.json({ report: report('APPROVED'), affected_report_ids: affected, already_processed: alreadyProcessed });

const conflict = (code: string) =>
  Response.json({ code, message: '충돌', errorTraceId: '3a7a67b0-8191-4782-b871-1517fcf7fd61' }, { status: 409 });

describe('승인·반려 버튼', () => {
  afterEach(() => vi.restoreAllMocks());

  it('승인하면 함께 승인된 대기 제보 수를 알려준다', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(decision([1, 2, 3]));

    const text = await decideReport('approve', 1, actor, auth);
    expect(text).toContain('제보를 승인했어요.');
    expect(text).toContain('같은 코스의 대기 제보 2건도 함께 승인됐어요.');
  });

  it('반려는 그 제보만 처리했다고 알려준다', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(decision([1]));

    const text = await decideReport('reject', 1, actor, auth);
    expect(text).toContain('제보를 반려했어요.');
    expect(text).not.toContain('함께');
    expect((fetchMock.mock.calls[0] as [string])[0]).toMatch(/\/1\/reject$/);
  });

  it('같은 처리를 다시 누르면 이미 처리됐다고 알려준다', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(decision([1], true));

    await expect(decideReport('approve', 1, actor, auth)).resolves.toBe('이미 승인된 제보예요.');
  });

  it('다른 결과로 이미 처리된 제보면 그렇게 알려준다', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(conflict('DINING_REPORT_ALREADY_PROCESSED'));

    await expect(decideReport('approve', 1, actor, auth)).resolves.toContain('이미 다른 결과로 처리된 제보예요.');
  });

  it('동시 처리 충돌 뒤 아직 대기 중이면 한 번 더 요청한다', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(conflict('OPTIMISTIC_LOCKING_FAILURE'))
      .mockResolvedValueOnce(Response.json(report('PENDING')))
      .mockResolvedValueOnce(decision([1]));

    await expect(decideReport('approve', 1, actor, auth)).resolves.toContain('제보를 승인했어요.');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('동시 처리 충돌 뒤 이미 처리됐으면 다시 요청하지 않는다', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(conflict('OPTIMISTIC_LOCKING_FAILURE'))
      .mockResolvedValueOnce(Response.json(report('REJECTED')));

    await expect(decideReport('approve', 1, actor, auth)).resolves.toContain('이미 다른 결과로 처리된 제보예요.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('그 밖의 오류는 던져서 공통 오류 안내로 넘긴다', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Bad Gateway', { status: 502 }));

    await expect(decideReport('approve', 1, actor, auth)).rejects.toThrow('HTTP 502');
  });
});

describe('버튼이 눌린 채널로 환경 정하기', () => {
  it('품절 제보 채널만 환경으로 인정한다', () => {
    expect(envOfChannel(CHANNEL_ID.코인_품절제보알림_stage)).toBe('stage');
    expect(envOfChannel(CHANNEL_ID.코인_품절제보알림)).toBe('prod');
    expect(envOfChannel(CHANNEL_ID.삐봇요청_test)).toBeUndefined();
    expect(envOfChannel(CHANNEL_ID.코인_이벤트알림)).toBeUndefined();
  });
});
