import { afterEach, describe, expect, it, vi } from 'vitest';
import type { H3Event } from 'h3';
import { enqueueSlackJob, withoutSlackCredentials, type SlackJob } from '~/services/slack/jobs';

const job: SlackJob = {
  type: 'message',
  message: { channel: 'C1', user: 'U1', ts: '1.0', text: '!질문 hello' },
};

describe('Slack queue ingress', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('removes Slack authentication and webhook capabilities from queued payloads', () => {
    const payload = {
      token: 'verification-token',
      response_url: 'https://hooks.slack.com/secret',
      response_urls: [{ response_url: 'https://hooks.slack.com/other-secret' }],
      trigger_id: 'short-lived-trigger',
      command: '/회의생성',
      text: 'meeting',
    };
    expect(withoutSlackCredentials(payload)).toEqual({ command: '/회의생성', text: 'meeting' });
    expect(payload.token).toBe('verification-token');
  });

  it('does not acknowledge before the producer has durably accepted the job', async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    const send = vi.fn(() => promise);
    const event = { context: { cloudflare: { env: { SLACK_JOBS: { send } } } } } as unknown as H3Event;
    let acknowledged = false;
    const pending = enqueueSlackJob(event, job).then(() => {
      acknowledged = true;
    });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    expect(send).toHaveBeenCalledWith(job, { contentType: 'json' });
    resolve();
    await pending;
    expect(acknowledged).toBe(true);
  });
});
