import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crawlerJobRequest, enqueueCrawlerJob } from '../src/services/rag/crawlerClient';

const job = {
  id: 'job-123',
  connector: 'notion',
  status: 'queued',
  createdAt: '2026-11-02T18:30:00.000Z',
  updatedAt: '2026-11-02T18:30:00.000Z',
};

beforeEach(() => {
  vi.stubEnv('B_BOT_CRAWLER_ORIGIN', 'https://crawler.example.com/');
  vi.stubEnv('B_BOT_CRAWLER_TOKEN', 'a'.repeat(32));
  vi.stubEnv('B_BOT_CRAWLER_ACCESS_CLIENT_ID', 'service-id');
  vi.stubEnv('B_BOT_CRAWLER_ACCESS_CLIENT_SECRET', 'service-secret');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('scheduled Pi job identity', () => {
  it('uses UTC day, connector and Notion mode, not local timezone or task retry time', () => {
    const scheduledTime = '2026-11-02T18:30:00.000Z';
    const retry = new Date('2026-11-03T01:00:00.000Z');
    expect(crawlerJobRequest('github', { scheduledTime }, retry)).toEqual({
      connector: 'github',
      idempotencyKey: 'sync:github:2026-11-02',
    });
    expect(crawlerJobRequest('notion', { scheduledTime }, retry)).toEqual({
      connector: 'notion',
      idempotencyKey: 'sync:notion:2026-11-02:full',
      full: true,
    });
    expect(crawlerJobRequest('notion', { scheduledTime, full: false }, retry)).toEqual({
      connector: 'notion',
      idempotencyKey: 'sync:notion:2026-11-02:incremental',
      full: false,
    });
    expect(crawlerJobRequest('notion', { scheduledTime: '2026-11-09T18:30:00Z' })).toMatchObject({ full: false });
    expect(crawlerJobRequest('gdrive', { scheduledTime })).toEqual({
      connector: 'gdrive',
      idempotencyKey: 'sync:gdrive:2026-11-02',
    });
  });

  it('honors a caller key but rejects malformed keys or full for another connector', () => {
    expect(crawlerJobRequest('notion', { idempotencyKey: 'manual.not-1', full: true }).idempotencyKey).toBe(
      'manual.not-1',
    );
    expect(() => crawlerJobRequest('github', { idempotencyKey: 'has spaces' })).toThrow(/idempotency/);
    expect(() => crawlerJobRequest('gdrive', { full: true })).toThrow(/Notion/);
  });
});

describe('Pi HTTP enqueue boundary', () => {
  it('sends both credentials, exact HTTPS origin, no redirect and a 10s timeout; returns queued as queued', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchMock = vi.fn().mockResolvedValue(Response.json(job, { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const request = crawlerJobRequest('notion', { scheduledTime: job.createdAt });
    await expect(enqueueCrawlerJob(request)).resolves.toEqual(job);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://crawler.example.com/jobs');
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${'a'.repeat(32)}`,
        'CF-Access-Client-Id': 'service-id',
        'CF-Access-Client-Secret': 'service-secret',
      },
    });
    expect(JSON.parse(init.body as string)).toEqual(request);
    expect(timeoutSpy).toHaveBeenCalledWith(10_000);
  });

  it('accepts an existing terminal job without converting its state to fresh success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ ...job, status: 'failed', error: 'INGEST_FAILED' })),
    );
    await expect(enqueueCrawlerJob(crawlerJobRequest('notion', { idempotencyKey: 'manual-1' }))).resolves.toMatchObject(
      { status: 'failed', error: 'INGEST_FAILED' },
    );
  });

  it.each([
    'http://crawler.example.com',
    'https://crawler.example.com/other',
    'https://crawler.example.com?token=bad',
    'https://user@crawler.example.com',
  ])('rejects non-origin or non-HTTPS configuration %s before fetch', async (origin) => {
    vi.stubEnv('B_BOT_CRAWLER_ORIGIN', origin);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(enqueueCrawlerJob(crawlerJobRequest('notion', { full: false }))).rejects.toThrow(/HTTPS origin/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed on missing auth, conflicts, redirects, and malformed public jobs', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('B_BOT_CRAWLER_ACCESS_CLIENT_SECRET', '');
    await expect(enqueueCrawlerJob(crawlerJobRequest('notion'))).rejects.toThrow(/ACCESS_CLIENT_SECRET/);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubEnv('B_BOT_CRAWLER_ACCESS_CLIENT_SECRET', 'service-secret');
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { Location: 'https://evil.invalid/jobs' } }))
      .mockResolvedValueOnce(Response.json({ ...job, connector: 'github' }, { status: 202 }));
    await expect(enqueueCrawlerJob(crawlerJobRequest('notion'))).rejects.toThrow(/HTTP 409/);
    await expect(enqueueCrawlerJob(crawlerJobRequest('notion'))).rejects.toThrow(/HTTP 302/);
    await expect(enqueueCrawlerJob(crawlerJobRequest('notion'))).rejects.toThrow(/Invalid Pi crawler job response/);
  });
});
