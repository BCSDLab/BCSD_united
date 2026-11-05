import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCrawlerService } from '../src/server.ts';
import { JobStore, type Job } from '../src/store.ts';

const TOKEN = 'test-credential-with-at-least-32-characters';
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function statePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bbot-crawler-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'state.sqlite');
}

async function serve(run: Parameters<typeof createCrawlerService>[0]['run'], path = statePath()) {
  const service = createCrawlerService({ statePath: path, authToken: TOKEN, run });
  cleanup.push(() => service.stop());
  const port = await service.listen(0);
  const url = `http://127.0.0.1:${port}`;
  const request = (route: string, init: RequestInit = {}) =>
    fetch(url + route, {
      ...init,
      headers: { Authorization: `Bearer ${TOKEN}`, ...init.headers },
    });
  return { service, request };
}

type Request = (route: string, init?: RequestInit) => Promise<Response>;
async function enqueue(request: Request, body: object) {
  return request('/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function until(request: Request, id: string, status: Job['status']) {
  for (let n = 0; n < 100; n++) {
    const response = await request(`/jobs/${id}`);
    const job = (await response.json()) as Job;
    if (job.status === status) return job;
    await new Promise<void>(setImmediate);
  }
  throw new Error(`Job did not reach ${status}`);
}

describe('crawler HTTP and durable queue', () => {
  it('authenticates every endpoint and health does not invoke a source', async () => {
    const run = vi.fn(async () => ({ chunks: 1 }));
    const { request } = await serve(run);
    const health = await request('/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, service: 'b-bot-crawler' });
    expect(run).not.toHaveBeenCalled();
    expect((await request('/health', { headers: { Authorization: 'Bearer invalid' } })).status).toBe(401);
    expect((await request('/jobs/missing', { headers: { Authorization: '' } })).status).toBe(401);
  });

  it('validates bounded input, content type, connector, and full mode', async () => {
    const { request } = await serve(async () => ({ docs: 0 }));
    expect((await request('/jobs', { method: 'POST', body: '{}' })).status).toBe(415);
    expect((await enqueue(request, { connector: 'arbitrary', idempotencyKey: 'one' })).status).toBe(400);
    expect((await enqueue(request, { connector: 'github', idempotencyKey: 'one', full: true })).status).toBe(400);
    expect((await enqueue(request, { connector: 'notion', idempotencyKey: 'one', full: 'yes' })).status).toBe(400);
    expect(
      (await enqueue(request, { connector: 'github', idempotencyKey: 'one', url: 'https://example.com' })).status,
    ).toBe(400);
    expect((await enqueue(request, { connector: 'github', idempotencyKey: '한글' })).status).toBe(400);
    expect(
      (
        await request('/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'x'.repeat(4097),
        })
      ).status,
    ).toBe(413);
    expect((await request('/jobs/not-a-uuid')).status).toBe(404);
  });

  it('deduplicates payloads and serializes jobs globally without exposing source data', async () => {
    const gate = Promise.withResolvers<void>();
    const calls: string[] = [];
    const { request } = await serve(async ({ connector }) => {
      calls.push(connector);
      if (connector === 'notion') await gate.promise;
      return { docs: 2, mode: 'incremental', secret: 'private', skipped: 'repo-name' };
    });
    const first = await enqueue(request, {
      connector: 'notion',
      idempotencyKey: 'sync:notion:2026-11-04',
      full: false,
    });
    expect(first.status).toBe(202);
    const job = (await first.json()) as Job;
    await until(request, job.id, 'running');
    const duplicate = await enqueue(request, {
      connector: 'notion',
      idempotencyKey: 'sync:notion:2026-11-04',
      full: false,
    });
    expect(duplicate.status).toBe(200);
    expect(((await duplicate.json()) as Job).id).toBe(job.id);
    expect(
      (await enqueue(request, { connector: 'notion', idempotencyKey: 'sync:notion:2026-11-04', full: true })).status,
    ).toBe(409);
    const second = await enqueue(request, { connector: 'github', idempotencyKey: 'sync:github:2026-11-04' });
    expect(second.status).toBe(202);
    const next = (await second.json()) as Job;
    expect(((await request(`/jobs/${next.id}`).then((response) => response.json())) as Job).status).toBe('queued');
    expect(calls).toEqual(['notion']);
    gate.resolve();
    expect((await until(request, job.id, 'succeeded')).result).toEqual({ docs: 2, mode: 'incremental' });
    await until(request, next.id, 'succeeded');
    expect(calls).toEqual(['notion', 'github']);
  });

  it('persists failure safely, interrupted restart state, FIFO, and releases the daemon lock', async () => {
    const path = statePath();
    const store = JobStore.open(path);
    const a = store.enqueue({ connector: 'notion', idempotencyKey: 'a', full: true }).job;
    const b = store.enqueue({ connector: 'github', idempotencyKey: 'b' }).job;
    expect(() => JobStore.open(path)).toThrow();
    store.start(a.id);
    store.close();
    const { request } = await serve(async () => {
      throw new Error('private failure details');
    }, path);
    expect((await request(`/jobs/${a.id}`).then((response) => response.json())) as Job).toMatchObject({
      status: 'interrupted',
      error: 'INTERRUPTED',
    });
    expect((await until(request, b.id, 'failed')).error).toBe('INGEST_FAILED');
    expect((await enqueue(request, { connector: 'notion', idempotencyKey: 'a', full: true })).status).toBe(200);
    expect(((await request(`/jobs/${a.id}`).then((response) => response.json())) as Job).status).toBe('interrupted');
  });

  it('marks an in-flight shutdown interrupted and preserves queued work for next boot', async () => {
    const path = statePath();
    const gate = Promise.withResolvers<void>();
    const first = await serve(async () => {
      await gate.promise;
      return { docs: 1 };
    }, path);
    const running = (await (
      await enqueue(first.request, { connector: 'notion', idempotencyKey: 'running' })
    ).json()) as Job;
    await until(first.request, running.id, 'running');
    const queued = (await (
      await enqueue(first.request, { connector: 'gdrive', idempotencyKey: 'queued' })
    ).json()) as Job;
    const stopped = first.service.stop();
    gate.resolve();
    await stopped;
    const second = await serve(async () => ({ docs: 3 }), path);
    expect(((await second.request(`/jobs/${running.id}`).then((response) => response.json())) as Job).status).toBe(
      'interrupted',
    );
    expect((await until(second.request, queued.id, 'succeeded')).result).toEqual({ docs: 3 });
  });
});
