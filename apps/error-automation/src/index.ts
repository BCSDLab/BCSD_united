import { DurableObject } from 'cloudflare:workers';
import { DiagnosticProviderError, trustedDiagnostics } from './diagnostics';
import { SourceMapEvidenceError } from './source-maps';
import { gatewayTransport, modelRateLimit, parseModelRequest } from './model';
import { extractTailEvidence, isBundlePath, sourcePath, tailKey } from './tail';
import type { App, Diagnostic, Env, Identity, PatchManifest } from './types';
export type { Env } from './types';
export { AutofixQueue } from './queue';
import { isPolicyRejection, type AutofixQueue, type ExecutorResult } from './queue';
import { GitHubError, installationToken } from './github';
import {
  PullRequestRejected,
  assertPinned,
  inspectPullRequest,
  parsePullRequestIdentity,
  pullRequestPolicy,
} from './pull-request';

interface CloudflareSource {
  accountId: string;
  policyId: string;
  workerName: string;
  app: App;
}

export interface Configuration {
  organization: string;
  projects: Set<string>;
  cloudflare: CloudflareSource[];
  owner: string;
  repository: string;
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
const CLOUDFLARE_TEST_PROBES: Record<string, true> = {
  'Hello World! This is a test message sent from https://cloudflare.com. If you can see this, your webhook is configured properly.': true,
  'Hello World! This is a test message sent from https://cloudflare.com. If you can see this, your webhook is configured correctly.': true,
};

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

export function configuration(env: Env): Configuration {
  try {
    if (env.ENVIRONMENT !== 'production') throw new Error('Only the fixed production installation is enabled');
    const owner = env.GITHUB_OWNER;
    const repository = env.GITHUB_REPOSITORY;
    const dispatchApp = {
      id: env.GITHUB_DISPATCH_APP_ID,
      privateKey: env.GITHUB_DISPATCH_APP_PRIVATE_KEY,
      installationId: env.GITHUB_DISPATCH_INSTALLATION_ID,
    };
    const projects = record(JSON.parse(env.SENTRY_PROJECT_APPS));
    const sources: unknown = JSON.parse(env.CLOUDFLARE_SOURCES);
    if (
      !Array.isArray(sources) ||
      sources.length > 100 ||
      Object.entries(projects).some(([project, app]) => !SENTRY_SLUG.test(project) || app !== 'web') ||
      (Object.keys(projects).length > 0 && (!SENTRY_SLUG.test(env.SENTRY_ORGANIZATION) || !env.SENTRY_CLIENT_SECRET)) ||
      (sources.length > 0 &&
        ((env.CLOUDFLARE_WEBHOOK_SECRET?.length ?? 0) < 32 || (env.CLOUDFLARE_DIAGNOSTICS_TOKEN?.length ?? 0) < 30)) ||
      (Object.keys(projects).length === 0 && sources.length === 0) ||
      (env.DIAGNOSTICS_READ_TOKEN?.length ?? 0) < 32 ||
      (env.AUTOFIX_EXECUTOR_TOKEN?.length ?? 0) < 32 ||
      env.AUTOFIX_EXECUTOR_ID !== 'koin-rocky-umpc' ||
      !/^[1-9][0-9]*$/.test(dispatchApp.id ?? '') ||
      !/^[1-9][0-9]*$/.test(dispatchApp.installationId ?? '') ||
      dispatchApp.id !== '5522353' ||
      dispatchApp.installationId !== '176455083' ||
      !dispatchApp.privateKey?.includes('-----BEGIN ') ||
      `${owner}/${repository}`.toLowerCase() !== 'bcsdlab/bcsd_united'
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
    // Native Issues notifications omit account_id. The secret identifies the account;
    // a policy/Worker pair must therefore resolve to exactly one configured account.
    if (new Set(cloudflare.map((source) => `${source.policyId}/${source.workerName}`)).size !== cloudflare.length) {
      throw new Error('Ambiguous Cloudflare policy and Worker');
    }
    // A half-configured or malformed omp gateway is a deployment defect; missing both only disables inference.
    gatewayTransport(env);
    return {
      organization: env.SENTRY_ORGANIZATION,
      projects: new Set(Object.keys(projects)),
      cloudflare,
      owner,
      repository,
    };
  } catch {
    throw new RequestError(503, 'Configure fixed GitHub App, provider allowlists and diagnostic credentials.');
  }
}

function reply(
  status: number,
  body: Record<string, unknown>,
  retryAfterSeconds: number | null = status >= 500 ? 30 : null,
): Response {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      ...(retryAfterSeconds === null ? {} : { 'Retry-After': String(retryAfterSeconds) }),
    },
  });
}

async function boundedBody(request: Request, maxBytes = MAX_BODY_BYTES): Promise<Uint8Array<ArrayBuffer>> {
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > maxBytes)) {
    throw new RequestError(413, 'Request exceeds its body limit.');
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
      if (size > maxBytes) {
        await reader.cancel();
        throw new RequestError(413, 'Request exceeds its body limit.');
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

export function validateIdentity(value: unknown, config: Configuration): Identity {
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
    const source = config.cloudflare.find(
      (item) =>
        item.accountId === scope.accountId && item.policyId === policyId && item.workerName === scope.workerName,
    );
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

export function redact(value: unknown, env: Env): string {
  if (typeof value !== 'string') return '';
  let text = value;
  for (const secret of [
    env.SENTRY_CLIENT_SECRET,
    env.CLOUDFLARE_WEBHOOK_SECRET,
    env.GITHUB_DISPATCH_APP_PRIVATE_KEY,
    env.OMP_GATEWAY_TOKEN,
    env.SENTRY_READ_TOKEN,
    env.DIAGNOSTICS_READ_TOKEN,
    env.AUTOFIX_EXECUTOR_TOKEN,
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
  const data = record(webhook.data);
  const issue = record(data.issue);
  const services = issue.services;
  if (!Array.isArray(services) || services.length !== 1) {
    throw new RequestError(400, 'Expected exactly one Issues service.');
  }
  const workerName = requiredString(record(services[0]).name, 'data.issue.services[0].name');
  const source = config.cloudflare.find(
    (item) =>
      item.policyId === policyId &&
      item.workerName === workerName &&
      (webhook.account_id === undefined || item.accountId === webhook.account_id),
  );
  if (!source) throw new RequestError(403, 'Cloudflare policy or Worker is not allowlisted.');
  uuid(webhook.alert_correlation_id);
  const identity = validateIdentity(
    {
      source: 'cloudflare',
      sourceId: uuid(issue.id),
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
  // The authenticated Issues policy and its single explicit service bind the Worker;
  // notification text and other opaque diagnostic fields never choose a route.
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

export function identityKey(identity: Identity): string {
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
    (item) =>
      item.accountId === url.searchParams.get('accountId') &&
      item.policyId === policyId &&
      item.workerName === url.searchParams.get('workerName'),
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

async function pullRequestIntake(request: Request, env: Env, url: URL): Promise<Response> {
  const bytes = await boundedBody(request, 4096);
  let data: Record<string, unknown>;
  try {
    data = record(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)));
  } catch {
    throw new RequestError(400, 'Invalid executor JSON.');
  }
  const keys = Object.keys(data).sort().join(',');
  if (data.version !== 1 || data.executorId !== env.AUTOFIX_EXECUTOR_ID)
    throw new RequestError(400, 'Invalid executor contract.');
  const stub = env.AUTOFIX_QUEUE.getByName('bcsdlab/bcsd_united');
  let admissionPhase = 'validation';
  try {
    if (url.pathname === '/executor/pull-requests/status') {
      if (
        keys !== 'executorId,runId,version' ||
        typeof data.runId !== 'string' ||
        !/^autofix-[a-f0-9]{64}$/.test(data.runId)
      )
        throw new RequestError(400, 'Invalid status fields.');
      const receipt = await stub.status(data.runId);
      if (!receipt) throw new RequestError(404, 'Unknown pull request run.');
      return Response.json(receipt, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (keys !== 'baseSha,executorId,headSha,pullNumber,version')
      throw new RequestError(400, 'Invalid enqueue fields.');
    const identity = parsePullRequestIdentity(data);
    const policy = pullRequestPolicy(env);
    if (!policy.enabled) throw new RequestError(503, 'Pull request review is not enabled.');
    if (!policy.allowed.has(identity.pullNumber)) throw new RequestError(403, 'Pull request is not allowlisted.');
    // Canonical GitHub facts decide admission; the request only names a pinned PR of the fixed repository.
    admissionPhase = 'github-token';
    const token = await installationToken(env, 'read');
    admissionPhase = 'canonical-pr';
    assertPinned(await inspectPullRequest(env, token, identity.pullNumber, policy), identity);
    admissionPhase = 'queue';
    const admitted = await stub.enqueuePullRequest(identity);
    return Response.json(
      { status: admitted.status, runId: admitted.runId },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    if (error instanceof PullRequestRejected) throw new RequestError(error.status, error.message);
    if (!(error instanceof RequestError)) {
      // 실패 단계와 고정 오류 분류만 남기고 토큰·요청 본문·원문 오류는 기록하지 않는다.
      let failure = 'unknown';
      if (error instanceof GitHubError) failure = `github-http-${error.status}`;
      else if (error instanceof Error) {
        const tokenStatus = /^GitHub App token rejected \((\d{3})\)$/.exec(error.message)?.[1];
        if (tokenStatus) failure = `github-token-${tokenStatus}`;
        else if (error.message === 'GitHub returned an invalid scoped token') failure = 'github-token-contract';
        else failure = error.name;
      }
      const locations =
        error instanceof Error
          ? [...(error.stack ?? '').matchAll(/(?:index\.js|github\.ts):(\d+):(\d+)/g)]
              .slice(0, 3)
              .map((match) => `${match[1]}:${match[2]}`)
          : [];
      console.error('PR admission failed', { phase: admissionPhase, failure, locations });
    }
    throw error;
  }
}

async function executorRequest(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== 'POST') return new Response('Use POST.', { status: 405, headers: { Allow: 'POST' } });
  if (url.search || url.hash) throw new RequestError(400, 'Executor query parameters are not supported.');
  if (env.AUTOFIX_EXECUTOR_ID !== 'koin-rocky-umpc' || (env.AUTOFIX_EXECUTOR_TOKEN?.length ?? 0) < 32)
    throw new RequestError(503, 'Executor identity or credential not configured.');
  if (request.headers.get('X-Executor-Id') !== env.AUTOFIX_EXECUTOR_ID)
    throw new RequestError(401, 'Unknown executor.');
  const authorization = request.headers.get('Authorization');
  await verifySecret(authorization?.startsWith('Bearer ') ? authorization.slice(7) : null, env.AUTOFIX_EXECUTOR_TOKEN);
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json')
    throw new RequestError(415, 'Content-Type must be application/json.');
  if (url.pathname === '/executor/pull-requests/enqueue' || url.pathname === '/executor/pull-requests/status')
    return pullRequestIntake(request, env, url);
  const path = /^\/executor\/jobs\/(autofix-[a-f0-9]{64})\/(heartbeat|verification-start|model|result)$/.exec(
    url.pathname,
  );
  if (url.pathname !== '/executor/claim' && !path) throw new RequestError(404, 'Not found.');
  const maxBytes = path?.[2] === 'result' ? 4_000_000 : path?.[2] === 'model' ? 1_000_000 : 4096;
  const bytes = await boundedBody(request, maxBytes);
  let data: Record<string, unknown>;
  try {
    data = record(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)));
  } catch {
    throw new RequestError(400, 'Invalid executor JSON.');
  }
  const keys = Object.keys(data).sort().join(',');
  if (data.version !== 1 || data.executorId !== env.AUTOFIX_EXECUTOR_ID)
    throw new RequestError(400, 'Invalid executor contract.');
  const stub = env.AUTOFIX_QUEUE.getByName('bcsdlab/bcsd_united');
  if (url.pathname === '/executor/claim') {
    if (
      keys !== 'claimNonce,executorId,version' ||
      typeof data.claimNonce !== 'string' ||
      !/^[a-f0-9]{64}$/.test(data.claimNonce)
    )
      throw new RequestError(400, 'Invalid claim fields.');
    const claimed = await stub.claim(data.claimNonce);
    return claimed
      ? Response.json(claimed, { headers: { 'Cache-Control': 'no-store' } })
      : new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  }
  if (typeof data.leaseToken !== 'string' || !/^[a-f0-9]{64}$/.test(data.leaseToken))
    throw new RequestError(400, 'Invalid lease token.');
  if (path?.[2] === 'heartbeat') {
    if (keys !== 'executorId,leaseToken,version') throw new RequestError(400, 'Invalid heartbeat fields.');
    try {
      return Response.json(await stub.heartbeat(path[1], data.leaseToken), {
        headers: { 'Cache-Control': 'no-store' },
      });
    } catch {
      throw new RequestError(409, 'Expired or invalid lease.');
    }
  }
  if (path?.[2] === 'verification-start') {
    if (keys !== 'executorId,leaseToken,version') throw new RequestError(400, 'Invalid verification stage fields.');
    try {
      return Response.json(await stub.verificationStart(path[1], data.leaseToken), {
        headers: { 'Cache-Control': 'no-store' },
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'Expired or invalid executor lease')
        throw new RequestError(409, 'Expired or invalid lease.');
      throw error;
    }
  }
  if (path?.[2] === 'model') {
    let modelRequest;
    try {
      modelRequest = parseModelRequest(data);
    } catch {
      throw new RequestError(400, 'Invalid fixed model request.');
    }
    try {
      return Response.json(await stub.model(path[1], data.leaseToken, modelRequest), {
        headers: { 'Cache-Control': 'no-store' },
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'Expired or invalid executor lease')
        throw new RequestError(409, 'Expired or invalid lease.');
      // RPC reconstructs the queue's ModelRateLimited as a plain Error keeping only name and serializable own fields.
      const rateLimit = modelRateLimit(error);
      if (rateLimit)
        return reply(
          429,
          { error: 'Model provider rate limited; retry this exact request after Retry-After.', ...rateLimit },
          rateLimit.retryAfterSeconds,
        );
      // Budget, tier and shape rejections are terminal for this job: the same request can never succeed later.
      if (isPolicyRejection(error)) throw new RequestError(422, error.message);
      throw error;
    }
  }
  if (data.outcome === 'verified') {
    if (keys !== 'executorId,leaseToken,manifest,outcome,verification,version')
      throw new RequestError(400, 'Invalid verified-result fields.');
    const manifest = parseManifest(data.manifest),
      proof = record(data.verification);
    if (
      Object.keys(proof).sort().join(',') !== 'baseSha,manifestSha256,passedChecks' ||
      typeof proof.baseSha !== 'string' ||
      typeof proof.manifestSha256 !== 'string' ||
      !Array.isArray(proof.passedChecks) ||
      proof.passedChecks.some((check) => typeof check !== 'string')
    )
      throw new RequestError(400, 'Invalid verification proof.');
    return submitResult(stub, path![1], {
      version: 1,
      executorId: 'koin-rocky-umpc',
      leaseToken: data.leaseToken,
      outcome: 'verified',
      manifest,
      verification: {
        baseSha: proof.baseSha,
        manifestSha256: proof.manifestSha256,
        passedChecks: proof.passedChecks as string[],
      },
    });
  }
  if (data.outcome === 'pr-reviewed') {
    if (keys !== 'executorId,leaseToken,manifest,outcome,review,verification,version')
      throw new RequestError(400, 'Invalid reviewed-result fields.');
    const manifest = parseManifest(data.manifest),
      proof = record(data.verification);
    if (
      Object.keys(proof).sort().join(',') !== 'baseSha,headSha,manifestSha256,passedChecks' ||
      typeof proof.headSha !== 'string' ||
      typeof proof.baseSha !== 'string' ||
      typeof proof.manifestSha256 !== 'string' ||
      !Array.isArray(proof.passedChecks) ||
      proof.passedChecks.length > 20 ||
      proof.passedChecks.some((check) => typeof check !== 'string' || check.length > 60)
    )
      throw new RequestError(400, 'Invalid pull request verification proof.');
    // Review structure and policy are validated by the queue against the leased job.
    return submitResult(stub, path![1], {
      version: 1,
      executorId: 'koin-rocky-umpc',
      leaseToken: data.leaseToken,
      outcome: 'pr-reviewed',
      manifest,
      review: record(data.review),
      verification: {
        headSha: proof.headSha,
        baseSha: proof.baseSha,
        manifestSha256: proof.manifestSha256,
        passedChecks: proof.passedChecks as string[],
      },
    });
  }
  if (data.outcome !== 'failed' && data.outcome !== 'no-fix') throw new RequestError(400, 'Invalid executor outcome.');
  if (
    keys !== 'executorId,leaseToken,outcome,reason,version' ||
    typeof data.reason !== 'string' ||
    data.reason.length > 500 ||
    !data.reason
  )
    throw new RequestError(400, 'Invalid failure fields.');
  return submitResult(stub, path![1], {
    version: 1,
    executorId: 'koin-rocky-umpc',
    leaseToken: data.leaseToken,
    outcome: data.outcome,
    reason: data.reason,
  });
}

function parseManifest(value: unknown): PatchManifest {
  const manifest = record(value);
  if (
    Object.keys(manifest).sort().join(',') !== 'files,version' ||
    manifest.version !== 1 ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > 24 ||
    manifest.files.some((file) => {
      if (!file || typeof file !== 'object' || Array.isArray(file)) return true;
      const entry = file as Record<string, unknown>;
      return (
        Object.keys(entry).sort().join(',') !== 'before,content,path' ||
        typeof entry.path !== 'string' ||
        (entry.before !== null && typeof entry.before !== 'string') ||
        (entry.content !== null && typeof entry.content !== 'string')
      );
    })
  )
    throw new RequestError(400, 'Invalid manifest structure.');
  return { version: 1, files: manifest.files as PatchManifest['files'] };
}

async function submitResult(
  stub: DurableObjectStub<AutofixQueue>,
  runId: string,
  result: ExecutorResult,
): Promise<Response> {
  try {
    return Response.json(await stub.result(runId, result), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof Error && error.message === 'Expired or invalid executor lease')
      throw new RequestError(409, 'Expired or invalid lease.');
    // RPC reconstructs the queue's PolicyRejection as a plain Error carrying only name/message.
    if (isPolicyRejection(error)) throw new RequestError(422, error.message);
    throw error;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.protocol !== 'https:') throw new RequestError(400, 'HTTPS is required.');
      if (env.ENVIRONMENT !== 'production')
        throw new RequestError(503, 'Only the fixed production installation is enabled.');
      if (url.pathname.startsWith('/executor/')) return await executorRequest(request, env, url);
      const retrieval = url.pathname.startsWith('/diagnostics/');
      if (!retrieval && !['/webhooks/sentry', '/webhooks/cloudflare'].includes(url.pathname))
        return reply(404, { error: 'Not found.' });
      const method = retrieval ? 'GET' : 'POST';
      if (request.method !== method) return new Response(`Use ${method}.`, { status: 405, headers: { Allow: method } });
      if (retrieval) {
        const config = configuration(env);
        const authorization = request.headers.get('Authorization');
        await verifySecret(
          authorization?.startsWith('Bearer ') ? authorization.slice(7) : null,
          env.DIAGNOSTICS_READ_TOKEN,
        );
        const identity = retrievalIdentity(url, config);
        const key = identityKey(identity);
        const response = await env.ERROR_ISSUES.get(env.ERROR_ISSUES.idFromName(key)).fetch(
          'https://error-dispatch.internal/diagnostics',
        );
        if (!response.ok) return response;
        const diagnostic = (await response.json()) as Diagnostic;
        const disposition = await env.AUTOFIX_QUEUE.getByName(
          `${env.GITHUB_OWNER}/${env.GITHUB_REPOSITORY}`.toLowerCase(),
        ).errorStatus(key);
        return reply(200, { ...diagnostic, disposition });
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
      if (
        (env.CLOUDFLARE_WEBHOOK_SECRET?.length ?? 0) >= 32 &&
        url.pathname === '/webhooks/cloudflare' &&
        body.byteLength <= 512 &&
        json !== null &&
        typeof json === 'object' &&
        !Array.isArray(json) &&
        Object.keys(json).length === 1 &&
        'text' in json &&
        typeof json.text === 'string' &&
        CLOUDFLARE_TEST_PROBES[json.text] === true
      ) {
        return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
      }
      const config = configuration(env);
      const capture =
        url.pathname === '/webhooks/sentry'
          ? sentryPayload(request.headers.get('Sentry-Hook-Resource'), json, config, env)
          : cloudflarePayload(json, config, env);
      if (!capture) return reply(200, { status: 'ignored' });
      if (capture.identity.source === 'cloudflare') {
        try {
          capture.details.verifiedEvidence = await trustedDiagnostics(env, capture.identity, capture);
        } catch (error) {
          console.warn('Cloudflare evidence rejected', {
            workerName: capture.identity.project,
            sourceId: capture.identity.sourceId,
            reason: error instanceof SourceMapEvidenceError ? error.message : 'Source evidence unavailable',
            providerStatus:
              error instanceof DiagnosticProviderError || error instanceof SourceMapEvidenceError
                ? (error.status ?? null)
                : null,
          });
          return reply(503, { error: 'Authenticated Cloudflare route and mapped source evidence unavailable.' });
        }
      }
      const stub = env.ERROR_ISSUES.get(env.ERROR_ISSUES.idFromName(identityKey(capture.identity)));
      return await stub.fetch('https://error-dispatch.internal/', { method: 'POST', body: JSON.stringify(capture) });
    } catch (error) {
      if (error instanceof RequestError) return reply(error.status, { error: error.message });
      return reply(503, { error: 'Webhook processing failed; retry this delivery.' });
    }
  },
  async tail(events: TraceItem[], env: Env): Promise<void> {
    if (env.ENVIRONMENT !== 'production') return;
    let config: Configuration | undefined;
    for (let index = 0; index < events.length && index < 20; index += 1) {
      const item = events[index];
      if (
        (item.scriptName !== 'koin-web' && item.scriptName !== 'koin-api') ||
        (!item.exceptions.length && !item.logs.some((log) => log.level === 'error' && log.errorInfo?.length))
      )
        continue;
      config ??= configuration(env);
      const source = config.cloudflare.find((candidate) => candidate.workerName === item.scriptName);
      if (!source) continue;
      const evidence = extractTailEvidence(item, source.workerName, source.app);
      if (!evidence) continue;
      const stub = env.ERROR_ISSUES.get(env.ERROR_ISSUES.idFromName(tailKey(evidence.workerName, evidence.rayId)));
      const response = await stub.fetch('https://error-dispatch.internal/tail', {
        method: 'POST',
        body: JSON.stringify(evidence),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error('Trusted Tail evidence was not persisted');
      }
      await response.body?.cancel();
    }
  },
} satisfies ExportedHandler<Env>;

export class ErrorIssueDispatch extends DurableObject<Env> {
  private pending: Promise<DispatchResult> | undefined;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS dispatch (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      identity_key TEXT NOT NULL,
      diagnostic TEXT,
      expires_at INTEGER NOT NULL,
      accepted_at TEXT,
      queue_admitted_at TEXT
    )`);
    state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS tail_evidence (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      evidence TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    )`);
    // v1 persisted GitHub Actions acceptance, not outbound executor queue admission.
    // Preserve the historical timestamp while allowing one clean enqueue after cutover.
    const columns = state.storage.sql.exec<{ name: string }>('PRAGMA table_info(dispatch)').toArray();
    if (!columns.some((column) => column.name === 'queue_admitted_at'))
      state.storage.sql.exec('ALTER TABLE dispatch ADD COLUMN queue_admitted_at TEXT');
  }

  async alarm(): Promise<void> {
    this.ctx.storage.sql.exec('UPDATE dispatch SET diagnostic = NULL WHERE expires_at <= ?', Date.now());
    this.ctx.storage.sql.exec('DELETE FROM tail_evidence WHERE expires_at <= ?', Date.now());
    await this.ctx.storage.sync();
  }

  async fetch(request: Request): Promise<Response> {
    try {
      if (request.method === 'GET' && new URL(request.url).pathname === '/diagnostics') {
        const row = this.ctx.storage.sql
          .exec<{ diagnostic: string | null; expires_at: number }>(
            'SELECT diagnostic, expires_at FROM dispatch WHERE singleton = 1',
          )
          .toArray()[0];
        if (!row?.diagnostic || row.expires_at <= Date.now())
          return reply(404, { error: 'Diagnostic not found or expired.' });
        return new Response(row.diagnostic, {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }
      if (new URL(request.url).pathname === '/tail') {
        if (request.method === 'GET') {
          const row = this.ctx.storage.sql
            .exec<{ evidence: string; expires_at: number }>(
              'SELECT evidence, expires_at FROM tail_evidence WHERE singleton = 1',
            )
            .toArray()[0];
          if (!row || row.expires_at <= Date.now()) return reply(404, { error: 'Tail evidence unavailable.' });
          return new Response(row.evidence, {
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
          });
        }
        if (request.method !== 'POST') return reply(405, { error: 'Use POST.' });
        const bytes = await boundedBody(request, 4096);
        const evidence = record(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)));
        const config = configuration(this.env);
        const source = config.cloudflare.find((item) => item.workerName === evidence.workerName);
        if (
          Object.keys(evidence).sort().join(',') !==
            'eventTimestamp,frames,rayId,route,scriptVersion,version,workerName' ||
          evidence.version !== 1 ||
          !source ||
          typeof evidence.rayId !== 'string' ||
          !/^[a-f0-9]{16}$/.test(evidence.rayId) ||
          typeof evidence.scriptVersion !== 'string' ||
          !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(evidence.scriptVersion) ||
          !Number.isSafeInteger(evidence.eventTimestamp) ||
          (evidence.eventTimestamp as number) < Date.now() - RETENTION_MS ||
          typeof evidence.route !== 'string' ||
          evidence.route.length > 200 ||
          !/^\/[A-Za-z0-9_/-]*$/.test(evidence.route) ||
          evidence.route.startsWith('//') ||
          !Array.isArray(evidence.frames) ||
          evidence.frames.length === 0 ||
          evidence.frames.length > 12 ||
          evidence.frames.some((value) => {
            const frame = record(value);
            return (
              Object.keys(frame).sort().join(',') !== 'column,line,path' ||
              typeof frame.path !== 'string' ||
              (!sourcePath(frame.path, source.app) && !isBundlePath(frame.path)) ||
              frame.path.length > 180 ||
              frame.path.includes('..') ||
              !Number.isSafeInteger(frame.line) ||
              (frame.line as number) < 1 ||
              !Number.isSafeInteger(frame.column) ||
              (frame.column as number) < 1
            );
          })
        )
          throw new RequestError(400, 'Invalid bounded Tail evidence.');
        const expiresAt = (evidence.eventTimestamp as number) + RETENTION_MS;
        this.ctx.storage.sql.exec(
          `INSERT INTO tail_evidence (singleton, evidence, expires_at) VALUES (1, ?, ?)
           ON CONFLICT(singleton) DO UPDATE SET evidence = excluded.evidence, expires_at = excluded.expires_at`,
          JSON.stringify(evidence),
          expiresAt,
        );
        await this.ctx.storage.setAlarm(expiresAt);
        await this.ctx.storage.sync();
        return new Response(null, { status: 204 });
      }
      if (request.method !== 'POST' || new URL(request.url).pathname !== '/')
        return reply(404, { error: 'Not found.' });
      const config = configuration(this.env);
      const data = record(await request.json());
      const identity = validateIdentity(data.identity, config);
      const capture = diagnostic(identity, data.summary, record(data.details), this.env);
      if (encoder.encode(JSON.stringify(capture)).length > 16 * 1024)
        throw new RequestError(413, 'Diagnostic is too large.');
      if (!this.pending)
        this.pending = this.accept(capture).finally(() => {
          this.pending = undefined;
        });
      const result = await this.pending;
      return reply(result.status, result.body);
    } catch (error) {
      if (error instanceof RequestError) return reply(error.status, { error: error.message });
      return reply(503, { error: 'Durable queue unavailable; retry this delivery.' });
    }
  }

  private async accept(capture: Diagnostic): Promise<DispatchResult> {
    const row = this.ctx.storage.sql
      .exec<{ identity_key: string; queue_admitted_at: string | null }>(
        'SELECT identity_key, queue_admitted_at FROM dispatch WHERE singleton = 1',
      )
      .toArray()[0];
    const key = identityKey(capture.identity);
    if (row && row.identity_key !== key) throw new RequestError(409, 'Identity conflicts with durable state.');
    if (row?.queue_admitted_at) return { status: 200, body: { status: 'duplicate' } };
    const expiresAt = Date.now() + RETENTION_MS;
    this.ctx.storage.sql.exec(
      `INSERT INTO dispatch (singleton, identity_key, diagnostic, expires_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET diagnostic = excluded.diagnostic, expires_at = excluded.expires_at`,
      key,
      JSON.stringify(capture),
      expiresAt,
    );
    await this.ctx.storage.setAlarm(expiresAt);
    await this.ctx.storage.sync();
    // Admission is persisted in the fixed repository queue before webhook acknowledgement.
    await this.env.AUTOFIX_QUEUE.getByName('bcsdlab/bcsd_united').enqueue(capture.identity, key);
    this.ctx.storage.sql.exec(
      'UPDATE dispatch SET queue_admitted_at = ? WHERE singleton = 1',
      new Date().toISOString(),
    );
    await this.ctx.storage.sync();
    return { status: 200, body: { status: 'queued' } };
  }
}
