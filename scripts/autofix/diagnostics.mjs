import { exactKeys, marker, safeRoute, validateDispatch } from './common.mjs';

export function redact(value, max = 2000) {
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
      // eslint-disable-next-line no-control-regex -- 진단 본문에 섞이면 안 되는 제어 문자를 제거하는 것이 목적이다
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .slice(0, max)
  );
}

export async function boundedJson(response, max = 2_000_000) {
  if (!response.ok) throw new Error(`Diagnostic API returned ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > max) throw new Error('Diagnostic exceeds limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function diagnosticUrl(origin, identity) {
  const url = new URL(origin);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.port
  )
    throw new Error('Configure an exact HTTPS diagnostic origin');
  url.pathname = `/diagnostics/${identity.source}/${identity.sourceId}`;
  url.searchParams.set('project', identity.project);
  for (const [key, value] of Object.entries(identity.scope)) url.searchParams.set(key, value);
  return url;
}

export function sentryDiagnostics(identity, canonical, event, hosts) {
  if (
    String(canonical.id) !== identity.sourceId ||
    canonical.project?.slug !== identity.project ||
    event.platform !== 'javascript' ||
    event.sdk?.name !== 'sentry.javascript.react' ||
    (event.groupID !== undefined && String(event.groupID) !== identity.sourceId)
  )
    throw new Error('Canonical Sentry browser identity mismatch');
  const request = event.entries?.find((entry) => entry.type === 'request')?.data;
  const route = safeRoute(request?.url, hosts);
  const exceptions = (event.entries ?? [])
    .filter((entry) => entry.type === 'exception')
    .flatMap((entry) => entry.data?.values ?? [])
    .slice(0, 5)
    .map((value) => ({
      type: redact(value.type, 200),
      value: redact(value.value),
      frames: (value.stacktrace?.frames ?? []).slice(-40).flatMap((frame) => {
        if (frame.inApp !== true || typeof frame.filename !== 'string') return [];
        const filename = frame.filename.replace(/^app:\/\/\//, '').replace(/^\.\//, '');
        if (
          !/^(?:apps\/web\/)?src\/[A-Za-z0-9_/$().-]+\.(?:tsx?|jsx?)$/.test(filename) ||
          filename.split('/').some((part) => part === '..') ||
          !Number.isSafeInteger(frame.lineNo) ||
          frame.lineNo < 1
        )
          return [];
        return [
          {
            filename,
            function: redact(frame.function, 300),
            lineNo: frame.lineNo,
            colNo: Number.isSafeInteger(frame.colNo) && frame.colNo >= 0 ? frame.colNo : null,
            inApp: true,
          },
        ];
      }),
    }));
  if (!route || !exceptions.some((exception) => exception.frames.length))
    throw new Error('No safe browser route and application source frame; manual reproduction required');
  return {
    ...identity,
    title: redact(canonical.title),
    culprit: redact(canonical.culprit),
    eventId: /^[a-f0-9]{32}$/.test(event.eventID ?? '') ? event.eventID : null,
    platform: 'javascript',
    exceptions,
    route,
    requestMethod: 'GET',
  };
}

export function redactData(value, depth = 0) {
  if (depth > 6) return '[depth limit]';
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))
    return value;
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => redactData(item, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 50)
        .filter(
          ([key]) =>
            !/(?:authorization|cookie|password|secret|token|api.?key|headers|body|user|email|ip.address|source.?context)/i.test(
              key,
            ),
        )
        .map(([key, item]) => [redact(key, 100), redactData(item, depth + 1)]),
    );
  return null;
}

export function cloudflareDiagnostics(identity, record, config) {
  if (
    !exactKeys(record, ['version', 'identity', 'capturedAt', 'summary', 'details']) ||
    record.version !== 1 ||
    marker(
      validateDispatch({ action: 'error-autofix', client_payload: record.identity }, 'repository_dispatch', config),
    ) !== marker(identity) ||
    record.identity.app !== identity.app ||
    typeof record.capturedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.capturedAt))
  )
    throw new Error('Stored Cloudflare identity mismatch');
  if (
    !exactKeys(record.details, ['alertType', 'timestamp', 'data']) ||
    typeof record.details.alertType !== 'string' ||
    !/^[A-Za-z0-9_.-]{1,100}$/.test(record.details.alertType) ||
    !Number.isSafeInteger(record.details.timestamp) ||
    record.details.timestamp < 0 ||
    !record.details.data ||
    typeof record.details.data !== 'object' ||
    Array.isArray(record.details.data)
  )
    throw new Error('Unsupported Cloudflare diagnostic contract');
  return {
    ...identity,
    title: redact(record.summary),
    capturedAt: record.capturedAt,
    alertType: record.details.alertType,
    data: redactData(record.details.data),
    exceptions: [],
    route: null,
    requestMethod: null,
  };
}
