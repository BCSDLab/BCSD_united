export interface Env {
  SENTRY_CLIENT_SECRET: string;
  SENTRY_ORGANIZATION: string;
  SENTRY_PROJECTS: string;
  GITHUB_OWNER: string;
  GITHUB_REPOSITORY: string;
  GITHUB_DISPATCH_TOKEN: string;
  SENTRY_ISSUES: DurableObjectNamespace;
}

interface DispatchPayload {
  sentryIssueId: string;
  sentryProject: string;
  sentryOrganization: string;
}

interface Configuration {
  organization: string;
  projects: Set<string>;
  owner: string;
  repository: string;
}

interface DispatchResult {
  status: number;
  body: Record<string, string | number>;
}

const MAX_BODY_BYTES = 1024 * 1024;
const DECIMAL_ID = /^[1-9][0-9]{0,39}$/;
const SENTRY_SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/;
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

function configuration(env: Env): Configuration {
  const projects = typeof env.SENTRY_PROJECTS === 'string'
    ? env.SENTRY_PROJECTS.split(',').map((project) => project.trim())
    : [];
  if (!env.SENTRY_CLIENT_SECRET || !env.GITHUB_DISPATCH_TOKEN
    || !SENTRY_SLUG.test(env.SENTRY_ORGANIZATION ?? '')
    || projects.length === 0 || projects.some((project) => !SENTRY_SLUG.test(project))
    || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(env.GITHUB_OWNER ?? '')
    || !/^[a-zA-Z0-9_.-]{1,100}$/.test(env.GITHUB_REPOSITORY ?? '')
    || env.GITHUB_REPOSITORY === '.' || env.GITHUB_REPOSITORY === '..') {
    throw new RequestError(503, 'Configure Sentry organization/projects and GitHub repository/secrets.');
  }
  return {
    organization: env.SENTRY_ORGANIZATION,
    projects: new Set(projects),
    owner: env.GITHUB_OWNER,
    repository: env.GITHUB_REPOSITORY,
  };
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
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
  );
  if (!await crypto.subtle.verify('HMAC', key, bytes, body)) {
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
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || url.search || url.hash
    || !(url.hostname === 'sentry.io' || /^[a-z0-9_-]+\.sentry\.io$/.test(url.hostname))) {
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

function validatePayload(payload: DispatchPayload, config: Configuration): DispatchPayload {
  if (typeof payload.sentryIssueId !== 'string' || !DECIMAL_ID.test(payload.sentryIssueId)) {
    throw new RequestError(400, 'Sentry issue ID must be a positive decimal string.');
  }
  if (payload.sentryOrganization !== config.organization || !config.projects.has(payload.sentryProject)) {
    throw new RequestError(403, 'Sentry organization or project is not allowlisted.');
  }
  return {
    sentryIssueId: payload.sentryIssueId,
    sentryProject: payload.sentryProject,
    sentryOrganization: config.organization,
  };
}

function webhookPayload(resource: string | null, raw: unknown, config: Configuration): DispatchPayload | null {
  const webhook = record(raw);
  if (resource === 'issue') {
    if (webhook.action !== 'created' && webhook.action !== 'unresolved') return null;
    const issue = record(record(webhook.data).issue);
    // Sentry는 회귀를 별도 action이 아닌 `unresolved`와 `regressed` substatus로 알린다.
    if (webhook.action === 'unresolved' && issue.substatus !== 'regressed') return null;
    const issueId = requiredString(issue.id, 'data.issue.id');
    return validatePayload({
      sentryIssueId: issueId,
      sentryProject: requiredString(record(issue.project).slug, 'data.issue.project.slug'),
      sentryOrganization: issueOrganization(issue, issueId),
    }, config);
  }
  if (resource === 'event_alert' && webhook.action === 'triggered') {
    const event = record(record(webhook.data).event);
    const url = sentryUrl(event.url, 'data.event.url');
    const match = /^\/api\/0\/projects\/([a-z0-9_-]+)\/([a-z0-9_-]+)\/events\/[a-fA-F0-9]{32}\/$/.exec(url.pathname);
    if (!match) throw new RequestError(400, 'Invalid Sentry event API URL.');
    return validatePayload({
      sentryIssueId: requiredString(event.issue_id, 'data.event.issue_id'),
      sentryProject: match[2],
      sentryOrganization: match[1],
    }, config);
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== '/webhooks/sentry') return reply(404, { error: 'Not found.' });
    if (request.method !== 'POST') {
      return new Response('Use POST.', { status: 405, headers: { Allow: 'POST' } });
    }
    try {
      const config = configuration(env);
      if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new RequestError(415, 'Content-Type must be application/json.');
      }
      const body = await boundedBody(request);
      await verifySignature(request, body, env.SENTRY_CLIENT_SECRET);
      let json: unknown;
      try {
        json = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body));
      } catch {
        throw new RequestError(400, 'Webhook must contain valid UTF-8 JSON.');
      }
      const payload = webhookPayload(request.headers.get('Sentry-Hook-Resource'), json, config);
      if (!payload) return reply(200, { status: 'ignored' });
      const key = `${payload.sentryOrganization}/${payload.sentryProject}/${payload.sentryIssueId}`;
      const stub = env.SENTRY_ISSUES.get(env.SENTRY_ISSUES.idFromName(key));
      // GitHub 수락과 중복 방지 기록을 끝낸 뒤에만 성공을 반환한다.
      return await stub.fetch('https://sentry-dispatch.internal/', {
        method: 'POST', body: JSON.stringify(payload),
      });
    } catch (error) {
      if (error instanceof RequestError) return reply(error.status, { error: error.message });
      return reply(503, { error: 'Webhook processing failed; retry this delivery.' });
    }
  },
} satisfies ExportedHandler<Env>;

export class SentryIssueDispatch {
  private state: DurableObjectState;
  private env: Env;
  private pending: Promise<DispatchResult> | undefined;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS dispatch (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      issue_id TEXT NOT NULL,
      project TEXT NOT NULL,
      organization TEXT NOT NULL,
      accepted_at TEXT NOT NULL
    )`);
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const config = configuration(this.env);
      const data = record(await request.json());
      const payload = validatePayload({
        sentryIssueId: requiredString(data.sentryIssueId, 'sentryIssueId'),
        sentryProject: requiredString(data.sentryProject, 'sentryProject'),
        sentryOrganization: requiredString(data.sentryOrganization, 'sentryOrganization'),
      }, config);
      // await 사이에 들어오는 동일 이슈 요청은 진행 중인 dispatch의 결과를 공유한다.
      if (!this.pending) {
        this.pending = this.dispatch(payload, config).finally(() => { this.pending = undefined; });
      }
      const result = await this.pending;
      return reply(result.status, result.body);
    } catch (error) {
      if (error instanceof RequestError) return reply(error.status, { error: error.message });
      return reply(503, { error: 'Dispatch state unavailable; retry this delivery.' });
    }
  }

  private async dispatch(payload: DispatchPayload, config: Configuration): Promise<DispatchResult> {
    const completed = this.state.storage.sql.exec('SELECT issue_id FROM dispatch WHERE singleton = 1').toArray();
    if (completed.length > 0) return { status: 200, body: { status: 'duplicate' } };
    let response: Response;
    try {
      response = await fetch(`https://api.github.com/repos/${config.owner}/${config.repository}/dispatches`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
        headers: {
          Authorization: `Bearer ${this.env.GITHUB_DISPATCH_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'koin-sentry-automation',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ event_type: 'sentry-autofix', client_payload: payload }),
      });
    } catch {
      return { status: 502, body: { error: 'GitHub dispatch could not be confirmed; retry this delivery.' } };
    }
    if (response.status !== 204) {
      await response.body?.cancel();
      return {
        status: 502,
        body: { error: 'GitHub rejected dispatch; check dispatch-token permissions and retry.', upstreamStatus: response.status },
      };
    }
    this.state.storage.sql.exec(
      'INSERT INTO dispatch (singleton, issue_id, project, organization, accepted_at) VALUES (1, ?, ?, ?, ?)',
      payload.sentryIssueId, payload.sentryProject, payload.sentryOrganization, new Date().toISOString(),
    );
    await this.state.storage.sync();
    return { status: 200, body: { status: 'dispatched' } };
  }
}
