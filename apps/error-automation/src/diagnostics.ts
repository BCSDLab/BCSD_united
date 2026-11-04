import type { Diagnostic, Env, Identity } from './types';
import { SOURCE_HOSTS, tailKey } from './tail';

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
function safeRoute(value: unknown, hosts: readonly string[]): string | null {
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
const CF_ACCOUNT = 'abe06b869950de952decf9df29c6f1a3';
const VERSION_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const RAY_ID = /^[a-f0-9]{16}$/;
const TRACE_ID = /^[a-f0-9]{32}$/;
const EVIDENCE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

async function cloudflareEvidence(
  env: Env,
  identity: Extract<Identity, { source: 'cloudflare' }>,
  stored: Diagnostic,
): Promise<TrustedEvidence> {
  if (
    identity.scope.accountId !== CF_ACCOUNT ||
    !['koin-web', 'koin-api'].includes(identity.project) ||
    identity.scope.workerName !== identity.project ||
    (env.CLOUDFLARE_DIAGNOSTICS_TOKEN?.length ?? 0) < 30
  ) {
    throw new Error('CLOUDFLARE_EVIDENCE_UNAVAILABLE: fixed account, Worker or read credential missing');
  }
  const headers = { Authorization: `Bearer ${env.CLOUDFLARE_DIAGNOSTICS_TOKEN}` };
  const api = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}`;
  const issueId = `${identity.sourceId.slice(0, 8)}-${identity.sourceId.slice(8, 12)}-${identity.sourceId.slice(12, 16)}-${identity.sourceId.slice(16, 20)}-${identity.sourceId.slice(20)}`;
  // This Issues occurrence GET is the exact read-only endpoint observed in the
  // account dashboard. It is beta/undocumented: any contract drift fails closed.
  const response = await fetch(`${api}/workers/observability/issues/${issueId}/occurrences?per_page=5`, {
    headers,
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  });
  const body = await boundedJson(response, 500_000);
  if (body.success !== true || !Array.isArray(body.result))
    throw new Error('CLOUDFLARE_EVIDENCE_UNAVAILABLE: occurrence response changed');

  for (let index = 0; index < body.result.length && index < 5; index += 1) {
    const occurrence = object(body.result[index]);
    const worker = object(occurrence.worker);
    const invocation = object(occurrence.invocation);
    const scriptVersion = object(worker.scriptVersion).id;
    const route = safeRoute(invocation.url, SOURCE_HOSTS[identity.project] ?? []);
    const timestamp = occurrence.timestamp;
    if (
      worker.scriptName !== identity.project ||
      typeof scriptVersion !== 'string' ||
      !VERSION_ID.test(scriptVersion) ||
      invocation.method !== 'GET' ||
      route === null ||
      route.includes('REDACTED') ||
      invocation.path !== route ||
      typeof invocation.rayId !== 'string' ||
      !RAY_ID.test(invocation.rayId) ||
      typeof invocation.traceId !== 'string' ||
      !TRACE_ID.test(invocation.traceId) ||
      !Number.isSafeInteger(timestamp) ||
      (timestamp as number) < Date.now() - EVIDENCE_RETENTION_MS ||
      (timestamp as number) > Date.now() + 60_000
    )
      continue;

    const stub = env.ERROR_ISSUES.get(env.ERROR_ISSUES.idFromName(tailKey(identity.project, invocation.rayId)));
    const storedTail = await stub.fetch('https://error-dispatch.internal/tail');
    if (!storedTail.ok) {
      await storedTail.body?.cancel();
      continue;
    }
    const tail = object(await storedTail.json());
    if (
      tail.version !== 1 ||
      tail.workerName !== identity.project ||
      tail.rayId !== invocation.rayId ||
      tail.scriptVersion !== scriptVersion ||
      tail.route !== route ||
      !Number.isSafeInteger(tail.eventTimestamp) ||
      Math.abs((tail.eventTimestamp as number) - (timestamp as number)) > 120_000 ||
      !Array.isArray(tail.frames) ||
      tail.frames.length === 0 ||
      tail.frames.length > 12
    )
      continue;
    const frames = tail.frames.map((value) => object(value));
    if (
      frames.some(
        (frame) =>
          typeof frame.path !== 'string' ||
          !frame.path.startsWith(`apps/${identity.app}/src/`) ||
          frame.path.includes('..') ||
          !Number.isSafeInteger(frame.line) ||
          !Number.isSafeInteger(frame.column),
      )
    )
      continue;

    const version = await fetch(`${api}/workers/workers/${identity.project}/versions/${scriptVersion}`, {
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    if (version.status === 404) {
      await version.body?.cancel();
      continue;
    }
    const versionBody = await boundedJson(version, 100_000);
    if (versionBody.success !== true || object(versionBody.result).id !== scriptVersion)
      throw new Error('CLOUDFLARE_EVIDENCE_UNAVAILABLE: source version mismatch');

    const telemetryResponse = await fetch(`${api}/workers/observability/telemetry/query`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        queryId: 'koin-autofix-trace-evidence',
        view: 'events',
        limit: 30,
        timeframe: { from: (timestamp as number) - 60_000, to: (timestamp as number) + 60_000 },
        parameters: {
          datasets: ['cloudflare-workers'],
          filterCombination: 'and',
          filters: [
            { key: '$metadata.service', operation: 'eq', type: 'string', value: identity.project },
            { key: '$metadata.traceId', operation: 'eq', type: 'string', value: invocation.traceId },
          ],
        },
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
    const telemetry = await boundedJson(telemetryResponse, 500_000);
    const events = object(object(telemetry.result).events).events;
    if (
      telemetry.success !== true ||
      !Array.isArray(events) ||
      !events.some((event) => {
        try {
          const item = object(event);
          const metadata = object(item.$metadata);
          const producer = object(item.$workers);
          return (
            metadata.account === CF_ACCOUNT &&
            metadata.service === identity.project &&
            metadata.traceId === invocation.traceId &&
            metadata.rayId === invocation.rayId &&
            producer.scriptName === identity.project &&
            object(producer.scriptVersion).id === scriptVersion
          );
        } catch {
          return false;
        }
      })
    )
      continue;

    return {
      route,
      requestMethod: 'GET',
      data: {
        source: 'cloudflare',
        issueId: identity.sourceId,
        workerName: identity.project,
        scriptVersion,
        summary: stored.summary,
        sourceFrames: frames.map((frame) => ({ path: frame.path, line: frame.line, column: frame.column })),
      },
    };
  }
  throw new Error(
    'CLOUDFLARE_EVIDENCE_UNAVAILABLE: no matching mapped Tail frame, GET route and pinned source version',
  );
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
    if (details.verifiedEvidence !== undefined) {
      const proof = object(details.verifiedEvidence);
      const data = object(proof.data);
      if (
        proof.requestMethod !== 'GET' ||
        typeof proof.route !== 'string' ||
        !/^\/[A-Za-z0-9_/-]*$/.test(proof.route) ||
        proof.route.startsWith('//') ||
        data.source !== 'cloudflare' ||
        data.issueId !== identity.sourceId ||
        data.workerName !== identity.project ||
        !Array.isArray(data.sourceFrames) ||
        !data.sourceFrames.length ||
        data.sourceFrames.length > 12
      )
        throw new Error('Persisted Cloudflare evidence mismatch');
      return { route: proof.route, requestMethod: 'GET', data };
    }
    return cloudflareEvidence(env, identity, stored);
  }
  if (!env.SENTRY_READ_TOKEN) throw new Error('Missing Sentry read credential');
  const url = `https://sentry.io/api/0/organizations/${identity.scope.organization}/issues/${identity.sourceId}/`;
  const get = (suffix: string) =>
    fetch(url + suffix, {
      headers: { Authorization: `Bearer ${env.SENTRY_READ_TOKEN}` },
      signal: AbortSignal.timeout(30000),
      redirect: 'manual',
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
