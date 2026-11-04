import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { JobStore, type Connector, type JobRequest, type JobResult } from './store.ts';

const MAX_BODY = 4096;
const KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONNECTORS: Record<Connector, true> = { github: true, notion: true, gdrive: true };

type Runner = (job: { connector: Connector; full: boolean }) => Promise<JobResult>;

export interface ServiceOptions {
  statePath: string;
  authToken: string;
  run: Runner;
}

function send(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function authorized(header: string | undefined, expectedHash: Buffer): boolean {
  const candidate = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const hash = createHash('sha256').update(candidate).digest();
  return Boolean(candidate) && timingSafeEqual(hash, expectedHash);
}

export function parseJobRequest(input: unknown): JobRequest | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !['connector', 'idempotencyKey', 'full'].includes(key))) return undefined;
  if (typeof value.connector !== 'string' || !Object.hasOwn(CONNECTORS, value.connector)) return undefined;
  if (typeof value.idempotencyKey !== 'string' || !KEY.test(value.idempotencyKey)) return undefined;
  if ('full' in value && (value.connector !== 'notion' || typeof value.full !== 'boolean')) return undefined;
  return {
    connector: value.connector as Connector,
    idempotencyKey: value.idempotencyKey,
    ...(value.full === undefined ? {} : { full: value.full as boolean }),
  };
}

async function body(req: IncomingMessage): Promise<unknown> {
  const mediaType = req.headers['content-type'];
  if (typeof mediaType !== 'string' || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(mediaType)) {
    throw new ClientError(415);
  }
  const length = req.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) throw new ClientError(413);
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new ClientError(413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch {
    throw new ClientError(400);
  }
}

function safeResult(result: JobResult): JobResult {
  const output: JobResult = {};
  for (const [key, value] of Object.entries(result)) {
    if (key === 'mode' && (value === 'full' || value === 'incremental')) output.mode = value;
    else if (/^[a-z][a-zA-Z]*$/.test(key) && typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      output[key] = value;
    }
  }
  return output;
}

class ClientError extends Error {
  constructor(readonly status: number) {
    super('Invalid request');
  }
}

/** HTTP와 큐가 같은 저장소를 사용하며, health는 원본·DB·AI를 호출하지 않는다. */
export function createCrawlerService({ statePath, authToken, run }: ServiceOptions) {
  if (authToken.length < 32) throw new Error('CRAWLER_AUTH_TOKEN must be at least 32 characters');
  const store = JobStore.open(statePath);
  const expectedHash = createHash('sha256').update(authToken).digest();
  let stopping = false;
  let active: Promise<void> | undefined;
  let shutdown: Promise<void> | undefined;

  async function drain(): Promise<void> {
    if (active || stopping) return;
    active = (async () => {
      while (!stopping) {
        const job = store.next();
        if (!job) return;
        store.start(job.id);
        try {
          const result = await run(job);
          if (!stopping) store.finish(job.id, 'succeeded', safeResult(result));
        } catch {
          if (!stopping) store.finish(job.id, 'failed');
        }
      }
    })();
    try {
      await active;
    } finally {
      active = undefined;
    }
  }

  const server: Server = createServer(async (req, res) => {
    if (!authorized(req.headers.authorization, expectedHash)) {
      send(res, 401, { error: 'UNAUTHORIZED' });
      return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      send(res, 200, { ok: true, service: 'b-bot-crawler' });
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/jobs/')) {
      const id = req.url.slice('/jobs/'.length);
      const job = ID.test(id) ? store.get(id) : undefined;
      send(res, job ? 200 : 404, job ?? { error: 'NOT_FOUND' });
      return;
    }
    if (req.method === 'POST' && req.url === '/jobs') {
      try {
        const request = parseJobRequest(await body(req));
        if (!request) throw new ClientError(400);
        const { job, created, conflict } = store.enqueue(request);
        if (conflict) send(res, 409, { error: 'IDEMPOTENCY_CONFLICT' });
        else {
          send(res, created ? 202 : 200, job);
          if (created) setImmediate(() => void drain());
        }
      } catch (error) {
        send(res, error instanceof ClientError ? error.status : 500, {
          error: error instanceof ClientError ? 'INVALID_REQUEST' : 'INTERNAL_ERROR',
        });
      }
      return;
    }
    send(res, 404, { error: 'NOT_FOUND' });
  });

  async function listen(port = 8813): Promise<number> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
    await promise;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Unexpected listener address');
    setImmediate(() => void drain());
    return address.port;
  }

  function stop(): Promise<void> {
    return (shutdown ??= (async () => {
      stopping = true;
      store.interruptRunning();
      try {
        if (server.listening) {
          const { promise, resolve, reject } = Promise.withResolvers<void>();
          server.close((error) => (error ? reject(error) : resolve()));
          await promise;
        }
        if (active) await active;
      } finally {
        store.close();
      }
    })());
  }

  return { listen, stop, store, server };
}
