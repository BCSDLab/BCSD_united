export interface Env {
  ENVIRONMENT: 'production' | 'preview';
  PREVIEW_GITHUB_OWNER?: string;
  PREVIEW_GITHUB_REPOSITORY?: string;
  PREVIEW_GITHUB_DISPATCH_TOKEN?: string;
  SENTRY_CLIENT_SECRET: string;
  SENTRY_ORGANIZATION: string;
  SENTRY_PROJECT_APPS: string;
  CLOUDFLARE_WEBHOOK_SECRET: string;
  CLOUDFLARE_SOURCES: string;
  DIAGNOSTICS_READ_TOKEN: string;
  GITHUB_OWNER: string;
  GITHUB_REPOSITORY: string;
  GITHUB_DISPATCH_TOKEN: string;
  ERROR_ISSUES: DurableObjectNamespace;
}

type App = 'web' | 'api';
type Identity =
  | { source: 'sentry'; sourceId: string; project: string; app: 'web'; scope: { organization: string } }
  | {
      source: 'cloudflare';
      sourceId: string;
      project: string;
      app: App;
      scope: { accountId: string; policyId: string; workerName: string };
    };

interface CloudflareSource {
  accountId: string;
  policyId: string;
  workerName: string;
  app: App;
}

interface Configuration {
  organization: string;
  projects: Set<string>;
  cloudflare: CloudflareSource[];
  owner: string;
  repository: string;
  dispatchToken: string;
}

interface Diagnostic {
  version: 1;
  identity: Identity;
  capturedAt: string;
  summary: string;
  details: Record<string, unknown>;
}

interface DispatchResult {
  status: number;
  body: Record<string, string | number>;
}

const MAX_BODY_BYTES = 1024 * 1024;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DECIMAL_ID = /^[1-9][0-9]{0,39}$/;
const SENTRY_SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/;
const WORKER_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const ACCOUNT_ID = /^[a-f0-9]{32}$/;
const encoder = new TextEncoder();

class RequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestError(400, 'Expected a JSON object.');
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RequestError(400, `Missing or invalid ${name}.`);
  }
  return value;
}

function uuid(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(value)
  ) {
    throw new RequestError(400, 'Expected a lowercase UUID.');
  }
  return value.replaceAll('-', '');
}

function configuration(env: Env): Configuration {
  try {
    if (env.ENVIRONMENT !== 'production' && env.ENVIRONMENT !== 'preview') {
      throw new Error('Missing deployment environment');
    }
    const preview = env.ENVIRONMENT === 'preview';
    const owner = preview ? env.PREVIEW_GITHUB_OWNER : env.GITHUB_OWNER;
    const repository = preview ? env.PREVIEW_GITHUB_REPOSITORY : env.GITHUB_REPOSITORY;
    const dispatchToken = preview ? env.PREVIEW_GITHUB_DISPATCH_TOKEN : env.GITHUB_DISPATCH_TOKEN;
    if (
      preview &&
      (`${owner}/${repository}`.toLowerCase() === 'bcsdlab/bcsd_united' ||
        `${owner}/${repository}`.toLowerCase() === `${env.GITHUB_OWNER}/${env.GITHUB_REPOSITORY}`.toLowerCase() ||
        dispatchToken === env.GITHUB_DISPATCH_TOKEN)
    ) {
      throw new Error('Preview requires a separate repository and credential');
    }
    const projects = record(JSON.parse(env.SENTRY_PROJECT_APPS));
    const sources: unknown = JSON.parse(env.CLOUDFLARE_SOURCES);
    if (
      !Array.isArray(sources) ||
      sources.length > 100 ||
      Object.entries(projects).some(([project, app]) => !SENTRY_SLUG.test(project) || app !== 'web') ||
      (Object.keys(projects).length > 0 && (!SENTRY_SLUG.test(env.SENTRY_ORGANIZATION) || !env.SENTRY_CLIENT_SECRET)) ||
      (sources.length > 0 && (env.CLOUDFLARE_WEBHOOK_SECRET?.length ?? 0) < 32) ||
      (Object.keys(projects).length === 0 && sources.length === 0) ||
      (env.DIAGNOSTICS_READ_TOKEN?.length ?? 0) < 32 ||
      !dispatchToken ||
      !owner ||
      !repository ||
      !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(owner) ||
      !/^[a-zA-Z0-9_.-]{1,100}$/.test(repository) ||
      repository === '.' ||
      repository === '..'
    ) {
      throw new Error('Invalid configuration');
    }
    const cloudflare = sources.map((value): CloudflareSource => {
      const source = record(value);
      if (
        Object.keys(source).sort().join(',') !== 'accountId,app,policyId,workerName' ||
        typeof source.accountId !== 'string' ||
        !ACCOUNT_ID.test(source.accountId) ||
        typeof source.workerName !== 'string' ||
        !WORKER_NAME.test(source.workerName) ||
        (source.app !== 'web' && source.app !== 'api')
      )
        throw new Error('Invalid source');
      return {
        accountId: source.accountId,
        policyId: uuid(source.policyId),
        workerName: source.workerName,
        app: source.app,
      };
    });
    if (new Set(cloudflare.map((source) => `${source.accountId}/${source.policyId}`)).size !== cloudflare.length) {
      throw new Error('Ambiguous policy');
    }
    return {
      organization: env.SENTRY_ORGANIZATION,
      projects: new Set(Object.keys(projects)),
      cloudflare,
      owner,
      repository,
      dispatchToken,
    };
  } catch {
    throw new RequestError(503, 'Configure provider allowlists, diagnostic read token, and GitHub repository/secrets.');
  }
}

function reply(status: number, body: Record<string, string | number>): Response {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      ...(status >= 500 ? { 'Retry-After': '30' } : {}),
    },
  });
}

async function boundedBody(request: Request): Promise<Uint8Array<ArrayBuffer>> {
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
    throw new RequestError(413, 'Webhook exceeds the 1 MiB body limit.');
  }
  if (!request.body) throw new RequestError(400, 'Webhook body is required.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new RequestError(413, 'Webhook exceeds the 1 MiB body limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function verifySignature(request: Request, body: Uint8Array<ArrayBuffer>, secret: string) {
  const signature = request.headers.get('Sentry-Hook-Signature');
  if (!signature || !/^[a-fA-F0-9]{64}$/.test(signature)) {
    throw new RequestError(401, 'Missing or malformed Sentry-Hook-Signature.');
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(signature.slice(i * 2, i * 2 + 2), 16);
  }
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'verify',
  ]);
  if (!(await crypto.subtle.verify('HMAC', key, bytes, body))) {
    throw new RequestError(401, 'Invalid Sentry webhook signature.');
  }
}

function sentryUrl(value: unknown, field: string): URL {
  let url: URL;
  try {
    url = new URL(requiredString(value, field));
  } catch {
    throw new RequestError(400, `Invalid ${field}.`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !(url.hostname === 'sentry.io' || /^[a-z0-9_-]+\.sentry\.io$/.test(url.hostname))
  ) {
    throw new RequestError(400, `Invalid Sentry URL in ${field}.`);
  }
  return url;
}

function issueOrganization(issue: Record<string, unknown>, issueId: string): string {
  const api = sentryUrl(issue.url, 'data.issue.url');
  const modern = /^\/api\/0\/organizations\/([a-z0-9_-]+)\/issues\/([1-9][0-9]*)\/$/.exec(api.pathname);
  if (modern) {
    if (modern[2] !== issueId) throw new RequestError(400, 'Issue URL and ID disagree.');
    return modern[1];
  }
  if (api.pathname !== `/api/0/issues/${issueId}/`) {
    throw new RequestError(400, 'Invalid issue API URL.');
  }
  const web = sentryUrl(issue.web_url ?? issue.permalink, 'data.issue.web_url');
  const legacy = /^\/organizations\/([a-z0-9_-]+)\/issues\/([1-9][0-9]*)\/$/.exec(web.pathname);
  if (legacy && legacy[2] === issueId) return legacy[1];
  const subdomain = /^([a-z0-9_-]+)\.sentry\.io$/.exec(web.hostname);
  if (subdomain && web.pathname === `/issues/${issueId}/`) return subdomain[1];
  throw new RequestError(400, 'Cannot identify the issue organization.');
}

function validateIdentity(value: unknown, config: Configuration): Identity {
  const data = record(value);
  const scope = record(data.scope);
  if (Object.keys(data).sort().join(',') !== 'app,project,scope,source,sourceId') {
    throw new RequestError(400, 'Unexpected identity fields.');
  }
  if (data.source === 'sentry') {
    if (
      typeof data.sourceId !== 'string' ||
      !DECIMAL_ID.test(data.sourceId) ||
      Object.keys(scope).join(',') !== 'organization'
    )
      throw new RequestError(400, 'Invalid Sentry identity.');
    if (
      scope.organization !== config.organization ||
      typeof data.project !== 'string' ||
      !config.projects.has(data.project) ||
      data.app !== 'web'
    )
      throw new RequestError(403, 'Sentry scope is not allowlisted.');
    return {
      source: 'sentry',
      sourceId: data.sourceId,
      project: data.project,
      app: 'web',
      scope: { organization: config.organization },
    };
  }
  if (data.source === 'cloudflare') {
    const sourceId = uuid(data.sourceId);
    if (Object.keys(scope).sort().join(',') !== 'accountId,policyId,workerName') {
      throw new RequestError(400, 'Invalid Cloudflare scope.');
    }
    const policyId = uuid(scope.policyId);
    const source = config.cloudflare.find((item) => item.accountId === scope.accountId && item.policyId === policyId);
    if (
      !source ||
      scope.workerName !== source.workerName ||
      data.project !== source.workerName ||
      data.app !== source.app
    ) {
      throw new RequestError(403, 'Cloudflare scope is not allowlisted.');
    }
    return {
      source: 'cloudflare',
      sourceId,
      project: source.workerName,
      app: source.app,
      scope: { accountId: source.accountId, policyId, workerName: source.workerName },
    };
  }
  throw new RequestError(400, 'Unsupported error source.');
}

function redact(value: unknown, env: Env): string {
  if (typeof value !== 'string') return '';
  let text = value;
  for (const secret of [
    env.SENTRY_CLIENT_SECRET,
    env.CLOUDFLARE_WEBHOOK_SECRET,
    env.DIAGNOSTICS_READ_TOKEN,
    env.GITHUB_DISPATCH_TOKEN,
    env.PREVIEW_GITHUB_DISPATCH_TOKEN,
  ]) {
    if (secret) text = text.replaceAll(secret, '[REDACTED]');
  }
  return (
    text
      .replace(/https?:\/\/[^\s<>"')]+/gi, '[URL]')
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '[AUTH]')
      .replace(/\b(?:authorization|cookie)\b["']?\s*[:=][^\r\n]*/gi, '[REDACTED]')
      .replace(
        /\b(?:password|passwd|secret|token|api[_-]?key|session[_-]?id)\b["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
        '[REDACTED]',
      )
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]')
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[IP]')
      .replace(/\b(?:[a-f0-9]{0,4}:){2,}[a-f0-9:]{0,39}\b/gi, '[IP]')
      .replace(/\b[A-Za-z0-9_+/=-]{24,}\b/g, '[OPAQUE]')
      // eslint-disable-next-line no-control-regex -- 이슈 본문에 섞이면 안 되는 제어 문자를 제거하는 것이 목적이다
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
      .slice(0, 4096)
  );
}

function diagnostic(identity: Identity, summary: unknown, details: Record<string, unknown>, env: Env): Diagnostic {
  return { version: 1, identity, capturedAt: new Date().toISOString(), summary: redact(summary, env), details };
}

function sentryPayload(resource: string | null, raw: unknown, config: Configuration, env: Env): Diagnostic | null {
  const webhook = record(raw);
  if (resource === 'issue') {
    if (webhook.action !== 'created' && webhook.action !== 'unresolved') return null;
    const issue = record(record(webhook.data).issue);
    // Sentry는 회귀를 별도 action이 아닌 `unresolved`와 `regressed` substatus로 알린다.
    if (webhook.action === 'unresolved' && issue.substatus !== 'regressed') return null;
    const sourceId = requiredString(issue.id, 'data.issue.id');
    const identity = validateIdentity(
      {
        source: 'sentry',
        sourceId,
        app: 'web',
        project: requiredString(record(issue.project).slug, 'data.issue.project.slug'),
        scope: { organization: issueOrganization(issue, sourceId) },
      },
      config,
    );
    return diagnostic(identity, issue.title, { resource: 'issue', action: webhook.action }, env);
  }
  if (resource === 'event_alert' && webhook.action === 'triggered') {
    const event = record(record(webhook.data).event);
    const url = sentryUrl(event.url, 'data.event.url');
    const match = /^\/api\/0\/projects\/([a-z0-9_-]+)\/([a-z0-9_-]+)\/events\/[a-fA-F0-9]{32}\/$/.exec(url.pathname);
    if (!match) throw new RequestError(400, 'Invalid Sentry event API URL.');
    const identity = validateIdentity(
      {
        source: 'sentry',
        sourceId: requiredString(event.issue_id, 'data.event.issue_id'),
        project: match[2],
        app: 'web',
        scope: { organization: match[1] },
      },
      config,
    );
    return diagnostic(identity, event.message, { resource: 'event_alert', action: 'triggered' }, env);
  }
  return null;
}

function redactData(value: unknown, env: Env): unknown {
  let remaining = 6000;
  function visit(item: unknown, depth: number): unknown {
    if (remaining <= 0 || depth > 5) return '[TRUNCATED]';
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number') return Number.isFinite(item) ? item : null;
    if (typeof item === 'string') {
      const text = redact(item, env).slice(0, Math.min(1024, remaining));
      remaining -= encoder.encode(JSON.stringify(text)).length;
      return text;
    }
    if (Array.isArray(item)) {
      const values = item.slice(0, 20).map((child) => visit(child, depth + 1));
      if (item.length > 20) values.push('[TRUNCATED]');
      return values;
    }
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record(item)).slice(0, 30)) {
      if (
        !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(key) ||
        /(?:password|passwd|secret|token|authorization|cookie|header|request|response|body|payload|user|email|address|session|context|extra|url|route|ip_address|api.?key)/i.test(
          key,
        )
      )
        continue;
      remaining -= key.length + 4;
      result[key] = visit(child, depth + 1);
    }
    if (Object.keys(record(item)).length > 30) result.truncated = true;
    return result;
  }
  const result = visit(value, 0);
  return encoder.encode(JSON.stringify(result)).length <= 8192 ? result : { truncated: true };
}

function cloudflarePayload(raw: unknown, config: Configuration, env: Env): Diagnostic | null {
  const webhook = record(raw);
  const policyId = uuid(webhook.policy_id);
  const source = config.cloudflare.find((item) => item.accountId === webhook.account_id && item.policyId === policyId);
  if (!source) throw new RequestError(403, 'Cloudflare account or policy is not allowlisted.');
  const identity = validateIdentity(
    {
      source: 'cloudflare',
      sourceId: uuid(webhook.alert_correlation_id),
      project: source.workerName,
      app: source.app,
      scope: { accountId: source.accountId, policyId, workerName: source.workerName },
    },
    config,
  );
  if (
    !Number.isSafeInteger(webhook.ts) ||
    (webhook.ts as number) < 0 ||
    typeof webhook.text !== 'string' ||
    typeof webhook.alert_type !== 'string' ||
    !/^[a-zA-Z0-9_.-]{1,100}$/.test(webhook.alert_type) ||
    (webhook.alert_event !== undefined && (typeof webhook.alert_event !== 'string' || webhook.alert_event.length > 100))
  ) {
    throw new RequestError(400, 'Invalid notification envelope.');
  }
  const data = record(webhook.data);
  // Worker는 배포 설정의 Issues policy로 결정한다. 문서화되지 않은 data 필드는 식별 근거로 쓰지 않는다.
  if (webhook.alert_event === 'ALERT_STATE_EVENT_END') return null;
  return diagnostic(
    identity,
    webhook.text,
    { alertType: webhook.alert_type, timestamp: webhook.ts, data: redactData(data, env) },
    env,
  );
}

async function verifySecret(value: string | null, secret: string): Promise<void> {
  if (!value || value.length > 4096 || !secret) throw new RequestError(401, 'Missing or invalid authentication.');
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(secret));
  if (!(await crypto.subtle.verify('HMAC', key, signature, encoder.encode(value)))) {
    throw new RequestError(401, 'Missing or invalid authentication.');
  }
}

function identityKey(identity: Identity): string {
  return identity.source === 'sentry'
    ? `sentry/${identity.scope.organization}/${identity.project}/${identity.sourceId}`
    : `cloudflare/${identity.scope.accountId}/${identity.scope.policyId}/${identity.project}/${identity.sourceId}`;
}

function retrievalIdentity(url: URL, config: Configuration): Identity {
  const match = /^\/diagnostics\/(sentry|cloudflare)\/([^/]+)$/.exec(url.pathname);
  if (!match) throw new RequestError(404, 'Not found.');
  const fields =
    match[1] === 'sentry' ? ['organization', 'project'] : ['accountId', 'policyId', 'project', 'workerName'];
  const entries = [...url.searchParams.keys()];
  if (
    entries.length !== fields.length ||
    entries.some((key) => !fields.includes(key)) ||
    fields.some((key) => url.searchParams.getAll(key).length !== 1)
  )
    throw new RequestError(400, 'Invalid diagnostic scope.');
  const project = url.searchParams.get('project');
  if (match[1] === 'sentry')
    return validateIdentity(
      {
        source: 'sentry',
        sourceId: match[2],
        project,
        app: 'web',
        scope: { organization: url.searchParams.get('organization') },
      },
      config,
    );
  const policyId = uuid(url.searchParams.get('policyId'));
  const source = config.cloudflare.find(
    (item) => item.accountId === url.searchParams.get('accountId') && item.policyId === policyId,
  );
  return validateIdentity(
    {
      source: 'cloudflare',
      sourceId: match[2],
      project,
      app: source?.app,
      scope: { accountId: url.searchParams.get('accountId'), policyId, workerName: url.searchParams.get('workerName') },
    },
    config,
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.protocol !== 'https:') throw new RequestError(400, 'HTTPS is required.');
      const retrieval = url.pathname.startsWith('/diagnostics/');
      if (!retrieval && !['/webhooks/sentry', '/webhooks/cloudflare'].includes(url.pathname))
        return reply(404, { error: 'Not found.' });
      const method = retrieval ? 'GET' : 'POST';
      if (request.method !== method) return new Response(`Use ${method}.`, { status: 405, headers: { Allow: method } });
      const config = configuration(env);
      if (retrieval) {
        const authorization = request.headers.get('Authorization');
        await verifySecret(
          authorization?.startsWith('Bearer ') ? authorization.slice(7) : null,
          env.DIAGNOSTICS_READ_TOKEN,
        );
        const identity = retrievalIdentity(url, config);
        return await env.ERROR_ISSUES.get(env.ERROR_ISSUES.idFromName(identityKey(identity))).fetch(
          'https://error-dispatch.internal/diagnostics',
        );
      }
      if (url.search) throw new RequestError(400, 'Webhook query parameters are not supported.');
      if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new RequestError(415, 'Content-Type must be application/json.');
      }
      const body = await boundedBody(request);
      if (url.pathname === '/webhooks/sentry') await verifySignature(request, body, env.SENTRY_CLIENT_SECRET);
      else await verifySecret(request.headers.get('cf-webhook-auth'), env.CLOUDFLARE_WEBHOOK_SECRET);
      let json: unknown;
      try {
        json = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body));
      } catch {
        throw new RequestError(400, 'Webhook must contain valid UTF-8 JSON.');
      }
      const capture =
        url.pathname === '/webhooks/sentry'
          ? sentryPayload(request.headers.get('Sentry-Hook-Resource'), json, config, env)
          : cloudflarePayload(json, config, env);
      if (!capture) return reply(200, { status: 'ignored' });
      const stub = env.ERROR_ISSUES.get(env.ERROR_ISSUES.idFromName(identityKey(capture.identity)));
      return await stub.fetch('https://error-dispatch.internal/', { method: 'POST', body: JSON.stringify(capture) });
    } catch (error) {
      if (error instanceof RequestError) return reply(error.status, { error: error.message });
      return reply(503, { error: 'Webhook processing failed; retry this delivery.' });
    }
  },
} satisfies ExportedHandler<Env>;

export class ErrorIssueDispatch {
  private state: DurableObjectState;
  private env: Env;
  private pending: Promise<DispatchResult> | undefined;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS dispatch (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      identity_key TEXT NOT NULL,
      diagnostic TEXT,
      expires_at INTEGER NOT NULL,
      accepted_at TEXT
    )`);
  }

  async alarm(): Promise<void> {
    this.state.storage.sql.exec('UPDATE dispatch SET diagnostic = NULL WHERE expires_at <= ?', Date.now());
    await this.state.storage.sync();
  }

  async fetch(request: Request): Promise<Response> {
    try {
      if (request.method === 'GET' && new URL(request.url).pathname === '/diagnostics') {
        const rows = this.state.storage.sql
          .exec('SELECT diagnostic, expires_at FROM dispatch WHERE singleton = 1')
          .toArray();
        const row = rows[0];
        if (!row || !row.diagnostic || Number(row.expires_at) <= Date.now())
          return reply(404, { error: 'Diagnostic not found or expired.' });
        return new Response(String(row.diagnostic), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/')
        return reply(404, { error: 'Not found.' });
      const config = configuration(this.env);
      const data = record(await request.json());
      const identity = validateIdentity(data.identity, config);
      const capture = diagnostic(identity, data.summary, record(data.details), this.env);
      if (encoder.encode(JSON.stringify(capture)).length > 16 * 1024)
        throw new RequestError(413, 'Diagnostic is too large.');
      // 진행 중 요청을 공유하여 GitHub 수락 전 중복 전달도 한 번만 전송한다.
      if (!this.pending)
        this.pending = this.dispatch(capture, config).finally(() => {
          this.pending = undefined;
        });
      const result = await this.pending;
      return reply(result.status, result.body);
    } catch (error) {
      if (error instanceof RequestError) return reply(error.status, { error: error.message });
      return reply(503, { error: 'Dispatch state unavailable; retry this delivery.' });
    }
  }

  private async dispatch(capture: Diagnostic, config: Configuration): Promise<DispatchResult> {
    const rows = this.state.storage.sql
      .exec('SELECT identity_key, accepted_at FROM dispatch WHERE singleton = 1')
      .toArray();
    const key = identityKey(capture.identity);
    if (rows[0] && rows[0].identity_key !== key) throw new RequestError(409, 'Identity conflicts with durable state.');
    if (rows[0]?.accepted_at) return { status: 200, body: { status: 'duplicate' } };
    const expiresAt = Date.now() + RETENTION_MS;
    this.state.storage.sql.exec(
      `INSERT INTO dispatch (singleton, identity_key, diagnostic, expires_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET diagnostic = excluded.diagnostic, expires_at = excluded.expires_at`,
      key,
      JSON.stringify(capture),
      expiresAt,
    );
    await this.state.storage.setAlarm(expiresAt);
    // prepare 작업이 즉시 읽을 수 있도록 dispatch 전에 진단 기록을 영속한다.
    await this.state.storage.sync();
    let response: Response;
    try {
      response = await fetch(`https://api.github.com/repos/${config.owner}/${config.repository}/dispatches`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
        headers: {
          Authorization: `Bearer ${config.dispatchToken}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'koin-error-automation',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ event_type: 'error-autofix', client_payload: capture.identity }),
      });
    } catch {
      return { status: 502, body: { error: 'GitHub dispatch could not be confirmed; retry this delivery.' } };
    }
    if (response.status !== 204) {
      await response.body?.cancel();
      return {
        status: 502,
        body: {
          error: 'GitHub rejected dispatch; check dispatch-token permissions and retry.',
          upstreamStatus: response.status,
        },
      };
    }
    this.state.storage.sql.exec('UPDATE dispatch SET accepted_at = ? WHERE singleton = 1', new Date().toISOString());
    await this.state.storage.sync();
    return { status: 200, body: { status: 'dispatched' } };
  }
}
