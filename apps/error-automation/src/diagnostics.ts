import type { Diagnostic, Env, Identity } from './types';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected provider object');
  return value as Record<string, unknown>;
}
export function redact(value: unknown, max = 2000): string | null {
  if (typeof value !== 'string') return null;
  return (
    value
      .slice(0, 16000)
      .replace(/https?:\/\/[^\s<>"']+/gi, '[url]')
      .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, '[authorization]')
      .replace(
        /\b(?:authorization|cookie|password|passwd|secret|token|api[_-]?key)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
        '[credential]',
      )
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]')
      .replace(
        /\b(?:sk-ant-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
        '[secret]',
      )
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .slice(0, max)
  );
}
async function boundedJson(response: Response, max = 2_000_000): Promise<Record<string, unknown>> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Diagnostic provider returned ${response.status}`);
  }
  if (!response.body) throw new Error('Missing diagnostic response');
  const reader = response.body.getReader();
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > max) {
        await reader.cancel();
        throw new Error('Diagnostic exceeds size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return object(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)));
}
function safeRoute(value: unknown, hosts: string[]): string | null {
  try {
    if (typeof value !== 'string') return null;
    const url = new URL(value);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      !hosts.includes(url.hostname) ||
      url.username ||
      url.password ||
      !/^\/[A-Za-z0-9_/-]*$/.test(url.pathname) ||
      url.pathname.startsWith('//') ||
      url.pathname.includes('..')
    )
      return null;
    return url.pathname;
  } catch {
    return null;
  }
}
export interface TrustedEvidence {
  data: Record<string, unknown>;
  route: string;
  requestMethod: 'GET';
}
export async function trustedDiagnostics(env: Env, identity: Identity, stored: Diagnostic): Promise<TrustedEvidence> {
  if (JSON.stringify(stored.identity) !== JSON.stringify(identity))
    throw new Error('Stored diagnostic identity mismatch');
  if (identity.source === 'cloudflare') {
    const details = object(stored.details);
    if (
      !['alertType', 'timestamp', 'data'].every((key) => key in details) ||
      !Number.isSafeInteger(details.timestamp) ||
      !details.data ||
      typeof details.data !== 'object'
    )
      throw new Error('Unsupported Cloudflare notification');
    // The documented Issues notification envelope has no authenticated source frame/route proof.
    // Only a real provider payload can establish an evidence contract; never synthesize one.
    throw new Error(
      'CLOUDFLARE_EVIDENCE_UNAVAILABLE: authenticated Issues payload with exception/source-frame/request-route evidence required',
    );
  }
  if (!env.SENTRY_READ_TOKEN) throw new Error('Missing Sentry read credential');
  const url = `https://sentry.io/api/0/organizations/${identity.scope.organization}/issues/${identity.sourceId}/`;
  const get = (suffix: string) =>
    fetch(url + suffix, {
      headers: { Authorization: `Bearer ${env.SENTRY_READ_TOKEN}` },
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    }).then((response) => boundedJson(response));
  const canonical = await get('');
  const event = await get('events/latest/');
  if (
    String(canonical.id) !== identity.sourceId ||
    object(canonical.project).slug !== identity.project ||
    event.platform !== 'javascript' ||
    object(event.sdk).name !== 'sentry.javascript.react' ||
    (event.groupID !== undefined && String(event.groupID) !== identity.sourceId)
  )
    throw new Error('Canonical Sentry issue/event identity mismatch');
  const hostMap = object(JSON.parse(env.SENTRY_PROJECT_HOSTS));
  const hosts = hostMap[identity.project];
  if (
    !Array.isArray(hosts) ||
    hosts.length === 0 ||
    hosts.some((host) => typeof host !== 'string' || !/^[a-z0-9.-]+$/.test(host))
  )
    throw new Error('Configure explicit Sentry project hosts');
  const entries = Array.isArray(event.entries) ? event.entries.map(object) : [];
  const request = entries.find((entry) => entry.type === 'request');
  const route = safeRoute(request ? object(request.data).url : null, hosts as string[]);
  const exceptions = entries
    .filter((entry) => entry.type === 'exception')
    .flatMap((entry) => (Array.isArray(object(entry.data).values) ? (object(entry.data).values as unknown[]) : []))
    .slice(0, 5)
    .map((item) => {
      const value = object(item),
        stack = value.stacktrace && typeof value.stacktrace === 'object' ? object(value.stacktrace) : {};
      const frames = Array.isArray(stack.frames)
        ? stack.frames.slice(-40).flatMap((raw) => {
            const frame = object(raw);
            if (frame.inApp !== true || typeof frame.filename !== 'string') return [];
            const filename = frame.filename.replace(/^app:\/\/\//, '').replace(/^\.\//, '');
            if (
              !/^(?:apps\/web\/)?src\/[A-Za-z0-9_/$().-]+\.(?:tsx?|jsx?)$/.test(filename) ||
              filename.split('/').includes('..') ||
              !Number.isSafeInteger(frame.lineNo) ||
              (frame.lineNo as number) < 1
            )
              return [];
            return [
              {
                filename,
                function: redact(frame.function, 300),
                lineNo: frame.lineNo,
                colNo: Number.isSafeInteger(frame.colNo) && (frame.colNo as number) >= 0 ? frame.colNo : null,
                inApp: true,
              },
            ];
          })
        : [];
      return { type: redact(value.type, 200), value: redact(value.value), frames };
    });
  if (!route || !exceptions.some((exception) => exception.frames.length))
    throw new Error('No safe route and source frame; manual reproduction required');
  return {
    data: {
      ...identity,
      title: redact(canonical.title),
      culprit: redact(canonical.culprit),
      eventId: /^[a-f0-9]{32}$/.test(String(event.eventID ?? '')) ? event.eventID : null,
      platform: 'javascript',
      exceptions,
      route,
      requestMethod: 'GET',
    },
    route,
    requestMethod: 'GET',
  };
}
