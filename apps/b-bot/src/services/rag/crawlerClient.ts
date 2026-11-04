export type CrawlerConnector = 'github' | 'notion' | 'gdrive';
export type CrawlerJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted';

export interface CrawlerJob {
  id: string;
  connector: CrawlerConnector;
  status: CrawlerJobStatus;
  createdAt: string;
  updatedAt: string;
  result?: Record<string, number | 'full' | 'incremental'>;
  error?: string;
}

export type CrawlerJobRequest =
  | { connector: 'github' | 'gdrive'; idempotencyKey: string }
  | { connector: 'notion'; idempotencyKey: string; full: boolean };

export interface CrawlerSchedulePayload {
  idempotencyKey?: string;
  scheduledTime?: string | number;
  full?: boolean;
}

const KEY_PATTERN = /^[a-zA-Z0-9._:-]{1,128}$/;
const JOB_STATUSES: readonly string[] = ['queued', 'running', 'succeeded', 'failed', 'interrupted'];

/** 같은 UTC 예약 실행의 재전송은 같은 Pi 멱등성 키를 사용한다. */
export function crawlerJobRequest(
  connector: CrawlerConnector,
  payload: CrawlerSchedulePayload = {},
  now: Date = new Date(),
): CrawlerJobRequest {
  if (
    payload.scheduledTime !== undefined &&
    typeof payload.scheduledTime !== 'string' &&
    typeof payload.scheduledTime !== 'number'
  ) {
    throw new Error('Invalid crawler scheduled time');
  }
  const scheduled = payload.scheduledTime === undefined ? now : new Date(payload.scheduledTime);
  if (Number.isNaN(scheduled.getTime())) throw new Error('Invalid crawler scheduled time');
  const date = scheduled.toISOString().slice(0, 10);
  if (connector === 'notion') {
    if (payload.full !== undefined && typeof payload.full !== 'boolean') throw new Error('Invalid Notion full flag');
    const full = payload.full ?? scheduled.getUTCDate() <= 7;
    const idempotencyKey = payload.idempotencyKey ?? `sync:notion:${date}:${full ? 'full' : 'incremental'}`;
    if (typeof idempotencyKey !== 'string' || !KEY_PATTERN.test(idempotencyKey)) {
      throw new Error('Invalid crawler idempotency key');
    }
    return { connector, idempotencyKey, full };
  }
  if (payload.full !== undefined) throw new Error('Full sync is only supported for Notion');
  const idempotencyKey = payload.idempotencyKey ?? `sync:${connector}:${date}`;
  if (typeof idempotencyKey !== 'string' || !KEY_PATTERN.test(idempotencyKey)) {
    throw new Error('Invalid crawler idempotency key');
  }
  return { connector, idempotencyKey };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value || /[\r\n]/.test(value)) throw new Error(`Pi crawler configuration missing or invalid: ${name}`);
  return value;
}

/** HTTPS origin만 허용하고 경로·사용자 정보·리디렉션 대상에 자격 증명을 전달하지 않는다. */
function crawlerOrigin(): string {
  const configured = requiredEnv('B_BOT_CRAWLER_ORIGIN');
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error('Pi crawler origin must be an HTTPS origin');
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (configured !== url.origin && configured !== `${url.origin}/`)
  ) {
    throw new Error('Pi crawler origin must be an HTTPS origin');
  }
  return url.origin;
}

function parseJob(value: unknown, connector: CrawlerConnector): CrawlerJob {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Pi crawler job response');
  const job = value as Record<string, unknown>;
  if (
    typeof job.id !== 'string' ||
    !KEY_PATTERN.test(job.id) ||
    job.connector !== connector ||
    !JOB_STATUSES.includes(job.status as string) ||
    typeof job.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(job.createdAt)) ||
    typeof job.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(job.updatedAt))
  ) {
    throw new Error('Invalid Pi crawler job response');
  }
  const result = job.result;
  if (
    result !== undefined &&
    (!result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      Object.entries(result).some(
        ([key, item]) =>
          !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(key) ||
          !(
            (typeof item === 'number' && Number.isFinite(item) && item >= 0) ||
            (key === 'mode' && (item === 'full' || item === 'incremental'))
          ),
      ))
  ) {
    throw new Error('Invalid Pi crawler job response');
  }
  if (job.error !== undefined && (typeof job.error !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(job.error))) {
    throw new Error('Invalid Pi crawler job response');
  }
  return {
    id: job.id,
    connector,
    status: job.status as CrawlerJobStatus,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(result === undefined ? {} : { result: result as CrawlerJob['result'] }),
    ...(job.error === undefined ? {} : { error: job.error as string }),
  };
}

async function readJobBody(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('Missing response body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 8_192) {
        await reader.cancel();
        throw new Error('Oversized response body');
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } finally {
    reader.releaseLock();
  }
}

/** 작업 등록만 기다린다. queued/running은 색인 완료가 아니며 실행과 상태 저장은 Pi가 담당한다. */
export async function enqueueCrawlerJob(request: CrawlerJobRequest): Promise<CrawlerJob> {
  const origin = crawlerOrigin();
  const token = requiredEnv('B_BOT_CRAWLER_TOKEN');
  if (token.length < 32) throw new Error('Pi crawler token must be at least 32 characters');
  const clientId = requiredEnv('B_BOT_CRAWLER_ACCESS_CLIENT_ID');
  const clientSecret = requiredEnv('B_BOT_CRAWLER_ACCESS_CLIENT_SECRET');
  let response: Response;
  try {
    response = await fetch(`${origin}/jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'CF-Access-Client-Id': clientId,
        'CF-Access-Client-Secret': clientSecret,
      },
      body: JSON.stringify(request),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Pi가 작업을 저장한 뒤 응답이 유실될 수 있으므로 같은 키로만 안전하게 재요청한다.
    throw new Error('Pi crawler enqueue transport failed; check the job before retrying');
  }
  if (response.status !== 200 && response.status !== 202) {
    throw new Error(`Pi crawler enqueue failed (HTTP ${response.status})`);
  }
  // 원격 본문 크기를 제한하고 본문 내용을 오류나 로그에 포함하지 않는다.
  let body: unknown;
  try {
    body = await readJobBody(response);
  } catch {
    throw new Error('Invalid Pi crawler job response');
  }
  return parseJob(body, request.connector);
}
