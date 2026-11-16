import { describe, expect, it, vi } from 'vitest';
import { forwardAutofixMention, isAutofixMention } from '~/services/slack/autofix';

describe('Slack autofix mention forwarding', () => {
  it('does not forward normal mentions or questions even when automation is unconfigured', () => {
    for (const text of ['<@UBOT> 안녕', '<@UBOT> 사진 수정 가능해?', '질문 <@UBOT>', '<@UBOT> 수정요청'])
      expect(isAutofixMention(text)).toBe(false);
    expect(isAutofixMention('<@UBOT> 수정요청 사진 표시를 고쳐줘')).toBe(true);
  });

  it('preserves the exact Slack body and signing headers for independent receiver authentication', async () => {
    const body = '{ "event": {"text":"<@UBOT> 수정요청 사진 표시를 고쳐줘"} }';
    const fetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe('https://error-automation.internal/slack/requests');
      expect(request.method).toBe('POST');
      expect(request.headers.get('x-slack-signature')).toBe('v0=signature');
      expect(request.headers.get('x-slack-request-timestamp')).toBe('1700000000');
      expect(await request.text()).toBe(body);
      return Response.json({ status: 'queued' });
    });
    await forwardAutofixMention({ fetch }, body, 'v0=signature', '1700000000');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('keeps intake and transport failures retryable instead of acknowledging lost jobs', async () => {
    await expect(forwardAutofixMention(undefined, '{}', '', '')).rejects.toThrow('ERROR_AUTOMATION');
    for (const status of [429, 500, 503])
      await expect(
        forwardAutofixMention({ fetch: async () => new Response('', { status }) }, '{}', '', ''),
      ).rejects.toThrow(String(status));
    await expect(
      forwardAutofixMention(
        {
          fetch: async () => {
            throw new Error('network');
          },
        },
        '{}',
        '',
        '',
      ),
    ).rejects.toThrow('network');
  });

  it('acknowledges only explicitly marked configuration rejections without retrying', async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        { error: 'Slack autofix is not configured.' },
        { status: 503, headers: { 'x-slack-autofix-error': 'not-configured' } },
      ),
    );
    await expect(forwardAutofixMention({ fetch }, '{}', '', '')).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
    for (const [status, marker] of [
      [503, 'storage-unavailable'],
      [500, 'not-configured'],
    ] as const)
      await expect(
        forwardAutofixMention(
          { fetch: async () => new Response('', { status, headers: { 'x-slack-autofix-error': marker } }) },
          '{}',
          '',
          '',
        ),
      ).rejects.toThrow(String(status));
  });

  it('does not replay unauthorized requests or duplicate durable admissions', async () => {
    for (const status of [200, 400, 401, 403, 413, 415])
      await expect(
        forwardAutofixMention({ fetch: async () => new Response('', { status }) }, '{}', '', ''),
      ).resolves.toBeUndefined();
  });
});
