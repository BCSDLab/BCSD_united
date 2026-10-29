import { vi } from 'vitest';

/**
 * Slack 버튼 핸들러가 바깥으로 내보내는 것을 순서대로 모은다.
 * 메시지 갱신·새 메시지·본인에게만 보이는 메시지, 그리고 response_url로 원본을 갈아끼우는 요청.
 */
export function slackRecorder() {
  const events: Array<{ kind: string; args: unknown }> = [];
  const record = (kind: string) =>
    vi.fn(async (args: unknown) => {
      events.push({ kind, args });
      return kind === 'postMessage' ? { ok: true, ts: '200.2' } : { ok: true };
    });
  const client = {
    chat: {
      update: record('update'),
      postMessage: record('postMessage'),
      postEphemeral: record('postEphemeral'),
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { body?: string }) => {
      events.push({ kind: 'replaceOriginal', args: { url, ...JSON.parse(init?.body ?? '{}') } });
      return new Response(null, { status: 200 });
    }),
  );
  return { client, events, record: (kind: string, args: unknown) => events.push({ kind, args }) };
}

export const pressBody = (over: Record<string, unknown> = {}) => ({
  channel: { id: 'C_TEST' },
  user: { id: 'U1' },
  message: { ts: '100.1' },
  response_url: 'https://hooks.slack.test/response',
  ...over,
});
