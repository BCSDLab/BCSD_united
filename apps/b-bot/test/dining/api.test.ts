import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  approveReport,
  claimDelivery,
  DiningApiError,
  getReport,
  rejectReport,
  reportDeliveryResult,
  resolveDiningAuth,
} from '~/services/dining/diningApi';
import type { BotReportDetail, DeliveryJob } from '~/services/dining/types';

const auth = { baseUrl: 'https://api.stage.example.com', serviceToken: 'service-token' };
const actor = { workspace_id: 'T_EXAMPLE', user_id: 'U_REVIEWER', display_name: '처리 담당자' };

const report: BotReportDetail = {
  report_id: 101,
  dining: { id: 1001, date: '2026-10-07', type: 'LUNCH', place: 'C코너' },
  status: 'PENDING',
  processing_type: null,
  reason: null,
  created_at: '2026-10-07 12:31:00',
  processed_at: null,
  processor: null,
  image_url: 'https://static.koreatech.in/upload/COOP/soldout.jpg',
  processing_id: null,
  source_report_id: null,
  updated_at: '2026-10-07 12:31:00',
};

const job: DeliveryJob = {
  delivery_id: '0d7230a0-2675-4fc8-84b7-21afe16b2f01',
  attempt_token: '00000000-0000-4000-8000-000000000001',
  expires_at: '2026-10-07T12:32:00+09:00',
  report,
};

const errorResponse = (status: number, code: string) =>
  Response.json({ code, message: '오류', errorTraceId: '3a7a67b0-8191-4782-b871-1517fcf7fd61' }, { status });

function lastCall(fetchMock: ReturnType<typeof vi.spyOn>) {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  return {
    url,
    method: init.method,
    headers: init.headers as Record<string, string>,
    body: init.body === undefined ? undefined : JSON.parse(init.body as string),
  };
}

describe('식단 품절 제보 API', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('환경별 인증 정보', () => {
    it('주소와 토큰이 모두 있어야 연동한다', () => {
      vi.stubEnv('KOIN_STAGE_API_BASE_URL', 'https://api.stage.example.com/');
      vi.stubEnv('KOIN_STAGE_SERVICE_TOKEN', 'stage-token');
      expect(resolveDiningAuth('stage')).toEqual({
        baseUrl: 'https://api.stage.example.com',
        serviceToken: 'stage-token',
      });

      vi.stubEnv('KOIN_STAGE_SERVICE_TOKEN', '');
      expect(resolveDiningAuth('stage')).toBeUndefined();
    });

    it('다른 환경의 토큰으로 대신하지 않는다', () => {
      vi.stubEnv('KOIN_PROD_API_BASE_URL', 'https://api.example.com');
      vi.stubEnv('KOIN_PROD_SERVICE_TOKEN', '');
      vi.stubEnv('KOIN_STAGE_SERVICE_TOKEN', 'stage-token');
      expect(resolveDiningAuth('prod')).toBeUndefined();
    });
  });

  it('서비스 토큰을 Bearer 없이 원문 그대로 보낸다', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(report));

    await getReport(101, auth);

    const call = lastCall(fetchMock);
    expect(call.url).toBe('https://api.stage.example.com/internal/dining/soldout-reports/101');
    expect(call.method).toBe('GET');
    expect(call.headers['X-Koin-Service-Token']).toBe('service-token');
    expect(call.headers.Authorization).toBeUndefined();
  });

  describe('작업 가져오기', () => {
    it('작업이 있으면 그대로 돌려준다', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(job));

      await expect(claimDelivery(auth)).resolves.toEqual(job);

      const call = lastCall(fetchMock);
      expect(call.url).toBe('https://api.stage.example.com/internal/dining/soldout-reports/deliveries/claim');
      expect(call.method).toBe('POST');
      expect(call.body).toBeUndefined();
    });

    it('할 일이 없으면(204) null을 돌려준다', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

      await expect(claimDelivery(auth)).resolves.toBeNull();
    });
  });

  describe('결과 통보', () => {
    it('토큰과 결과 두 필드만 보낸다', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        Response.json({
          delivery_id: job.delivery_id,
          delivery_state: 'DELIVERED',
        }),
      );

      await expect(reportDeliveryResult(job.delivery_id, job.attempt_token, 'SUCCEEDED', auth)).resolves.toBe(
        'DELIVERED',
      );

      const call = lastCall(fetchMock);
      expect(call.url).toBe(
        `https://api.stage.example.com/internal/dining/soldout-reports/deliveries/${job.delivery_id}/result`,
      );
      expect(call.body).toEqual({ attempt_token: job.attempt_token, outcome: 'SUCCEEDED' });
      expect(call.headers['Content-Type']).toBe('application/json');
    });

    it('교체된 토큰으로 보내면 409 코드를 담아 실패한다', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorResponse(409, 'DINING_REPORT_DELIVERY_CONFLICT'));

      const error = await reportDeliveryResult(job.delivery_id, job.attempt_token, 'FAILED', auth).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(DiningApiError);
      expect(error).toMatchObject({ operation: 'result', status: 409, code: 'DINING_REPORT_DELIVERY_CONFLICT' });
    });
  });

  describe('승인과 반려', () => {
    const decision = { report, affected_report_ids: [101, 102], already_processed: false };

    it('승인은 actor를 담아 approve로 보낸다', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(decision));

      await expect(approveReport(101, actor, auth)).resolves.toEqual(decision);

      const call = lastCall(fetchMock);
      expect(call.url).toBe('https://api.stage.example.com/internal/dining/soldout-reports/101/approve');
      expect(call.body).toEqual({ actor });
    });

    it('반려는 reject로 보낸다', async () => {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json(decision));

      await rejectReport(101, actor, auth);

      expect(lastCall(fetchMock).url).toBe('https://api.stage.example.com/internal/dining/soldout-reports/101/reject');
    });

    it('동시 처리 충돌은 코드로 구분할 수 있다', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(errorResponse(409, 'OPTIMISTIC_LOCKING_FAILURE'));

      const error = await approveReport(101, actor, auth).catch((e: unknown) => e);
      expect(error).toMatchObject({ operation: 'approve', status: 409, code: 'OPTIMISTIC_LOCKING_FAILURE' });
    });
  });

  it('JSON이 아닌 오류 응답에서도 상태 코드는 남긴다', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Bad Gateway', { status: 502 }));

    const error = await getReport(101, auth).catch((e: unknown) => e);
    expect(error).toMatchObject({ operation: 'report', status: 502, code: undefined });
  });
});
