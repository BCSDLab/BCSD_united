import type { KoinEnv } from '~/services/koin/target';
import type {
  BotReportDetail,
  DecisionResponse,
  DeliveryJob,
  DeliveryOutcome,
  DeliveryState,
  ReportActor,
} from './types';

export interface DiningApiAuth {
  baseUrl: string;
  serviceToken: string;
}

/**
 * 요청 한 번의 타임아웃. 작업 기한(60초) 안에 claim · 슬랙 전송 · 결과 통보가
 * 모두 끝나야 하므로, 한 요청이 기한을 다 쓰지 않도록 짧게 끊는다.
 */
const REQUEST_TIMEOUT_MS = 10_000;

export function resolveDiningAuth(env: KoinEnv): DiningApiAuth | undefined {
  const values = process.env;
  const read = (key: string) => {
    const value = values[key]?.trim();
    return value ? value : undefined;
  };

  const baseUrl = read(env === 'prod' ? 'KOIN_PROD_API_BASE_URL' : 'KOIN_STAGE_API_BASE_URL');
  const serviceToken = read(env === 'prod' ? 'KOIN_PROD_SERVICE_TOKEN' : 'KOIN_STAGE_SERVICE_TOKEN');
  if (!baseUrl || !serviceToken) {
    return undefined;
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), serviceToken };
}

export type DiningApiOperation = 'claim' | 'result' | 'report' | 'approve' | 'reject';

export class DiningApiError extends Error {
  constructor(
    message: string,
    readonly operation: DiningApiOperation,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = 'DiningApiError';
  }
}

function errorCode(body: string): string | undefined {
  try {
    return (JSON.parse(body) as { code?: string }).code;
  } catch {
    return undefined;
  }
}

async function request(auth: DiningApiAuth, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
  return await fetch(`${auth.baseUrl}${path}`, {
    method,
    headers: {
      'X-Koin-Service-Token': auth.serviceToken,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(method === 'POST' && body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function assertOk(response: Response, operation: DiningApiOperation, label: string): Promise<void> {
  if (response.ok) {
    return;
  }
  const body = (await response.text().catch(() => '')).slice(0, 300);
  throw new DiningApiError(
    `식단 품절 제보 API 실패 — ${label} (HTTP ${response.status})\n${body}`,
    operation,
    response.status,
    errorCode(body),
  );
}

async function decide(
  operation: 'approve' | 'reject',
  reportId: number,
  actor: ReportActor,
  auth: DiningApiAuth,
): Promise<DecisionResponse> {
  const path = `/internal/dining/soldout-reports/${reportId}/${operation}`;
  const response = await request(auth, 'POST', path, { actor });
  await assertOk(response, operation, `POST ${path}`);
  return (await response.json()) as DecisionResponse;
}

export async function claimDelivery(auth: DiningApiAuth): Promise<DeliveryJob | null> {
  const path = '/internal/dining/soldout-reports/deliveries/claim';
  const response = await request(auth, 'POST', path);
  if (response.status === 204) {
    return null;
  }
  await assertOk(response, 'claim', `POST ${path}`);
  return (await response.json()) as DeliveryJob;
}

export async function reportDeliveryResult(
  deliveryId: string,
  attemptToken: string,
  outcome: DeliveryOutcome,
  auth: DiningApiAuth,
): Promise<DeliveryState> {
  const path = `/internal/dining/soldout-reports/deliveries/${encodeURIComponent(deliveryId)}/result`;
  const response = await request(auth, 'POST', path, { attempt_token: attemptToken, outcome });
  await assertOk(response, 'result', `POST ${path}`);
  return ((await response.json()) as { delivery_state: DeliveryState }).delivery_state;
}

export async function getReport(reportId: number, auth: DiningApiAuth): Promise<BotReportDetail> {
  const path = `/internal/dining/soldout-reports/${reportId}`;
  const response = await request(auth, 'GET', path);
  await assertOk(response, 'report', `GET ${path}`);
  return (await response.json()) as BotReportDetail;
}

export async function approveReport(
  reportId: number,
  actor: ReportActor,
  auth: DiningApiAuth,
): Promise<DecisionResponse> {
  return await decide('approve', reportId, actor, auth);
}

export async function rejectReport(
  reportId: number,
  actor: ReportActor,
  auth: DiningApiAuth,
): Promise<DecisionResponse> {
  return await decide('reject', reportId, actor, auth);
}
