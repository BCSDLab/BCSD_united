import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeliveryJob } from '~/services/dining/types';
import type * as DiningApi from '~/services/dining/diningApi';

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  report: vi.fn(),
  auth: vi.fn(),
  deliver: vi.fn(),
  postMessage: vi.fn(),
}));
vi.mock('@slack/web-api', () => ({
  WebClient: class {
    chat = { postMessage: mocks.postMessage };
  },
}));
vi.mock('~/services/dining/diningApi', async (original) => ({
  ...(await original<typeof DiningApi>()),
  claimDelivery: mocks.claim,
  reportDeliveryResult: mocks.report,
  resolveDiningAuth: mocks.auth,
}));
vi.mock('~/services/dining/deliver', () => ({ deliver: mocks.deliver }));

import { DINING_BATCH_LIMIT, runDiningBatch } from '~/services/dining/worker';

const job: DeliveryJob = {
  delivery_id: 'delivery-1',
  attempt_token: 'attempt-1',
  expires_at: '2026-10-28T12:01:00Z',
  report: {
    report_id: 1,
    dining: { id: 1, date: '2026-10-28', type: 'LUNCH', place: 'A코너' },
    status: 'PENDING',
    processing_type: null,
    reason: null,
    created_at: '2026-10-28 21:00:00',
    processed_at: null,
    processor: null,
    image_url: 'https://static.koreatech.in/dining.jpg',
    processing_id: null,
    source_report_id: null,
    updated_at: '2026-10-28 21:00:00',
  },
};
const auth = { baseUrl: 'https://stage.example.com', serviceToken: 'service-token' };
const stored = new Map<string, number>();

describe('finite dining batches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stored.clear();
    vi.stubEnv('SLACK_BOT_TOKEN', 'test-slack-token');
    vi.stubGlobal('useStorage', () => ({
      getItem: async (key: string) => stored.get(key) ?? null,
      setItem: async (key: string, value: number) => {
        stored.set(key, value);
      },
      removeItem: async (key: string) => {
        stored.delete(key);
      },
    }));
    mocks.auth.mockReturnValue(auth);
    mocks.claim.mockResolvedValue(null);
    mocks.report.mockResolvedValue(undefined);
    mocks.deliver.mockResolvedValue('SUCCEEDED');
    mocks.postMessage.mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('returns immediately when the server has no work', async () => {
    await expect(runDiningBatch('stage')).resolves.toBe(0);
    expect(mocks.claim).toHaveBeenCalledTimes(1);
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it('does not claim without explicit API credentials', async () => {
    mocks.auth.mockReturnValue(undefined);
    await expect(runDiningBatch('stage')).resolves.toBe(0);
    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('caps work even when every claim returns a delivery', async () => {
    mocks.claim.mockResolvedValue(job);
    await expect(runDiningBatch('stage')).resolves.toBe(DINING_BATCH_LIMIT);
    expect(mocks.claim).toHaveBeenCalledTimes(DINING_BATCH_LIMIT);
    expect(mocks.report).toHaveBeenCalledWith(job.delivery_id, job.attempt_token, 'SUCCEEDED', auth);
  });

  it('reports delivery failures without repeating the mutation in the same claim', async () => {
    mocks.claim.mockResolvedValueOnce(job).mockResolvedValue(null);
    mocks.deliver.mockRejectedValueOnce(new Error('Slack unavailable'));
    await expect(runDiningBatch('stage')).resolves.toBe(1);
    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    expect(mocks.report).toHaveBeenCalledWith(job.delivery_id, job.attempt_token, 'FAILED', auth);
  });

  it('keeps the failure alert streak across invocations and clears it after success', async () => {
    stored.set('dining:failures:stage:delivery-1', 5);
    mocks.deliver.mockResolvedValue('FAILED');
    mocks.claim.mockResolvedValueOnce(job).mockResolvedValueOnce(null);
    await runDiningBatch('stage');
    expect(mocks.postMessage).toHaveBeenCalledTimes(1);
    expect(stored.get('dining:failures:stage:delivery-1')).toBe(6);

    mocks.deliver.mockResolvedValue('SUCCEEDED');
    mocks.claim.mockResolvedValueOnce(job).mockResolvedValueOnce(null);
    await runDiningBatch('stage');
    expect(stored.has('dining:failures:stage:delivery-1')).toBe(false);
  });
});
