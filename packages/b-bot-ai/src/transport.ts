import { currentEnvironment } from './context.ts';

export const GENERATION_MODEL = 'openai/gpt-6-luna';
export const EMBEDDING_MODEL = '@cf/baai/bge-m3';

type JsonObject = Record<string, unknown>;

export function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

export function upstreamError(value?: unknown, httpStatus?: number): Error {
  const source = object(value);
  const candidate = httpStatus ?? source?.status ?? source?.statusCode;
  const status =
    typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 100 && candidate <= 599
      ? candidate
      : undefined;
  const code = source?.code;
  const message = source?.message;
  const limited =
    code === 2021 ||
    code === 3036 ||
    code === 3040 ||
    code === '2021' ||
    code === '3036' ||
    code === '3040' ||
    (typeof message === 'string' && /\b(?:2021|3036|3040)\b/.test(message));
  const prefix = `Cloudflare AI 요청 실패${status ? ` (HTTP ${status})` : ''}.`;
  if (status === 429 || limited) {
    return new Error(
      `${prefix} 계정에 설정된 사용 한도·크레딧 또는 모델 용량을 확인하세요. 자동 재시도나 다른 모델 전환은 하지 않습니다.`,
    );
  }
  if (status === 401 || status === 403) {
    return new Error(`${prefix} Cloudflare 계정, API 토큰의 Workers AI 권한과 모델 접근 권한을 확인하세요.`);
  }
  return new Error(
    `${prefix} Cloudflare 계정의 사용 한도·크레딧, Workers AI 권한과 서비스 상태를 확인하세요. 자동 재시도나 다른 모델 전환은 하지 않습니다.`,
  );
}

export function unwrapResult(value: unknown): unknown {
  const envelope = object(value);
  if (envelope?.success === false || (Array.isArray(envelope?.errors) && envelope.errors.length > 0)) {
    throw upstreamError(Array.isArray(envelope?.errors) ? envelope.errors[0] : undefined);
  }
  return envelope && 'result' in envelope ? envelope.result : value;
}

async function rejectResponse(response: Response): Promise<never> {
  try {
    await response.body?.cancel();
  } catch {
    // HTTP 상태가 본문 취소 오류보다 원인에 가깝다.
  }
  throw upstreamError(undefined, response.status);
}

async function readJson(response: Response): Promise<unknown> {
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Cloudflare AI 응답이 올바른 JSON이 아닙니다.');
    }
    throw upstreamError();
  }
  return unwrapResult(value);
}

export async function requestAi(model: string, input: JsonObject): Promise<unknown> {
  const env = currentEnvironment();
  if (env.AI) {
    let result: unknown;
    try {
      result = await env.AI.run(model, input);
    } catch (error) {
      throw upstreamError(error);
    }
    if (result instanceof Response) {
      if (!result.ok) return rejectResponse(result);
      return input.stream === true ? result.body : readJson(result);
    }
    return unwrapResult(result);
  }
  const account = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = env.CLOUDFLARE_API_TOKEN?.trim();
  if (!account || !token) {
    throw new Error('Workers AI 바인딩 또는 CLOUDFLARE_ACCOUNT_ID와 CLOUDFLARE_API_TOKEN을 설정하세요.');
  }
  const generation = model === GENERATION_MODEL;
  const endpoint = generation ? 'ai/v1/responses' : `ai/run/${EMBEDDING_MODEL}`;
  let response: Response;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: input.stream === true ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(generation ? { ...input, model: GENERATION_MODEL } : input),
    });
  } catch {
    throw new Error('Cloudflare AI에 연결하지 못했습니다. 네트워크와 계정 설정을 확인하세요.');
  }
  if (!response.ok) return rejectResponse(response);
  return input.stream === true ? response.body : readJson(response);
}
