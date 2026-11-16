import { baseRepository, branch, existingPull, installationToken } from './github';
import { configuration, redact } from './index';
import { manifestDigest, validatePullRequestManifest } from './pull-request';
import type { Env, PatchManifest, PreparedRequestJob, RequestIdentity, Verification } from './types';

/** 실행기와 대조하는 고정 workspace anchor다. Slack 텍스트로 수정 범위를 넓힐 수 없다. */
export const REQUEST_SCOPE = [
  'apps/web/package.json',
  'apps/api/package.json',
  'apps/b-bot/package.json',
  'packages/telemetry/package.json',
  'packages/b-bot-ai/package.json',
  'packages/b-bot-database/package.json',
];
export const REQUEST_CHECKS = [
  'request-base-pinned',
  'request-regression-fails-on-base',
  'native-fixture-tests',
  'typecheck',
  'autofix-security-tests',
  'lint',
  'build',
  'runtime-route-smoke',
];
/** 기존 보호된 workspace 테스트 명령이 실제 검색하는 경로만 회귀 증거로 인정한다. */
export function requestRegressionPath(path: string): boolean {
  return /^(?:apps\/web\/test\/[^/]+\.test\.ts|apps\/api\/(?:src|tests)\/.+\.test\.ts|apps\/api\/scripts\/[^/]+\.test\.mjs|apps\/b-bot\/test\/.+\.test\.ts|packages\/b-bot-ai\/test\/[^/]+\.test\.ts)$/.test(
    path,
  );
}

export function requestSourcePath(path: string): boolean {
  return (
    /^(?:apps\/(?:web|api|b-bot)|packages\/(?:telemetry|b-bot-ai|b-bot-database))\/src\/.+\.(?:[cm]?[jt]sx?|scss|css|json)$/.test(
      path,
    ) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)
  );
}
const encoder = new TextEncoder();
const ID = /^[A-Z][A-Z0-9]{1,39}$/;

export class SlackRequestError extends Error {
  readonly status: number;
  readonly code?: 'not-configured';
  constructor(status: number, message: string, code?: 'not-configured') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
function allowed(value: string | undefined, id: unknown): boolean {
  const values = (value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  return values.length > 0 && values.every((part) => ID.test(part)) && typeof id === 'string' && values.includes(id);
}
/** 직접 멘션 뒤의 명시적 수정 명령만 PR 생성 요청이다. 일반 멘션·질문은 실행하지 않는다. */
export function requestText(text: unknown, bot: string): string | null {
  if (typeof text !== 'string' || !ID.test(bot) || text.length > 6000) return null;
  const prefix = `<@${bot}>`;
  if (!text.startsWith(prefix)) return null;
  const command = text.slice(prefix.length).trim();
  const match = /^(?:수정요청|코드수정요청|fix-request)(?:\s*:\s*|\s+)([\s\S]+)$/i.exec(command);
  if (!match || match[1].trim().length < 5) return null;
  return match[1].trim();
}
export function requestKey(identity: RequestIdentity): string {
  return `slack-request/${identity.teamId}/${identity.eventId}`;
}
export function validateRequest(identity: RequestIdentity, env: Env): RequestIdentity {
  if (
    identity.source !== 'slack-request' ||
    !ID.test(identity.teamId) ||
    !/^Ev[A-Za-z0-9]{1,78}$/.test(identity.eventId) ||
    !ID.test(identity.channelId) ||
    !ID.test(identity.userId) ||
    !/^[0-9]{10,16}\.[0-9]{6}$/.test(identity.messageTs) ||
    identity.teamId !== env.SLACK_AUTOFIX_TEAM_ID ||
    !allowed(env.SLACK_AUTOFIX_ALLOWED_USERS, identity.userId) ||
    !allowed(env.SLACK_AUTOFIX_ALLOWED_CHANNELS, identity.channelId) ||
    typeof identity.text !== 'string' ||
    identity.text.length < 5 ||
    identity.text.length > 4096
  )
    throw new SlackRequestError(403, 'Slack request is not authorized.');
  return {
    source: 'slack-request',
    teamId: identity.teamId,
    eventId: identity.eventId,
    channelId: identity.channelId,
    userId: identity.userId,
    messageTs: identity.messageTs,
    text: identity.text,
  };
}
/** 봇이 주장한 사용자 ID가 아니라 원본 Slack HMAC을 다시 검증한다. */
export async function slackRequest(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response('Use POST.', { status: 405, headers: { Allow: 'POST' } });
  if (new URL(request.url).search) throw new SlackRequestError(400, 'Query parameters are not supported.');
  if (request.headers.get('Content-Type')?.split(';')[0].trim() !== 'application/json')
    throw new SlackRequestError(415, 'Expected application/json.');
  const secret = env.SLACK_BOT_SIGNING_SECRET;
  if (
    env.ENVIRONMENT !== 'production' ||
    !secret ||
    secret.length < 32 ||
    !ID.test(env.SLACK_AUTOFIX_BOT_USER_ID ?? '') ||
    !ID.test(env.SLACK_AUTOFIX_TEAM_ID ?? '')
  )
    throw new SlackRequestError(503, 'Slack autofix is not configured.', 'not-configured');
  const timestamp = request.headers.get('x-slack-request-timestamp') ?? '';
  const signature = request.headers.get('x-slack-signature') ?? '';
  if (
    !/^[0-9]{10}$/.test(timestamp) ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 ||
    !/^v0=[a-f0-9]{64}$/.test(signature)
  )
    throw new SlackRequestError(401, 'Invalid Slack signature.');
  if (!request.body) throw new SlackRequestError(400, 'Missing body.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 32_000) {
      await reader.cancel();
      throw new SlackRequestError(413, 'Slack body too large.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let body: string;
  try {
    body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new SlackRequestError(400, 'Slack body must contain valid UTF-8.');
  }
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'verify',
  ]);
  const signed = Uint8Array.from(signature.slice(3).match(/../g)!, (part) => parseInt(part, 16));
  if (!(await crypto.subtle.verify('HMAC', key, signed, encoder.encode(`v0:${timestamp}:${body}`))))
    throw new SlackRequestError(401, 'Invalid Slack signature.');
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new SlackRequestError(400, 'Invalid Slack JSON.');
  }
  if (data?.type !== 'event_callback' || data.event?.type !== 'app_mention' || data.event.bot_id || data.event.subtype)
    return Response.json({ status: 'ignored' });
  const text = requestText(data.event.text, env.SLACK_AUTOFIX_BOT_USER_ID!);
  if (!text) return Response.json({ status: 'ignored' });
  const identity = validateRequest(
    {
      source: 'slack-request',
      teamId: data.team_id,
      eventId: data.event_id,
      channelId: data.event.channel,
      userId: data.event.user,
      messageTs: data.event.ts,
      text: redact(text, env).trim(),
    },
    env,
  );
  try {
    configuration(env);
  } catch {
    throw new SlackRequestError(503, 'Slack autofix is not configured.', 'not-configured');
  }
  const receipt = await env.AUTOFIX_QUEUE.getByName('bcsdlab/bcsd_united').enqueueRequest(identity);
  return Response.json(receipt);
}
export async function prepareRequest(
  env: Env,
  raw: RequestIdentity,
  key: string,
): Promise<{ job: PreparedRequestJob | null; prUrl: string | null }> {
  configuration(env);
  const identity = validateRequest(raw, env);
  if (key !== requestKey(identity) || JSON.stringify(identity) !== JSON.stringify(raw))
    throw new Error('Queued Slack request identity mismatch');
  const token = await installationToken(env, 'read');
  const base = await baseRepository(env, token, 'develop');
  const proposedBranch = await branch(identity);
  const existing = await existingPull(env, token, { branch: proposedBranch });
  if (existing) return { job: null, prUrl: existing.html_url };
  return {
    prUrl: null,
    job: {
      mode: 'request',
      identity,
      owner: 'BCSDLab',
      repository: 'BCSD_united',
      baseBranch: 'develop',
      targetBranch: 'develop',
      baseSha: base.baseSha,
      branch: proposedBranch,
      domain: '공통',
      changedFiles: [...REQUEST_SCOPE],
    },
  };
}
export async function validateRequestVerification(
  job: PreparedRequestJob,
  manifest: PatchManifest,
  proof: Verification,
): Promise<void> {
  if (
    JSON.stringify(job.changedFiles) !== JSON.stringify(REQUEST_SCOPE) ||
    job.baseBranch !== 'develop' ||
    job.targetBranch !== 'develop'
  )
    throw new Error('Invalid fixed request scope');
  validatePullRequestManifest(manifest, job);
  if (
    !manifest.files.length ||
    !manifest.files.some((file) => requestRegressionPath(file.path) && file.content !== null)
  )
    throw new Error('A request needs a source change and executable regression coverage');
  if (!manifest.files.some((file) => requestSourcePath(file.path))) throw new Error('A request needs a source change');
  if (
    proof.baseSha !== job.baseSha ||
    JSON.stringify(proof.passedChecks) !== JSON.stringify(REQUEST_CHECKS) ||
    JSON.stringify(proof.verifiedManifest) !== JSON.stringify(manifest) ||
    (await manifestDigest(manifest)) !== proof.manifestSha256
  )
    throw new Error('Independent request verification provenance mismatch');
}
