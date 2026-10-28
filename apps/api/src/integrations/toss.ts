import { ApiError } from '@api/errors';
import type { Bindings } from '@api/runtime';
import { base64, IntegrationError, request, required, retryAfter, retryableStatus } from '@api/integrations/http';
import { TOSS_ERRORS } from '@api/integrations/toss-errors';

export interface TossPayment {
  paymentKey: string;
  orderId: string;
  status: string;
  totalAmount: number;
  balanceAmount: number;
  type?: string;
  orderName?: string;
  mId?: string;
  currency?: string;
  method?: string;
  requestedAt?: string;
  approvedAt?: string;
  useEscrow?: boolean;
  lastTransactionKey?: string;
  suppliedAmount?: number;
  vat?: number;
  cultureExpense?: boolean;
  taxFreeAmount?: number;
  taxExemptionAmount?: number;
  isPartialCancelable?: boolean;
  country?: string;
  receipt?: { url: string } | null;
  card?: { amount: number; issuerCode: string; acquirerCode: string; number: string; installmentPlanMonths: number; approveNo: string; useCardPoint: boolean; cardType: string; ownerType: string; acquireStatus: string; isInterestFree: boolean; interestPayer: string } | null;
  easyPay?: { provider: string; amount: number; discountAmount: number } | null;
  cancels?: { cancelAmount: number; cancelReason: string; canceledAt: string; transactionKey: string; cancelStatus?: string; refundableAmount?: number }[] | null;
}

export interface TossCancelInput { cancelReason: string; cancelAmount?: number; taxFreeAmount?: number; refundableAmount?: number; refundReceiveAccount?: { bank: string; accountNumber: string; holderName: string } }

function notConfigured(message: string): ApiError {
  return new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', message);
}

export class TossGatewayError extends ApiError {
  constructor(
    code: string,
    public readonly providerStatus: number | null,
    public readonly retryable: boolean,
    /** 결제가 Toss 쪽에서 처리됐는지 알 수 없는 실패. 호출자는 조회로 확인한 뒤 재시도한다. */
    public readonly uncertain: boolean,
    public readonly timeout: boolean,
    public readonly retryAfterMs: number | null = null,
  ) {
    const known = Object.hasOwn(TOSS_ERRORS, code);
    const mapped = known ? TOSS_ERRORS[code]! : TOSS_ERRORS.UNKNOWN_ERROR!;
    super(mapped.status, known ? code : 'UNKNOWN_ERROR', mapped.message);
    this.name = 'TossGatewayError';
  }
}

function tossTimeoutMs(env: Bindings): number {
  const timeout = Number(env.TOSS_API_TIMEOUT_MS ?? 15_000);
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > 120_000) throw notConfigured('TOSS_API_TIMEOUT_MS 설정이 올바르지 않습니다.');
  return timeout;
}

function tossBaseUrl(env: Bindings): string {
  let base: URL;
  try {
    base = new URL(env.TOSS_PAYMENT_API_BASE_URL ?? 'https://api.tosspayments.com/v1/payments');
  } catch {
    throw notConfigured('TOSS_PAYMENT_API_BASE_URL 설정이 올바르지 않습니다.');
  }
  const expected = base.origin === 'https://api.tosspayments.com' && base.pathname.replace(/\/$/, '') === '/v1/payments';
  if (!expected || base.username || base.password || base.search || base.hash) throw notConfigured('TOSS_PAYMENT_API_BASE_URL은 Toss 결제 API 주소여야 합니다.');
  return base.href.replace(/\/$/, '');
}

function validPayment(value: TossPayment | null | undefined): value is TossPayment {
  return !!value && typeof value.paymentKey === 'string' && typeof value.orderId === 'string' && typeof value.status === 'string'
    && Number.isSafeInteger(value.totalAmount) && Number.isSafeInteger(value.balanceAmount);
}

async function tossRequest(env: Bindings, path: string, method: 'GET' | 'POST', body?: unknown, idempotencyKey?: string): Promise<TossPayment> {
  const secret = required(env.TOSS_SECRET_KEY, 'TOSS_SECRET_KEY');
  const timeout = tossTimeoutMs(env);
  if (method === 'POST' && (!idempotencyKey || !/^[\x21-\x7e]{1,300}$/.test(idempotencyKey))) {
    throw new ApiError(400, 'INVALID_REQUEST', '결제 멱등키가 필요합니다.');
  }
  const base = tossBaseUrl(env);
  // POST는 요청이 Toss에 도달했을 수 있으므로 전송 실패도 결과 불확실로 취급한다.
  const uncertainOnFailure = method === 'POST';
  let response: Response;
  try {
    response = await request('Toss', `${base}${path}`, {
      method,
      headers: {
        authorization: `Basic ${base64(new TextEncoder().encode(`${secret}:`))}`,
        'content-type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, timeout);
  } catch (error) {
    if (error instanceof IntegrationError) throw new TossGatewayError('UNKNOWN_ERROR', null, true, uncertainOnFailure, error.timeout);
    throw error;
  }
  if (!response.ok) {
    let code = 'UNKNOWN_ERROR';
    try {
      const error = await response.json<{ code?: string }>();
      code = error.code ?? code;
    } catch {
      // 파싱 실패는 결제 미처리를 의미하지 않으므로 호출자가 조회로 확인한다.
    }
    throw new TossGatewayError(code, response.status, retryableStatus(response.status), uncertainOnFailure && response.status >= 500, false, retryAfter(response));
  }
  let result: TossPayment;
  try {
    result = await response.json<TossPayment>();
  } catch {
    throw new TossGatewayError('UNKNOWN_ERROR', response.status, true, uncertainOnFailure, false);
  }
  if (!validPayment(result)) throw new TossGatewayError('UNKNOWN_ERROR', response.status, true, uncertainOnFailure, false);
  return result;
}

export async function tossConfirm(env: Bindings, input: { paymentKey: string; orderId: string; amount: number }, idempotencyKey: string): Promise<TossPayment> {
  if (!input.paymentKey || !input.orderId || !Number.isSafeInteger(input.amount) || input.amount < 0) throw new ApiError(400, 'INVALID_REQUEST', '결제 승인 정보가 올바르지 않습니다.');
  return tossRequest(env, '/confirm', 'POST', input, idempotencyKey);
}

export async function tossCancel(env: Bindings, paymentKey: string, input: TossCancelInput, idempotencyKey: string): Promise<TossPayment> {
  if (!paymentKey || !input.cancelReason.trim() || (input.cancelAmount !== undefined && (!Number.isSafeInteger(input.cancelAmount) || input.cancelAmount <= 0))) throw new ApiError(400, 'INVALID_REQUEST', '결제 취소 정보가 올바르지 않습니다.');
  return tossRequest(env, `/${encodeURIComponent(paymentKey)}/cancel`, 'POST', input, idempotencyKey);
}

export async function tossRetrieve(env: Bindings, paymentKey: string): Promise<TossPayment> {
  if (!paymentKey) throw new ApiError(400, 'INVALID_REQUEST', '결제 키가 필요합니다.');
  return tossRequest(env, `/${encodeURIComponent(paymentKey)}`, 'GET');
}
