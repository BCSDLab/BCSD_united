import { DurableObject } from 'cloudflare:workers';
import { prepare } from './prepare';
import { github, installationToken, publish, validateManifest, validateVerification } from './github';
import { invokeModel, type ModelMode, type ModelRequest } from './model';
import {
  PullRequestRejected,
  type Published,
  preparePullRequest,
  pullRequestKey,
  validatePullRequestVerification,
  validateReview,
  publishPullRequest,
} from './pull-request';
import type {
  Env,
  Identity,
  PatchManifest,
  PreparedPullRequestJob,
  PullRequestIdentity,
  PullRequestReceipt,
  PullRequestReview,
  PullRequestVerification,
  QueuedJob,
  QueueIdentity,
  Verification,
} from './types';

const PREPARE_MS = 5 * 60_000;
const DEADLINE_MS = 90 * 60_000;
const LEASE_MS = 2 * 60_000;
const PUBLISH_MS = 20 * 60_000;
const REPORT_MS = 5 * 60_000;
const MODEL_MS = 20 * 60_000;
const MAX_PENDING = 100;
const encoder = new TextEncoder();

type Status = 'queued' | 'preparing' | 'leased' | 'verifying' | 'reporting' | 'publishing' | 'completed' | 'failed';
interface Row extends Record<string, SqlStorageValue> {
  run_id: string;
  identity_key: string;
  identity: string;
  status: Status;
  attempt: number;
  lease_hash: string | null;
  claim_nonce_hash: string | null;
  lease_expires: number | null;
  deadline_at: number | null;
  prepared: string | null;
  issue_number: number | null;
  outcome: string | null;
  pr_url: string | null;
  model_calls: number;
  model_started_at: number | null;
}
export interface Claim {
  version: 1;
  runId: string;
  leaseToken: string;
  attempt: number;
  deadlineAt: number;
  /** Server-confirmed lease expiry (ms epoch). Resumed claims report the stored expiry, not a fresh one. */
  leaseExpiresAt: number;
  job: QueuedJob;
}
export type ExecutorResult =
  | {
      version: 1;
      executorId: 'koin-rocky-umpc';
      leaseToken: string;
      outcome: 'verified';
      manifest: PatchManifest;
      verification: Omit<Verification, 'verifiedManifest'>;
    }
  | {
      version: 1;
      executorId: 'koin-rocky-umpc';
      leaseToken: string;
      outcome: 'pr-reviewed';
      manifest: PatchManifest;
      review: unknown;
      verification: PullRequestVerification;
    }
  | { version: 1; executorId: 'koin-rocky-umpc'; leaseToken: string; outcome: 'no-fix' | 'failed'; reason: string };
export type ResultReceipt =
  | { status: 'published'; pr: string; headSha?: string }
  | { status: 'recorded'; outcome?: string };

/**
 * Executor payload violates the fixed proof or edit policy; retrying the same payload cannot succeed.
 * Crosses the Durable Object RPC boundary as a plain Error: only `name`/`message` survive, never the prototype,
 * so consumers classify by {@link POLICY_REJECTION} rather than `instanceof`.
 */
const POLICY_REJECTION = 'PolicyRejection';
export class PolicyRejection extends Error {
  constructor(message: string) {
    super(message);
    this.name = POLICY_REJECTION;
  }
}

/** Structural match for a policy rejection, whether thrown in-process or reconstructed from RPC serialization. */
export function isPolicyRejection(error: unknown): error is { name: string; message: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    error.name === POLICY_REJECTION &&
    'message' in error &&
    typeof error.message === 'string'
  );
}

interface PullRequestResultRow extends Record<string, SqlStorageValue> {
  run_id: string;
  reviewed_head_sha: string;
  published_head_sha: string | null;
  decision: string | null;
  findings_count: number;
  passed_checks: string;
  comment_url: string | null;
}

async function hexDigest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))), (part) =>
    part.toString(16).padStart(2, '0'),
  ).join('');
}
async function leaseToken(secret: string, runId: string, attempt: number, nonce: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(`${runId}:${attempt}:${nonce}`)),
  );
  return Array.from(signature, (part) => part.toString(16).padStart(2, '0')).join('');
}
function equalDigest(a: string, b: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b)) return false;
  let difference = 0;
  for (let i = 0; i < 64; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

/** One repository coordination atom, not a public arbitrary-execution endpoint. */
export class AutofixQueue extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS jobs (
      run_id TEXT PRIMARY KEY, identity_key TEXT NOT NULL UNIQUE, identity TEXT NOT NULL,
      status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
      lease_hash TEXT, claim_nonce_hash TEXT, lease_expires INTEGER, deadline_at INTEGER,
      prepared TEXT, issue_number INTEGER, outcome TEXT, pr_url TEXT,
      model_calls INTEGER NOT NULL DEFAULT 0, model_started_at INTEGER,
      enqueued_at INTEGER NOT NULL
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS pull_request_results (
      run_id TEXT PRIMARY KEY, reviewed_head_sha TEXT NOT NULL, published_head_sha TEXT,
      decision TEXT, findings_count INTEGER NOT NULL DEFAULT 0, passed_checks TEXT NOT NULL,
      comment_url TEXT, recorded_at INTEGER NOT NULL
    )`);
  }

  private async admit(
    identity: QueueIdentity,
    key: string,
  ): Promise<{ status: 'queued' | 'duplicate'; runId: string }> {
    const runId = `autofix-${await hexDigest(key)}`;
    const existing = this.ctx.storage.sql.exec<Row>('SELECT * FROM jobs WHERE run_id = ?', runId).toArray()[0];
    if (existing) {
      if (existing.identity_key !== key || existing.identity !== JSON.stringify(identity))
        throw new Error('Conflicting durable identity');
      return { status: 'duplicate', runId };
    }
    const count = this.ctx.storage.sql
      .exec<{ count: number }>(
        "SELECT count(*) AS count FROM jobs WHERE status IN ('queued','preparing','leased','verifying','reporting','publishing')",
      )
      .one().count;
    if (count >= MAX_PENDING) throw new Error('Autofix queue is full');
    this.ctx.storage.sql.exec(
      'INSERT INTO jobs (run_id, identity_key, identity, status, enqueued_at) VALUES (?, ?, ?, ?, ?)',
      runId,
      key,
      JSON.stringify(identity),
      'queued',
      Date.now(),
    );
    await this.ctx.storage.sync();
    return { status: 'queued', runId };
  }

  async enqueue(identity: Identity, key: string): Promise<'queued' | 'duplicate'> {
    if (!/^(?:sentry|cloudflare)\//.test(key) || key.length > 250) throw new Error('Invalid identity key');
    return (await this.admit(identity, key)).status;
  }

  /** Canonical GitHub pin validation happens in the Worker before this durable admission. */
  async enqueuePullRequest(identity: PullRequestIdentity): Promise<{ status: 'queued' | 'duplicate'; runId: string }> {
    if (
      identity.source !== 'github-pr' ||
      !Number.isSafeInteger(identity.pullNumber) ||
      identity.pullNumber < 1 ||
      !/^[a-f0-9]{40}$/.test(identity.headSha) ||
      !/^[a-f0-9]{40}$/.test(identity.baseSha) ||
      identity.headSha === identity.baseSha
    )
      throw new Error('Invalid pull request identity');
    const canonical: PullRequestIdentity = {
      source: 'github-pr',
      pullNumber: identity.pullNumber,
      headSha: identity.headSha,
      baseSha: identity.baseSha,
    };
    return this.admit(canonical, pullRequestKey(canonical));
  }

  /** Token-free durable receipt for one pull request run; null for unknown or error-mode runs. */
  async status(runId: string): Promise<PullRequestReceipt | null> {
    if (!/^autofix-[a-f0-9]{64}$/.test(runId)) return null;
    this.expire(Date.now());
    const row = this.ctx.storage.sql.exec<Row>('SELECT * FROM jobs WHERE run_id = ?', runId).toArray()[0];
    if (!row || !row.identity_key.startsWith('github-pr/')) return null;
    const identity = JSON.parse(row.identity) as PullRequestIdentity;
    const result = this.ctx.storage.sql
      .exec<PullRequestResultRow>('SELECT * FROM pull_request_results WHERE run_id = ?', runId)
      .toArray()[0];
    return {
      version: 1,
      runId,
      pullNumber: identity.pullNumber,
      headSha: identity.headSha,
      baseSha: identity.baseSha,
      status: row.status,
      outcome: row.outcome,
      attempt: row.attempt,
      enqueuedAt: row.enqueued_at as number,
      result: result
        ? {
            reviewedHeadSha: result.reviewed_head_sha,
            publishedHeadSha: result.published_head_sha,
            decision: result.decision as PullRequestReview['decision'] | null,
            findingsCount: result.findings_count,
            passedChecks: JSON.parse(result.passed_checks) as string[],
            commentUrl: result.comment_url,
          }
        : null,
    };
  }

  async alarm(): Promise<void> {
    this.expire(Date.now());
  }

  private expire(now: number): void {
    this.ctx.storage.sql.exec(
      "UPDATE jobs SET status = 'failed', outcome = 'lease-expired', lease_hash = NULL WHERE status IN ('leased','verifying') AND lease_expires <= ?",
      now,
    );
    this.ctx.storage.sql.exec(
      "UPDATE jobs SET status = 'failed', outcome = 'prepare-expired' WHERE status = 'preparing' AND deadline_at <= ?",
      now,
    );
    this.ctx.storage.sql.exec(
      "UPDATE jobs SET status = 'failed', outcome = 'deadline-expired', lease_hash = NULL WHERE status IN ('leased','verifying') AND deadline_at <= ?",
      now,
    );
    this.ctx.storage.sql.exec(
      "UPDATE jobs SET status = 'failed', outcome = 'publication-ambiguous' WHERE status = 'publishing' AND deadline_at <= ?",
      now,
    );
    this.ctx.storage.sql.exec(
      "UPDATE jobs SET status = 'failed', outcome = 'report-ambiguous' WHERE status = 'reporting' AND deadline_at <= ?",
      now,
    );
  }

  async claim(claimNonce: string): Promise<Claim | null> {
    if (
      this.env.AUTOFIX_EXECUTOR_ID !== 'koin-rocky-umpc' ||
      (this.env.AUTOFIX_EXECUTOR_TOKEN?.length ?? 0) < 32 ||
      !/^[a-f0-9]{64}$/.test(claimNonce)
    )
      throw new Error('Invalid dedicated executor claim');
    const nonceHash = await hexDigest(claimNonce);
    this.expire(Date.now());
    const active = this.ctx.storage.sql
      .exec<Row>(
        "SELECT * FROM jobs WHERE status IN ('preparing','leased','verifying','reporting','publishing') LIMIT 1",
      )
      .toArray()[0];
    if (active) {
      if (active.status === 'preparing' && active.claim_nonce_hash && equalDigest(active.claim_nonce_hash, nonceHash))
        throw new Error('Claim still preparing; retry the same nonce');
      if (
        !['leased', 'verifying'].includes(active.status) ||
        !active.claim_nonce_hash ||
        !equalDigest(active.claim_nonce_hash, nonceHash) ||
        !active.prepared ||
        !active.lease_expires ||
        Date.now() >= active.lease_expires
      )
        return null;
      const token = await leaseToken(this.env.AUTOFIX_EXECUTOR_TOKEN, active.run_id, active.attempt, claimNonce);
      if (!active.lease_hash || !equalDigest(active.lease_hash, await hexDigest(token)))
        throw new Error('Lease resume integrity mismatch');
      return {
        version: 1,
        runId: active.run_id,
        leaseToken: token,
        attempt: active.attempt,
        deadlineAt: active.deadline_at!,
        leaseExpiresAt: active.lease_expires,
        job: JSON.parse(active.prepared) as QueuedJob,
      };
    }
    const row = this.ctx.storage.sql
      .exec<Row>("SELECT * FROM jobs WHERE status = 'queued' ORDER BY enqueued_at,run_id LIMIT 1")
      .toArray()[0];
    if (!row) return null;
    const prepareUntil = Date.now() + PREPARE_MS;
    this.ctx.storage.sql.exec(
      "UPDATE jobs SET status = 'preparing', deadline_at = ?, attempt = attempt + 1, claim_nonce_hash = ? WHERE run_id = ? AND status = 'queued'",
      prepareUntil,
      nonceHash,
      row.run_id,
    );
    await this.ctx.storage.setAlarm(prepareUntil);
    await this.ctx.storage.sync();
    let job: QueuedJob | null;
    let issueNumber: number;
    try {
      if (row.identity_key.startsWith('github-pr/')) {
        const identity = JSON.parse(row.identity) as PullRequestIdentity;
        if (identity.source !== 'github-pr' || pullRequestKey(identity) !== row.identity_key)
          throw new Error('Queued pull request identity mismatch');
        job = await preparePullRequest(this.env, identity);
        // GitHub treats a pull request number as its issue number; comments use the same route.
        issueNumber = job.pullNumber;
      } else {
        const prepared = await prepare(this.env, JSON.parse(row.identity) as Identity, row.identity_key);
        job = prepared.job;
        issueNumber = prepared.issueNumber;
      }
    } catch (error) {
      const outcome =
        error instanceof PullRequestRejected
          ? error.status === 409
            ? 'pull-request-stale'
            : 'pull-request-rejected'
          : 'prepare-failed';
      this.ctx.storage.sql.exec(
        "UPDATE jobs SET status = 'failed', outcome = ? WHERE run_id = ? AND status = 'preparing'",
        outcome,
        row.run_id,
      );
      await this.ctx.storage.sync();
      throw new Error('Trusted job preparation failed');
    }
    const current = this.ctx.storage.sql
      .exec<{ status: Status }>('SELECT status FROM jobs WHERE run_id = ?', row.run_id)
      .toArray()[0];
    if (Date.now() >= prepareUntil || current?.status !== 'preparing') {
      this.ctx.storage.sql.exec(
        "UPDATE jobs SET status = 'failed', outcome = 'prepare-expired' WHERE run_id = ? AND status = 'preparing'",
        row.run_id,
      );
      await this.ctx.storage.sync();
      throw new Error('Trusted preparation exceeded its absolute deadline');
    }
    if (!job) {
      this.ctx.storage.sql.exec(
        "UPDATE jobs SET status = 'completed', issue_number = ?, outcome = 'not-repairable-or-duplicate' WHERE run_id = ? AND status = 'preparing'",
        issueNumber,
        row.run_id,
      );
      await this.ctx.storage.sync();
      return null;
    }
    const token = await leaseToken(this.env.AUTOFIX_EXECUTOR_TOKEN, row.run_id, row.attempt + 1, claimNonce);
    const now = Date.now();
    const deadlineAt = now + DEADLINE_MS;
    const leaseExpiresAt = Math.min(now + LEASE_MS, deadlineAt);
    this.ctx.storage.sql.exec(
      "UPDATE jobs SET status = 'leased', lease_hash = ?, lease_expires = ?, deadline_at = ?, prepared = ?, issue_number = ? WHERE run_id = ? AND status = 'preparing'",
      await hexDigest(token),
      leaseExpiresAt,
      deadlineAt,
      JSON.stringify(job),
      issueNumber,
      row.run_id,
    );
    await this.ctx.storage.setAlarm(leaseExpiresAt);
    await this.ctx.storage.sync();
    return {
      version: 1,
      runId: row.run_id,
      leaseToken: token,
      attempt: row.attempt + 1,
      deadlineAt,
      leaseExpiresAt,
      job,
    };
  }

  private async leased(runId: string, leaseToken: string, allowVerifying = false): Promise<Row> {
    const row = this.ctx.storage.sql.exec<Row>('SELECT * FROM jobs WHERE run_id = ?', runId).toArray()[0];
    if (
      !row ||
      (row.status !== 'leased' && !(allowVerifying && row.status === 'verifying')) ||
      !row.lease_hash ||
      !row.lease_expires ||
      !row.deadline_at ||
      Date.now() >= row.lease_expires ||
      Date.now() >= row.deadline_at ||
      !equalDigest(row.lease_hash, await hexDigest(leaseToken))
    )
      throw new Error('Expired or invalid executor lease');
    return row;
  }

  async verificationStart(runId: string, leaseToken: string): Promise<{ status: 'verifying' }> {
    const row = await this.leased(runId, leaseToken, true);
    if (row.status === 'verifying') return { status: 'verifying' };
    if (row.model_calls < 1) throw new Error('Independent verification requires a model generation attempt');
    this.ctx.storage.sql.exec(
      "UPDATE jobs SET status = 'verifying' WHERE run_id = ? AND status = 'leased' AND lease_expires > ?",
      runId,
      Date.now(),
    );
    await this.ctx.storage.sync();
    const current = this.ctx.storage.sql
      .exec<{ status: Status }>('SELECT status FROM jobs WHERE run_id = ?', runId)
      .toArray()[0];
    if (current?.status !== 'verifying') throw new Error('Expired or invalid executor lease');
    return { status: 'verifying' };
  }

  async model(runId: string, leaseToken: string, request: ModelRequest): Promise<Record<string, unknown>> {
    const row = await this.leased(runId, leaseToken);
    const mode: ModelMode = (JSON.parse(row.prepared!) as QueuedJob).mode === 'pull-request' ? 'pull-request' : 'error';
    const maxCalls = mode === 'pull-request' ? 80 : 40;
    const maxMessages = mode === 'pull-request' ? 160 : 80;
    const maxBytes = mode === 'pull-request' ? 1_000_000 : 256_000;
    if (request.maxTokens > (mode === 'pull-request' ? 16384 : 4096)) throw new Error('Model output limit exceeded');
    if (request.messages.length > maxMessages || encoder.encode(JSON.stringify(request)).length > maxBytes)
      throw new Error('Model context limit exceeded');
    const now = Date.now();
    if (row.model_calls >= maxCalls || (row.model_started_at !== null && now - row.model_started_at >= MODEL_MS))
      throw new Error('Model phase call or deadline limit exceeded');
    this.ctx.storage.sql.exec(
      `UPDATE jobs SET model_calls = model_calls + 1, model_started_at = COALESCE(model_started_at, ?)
       WHERE run_id = ? AND status = 'leased' AND lease_expires > ? AND deadline_at > ?
       AND model_calls < ? AND (model_started_at IS NULL OR model_started_at > ?)`,
      now,
      runId,
      now,
      now,
      maxCalls,
      now - MODEL_MS,
    );
    const current = this.ctx.storage.sql
      .exec<{ status: Status; model_calls: number }>('SELECT status, model_calls FROM jobs WHERE run_id = ?', runId)
      .toArray()[0];
    if (current?.status !== 'leased' || current.model_calls !== row.model_calls + 1)
      throw new Error('Model phase no longer owns the lease');
    await this.ctx.storage.sync();
    const response = await invokeModel(this.env, request, mode);
    await this.leased(runId, leaseToken);
    return response;
  }

  async heartbeat(runId: string, leaseToken: string): Promise<{ deadlineAt: number; leaseExpiresAt: number }> {
    const row = await this.leased(runId, leaseToken, true);
    const next = Math.min(Date.now() + LEASE_MS, row.deadline_at!);
    this.ctx.storage.sql.exec(
      "UPDATE jobs SET lease_expires = ? WHERE run_id = ? AND status IN ('leased','verifying')",
      next,
      runId,
    );
    await this.ctx.storage.setAlarm(next);
    await this.ctx.storage.sync();
    const current = this.ctx.storage.sql
      .exec<{ status: Status; lease_expires: number }>('SELECT status, lease_expires FROM jobs WHERE run_id = ?', runId)
      .toArray()[0];
    if (
      !['leased', 'verifying'].includes(current?.status ?? '') ||
      current.lease_expires !== next ||
      Date.now() >= next
    )
      throw new Error('Expired or invalid executor lease');
    return { deadlineAt: row.deadline_at!, leaseExpiresAt: next };
  }

  private pullRequestResult(runId: string): PullRequestResultRow | undefined {
    return this.ctx.storage.sql
      .exec<PullRequestResultRow>('SELECT * FROM pull_request_results WHERE run_id = ?', runId)
      .toArray()[0];
  }

  async result(runId: string, payload: ExecutorResult): Promise<ResultReceipt> {
    const previous = this.ctx.storage.sql.exec<Row>('SELECT * FROM jobs WHERE run_id = ?', runId).toArray()[0];
    if (
      previous?.status === 'completed' &&
      previous.lease_hash &&
      equalDigest(previous.lease_hash, await hexDigest(payload.leaseToken))
    ) {
      if (previous.outcome === 'published' && payload.outcome === 'verified' && previous.pr_url)
        return { status: 'published', pr: previous.pr_url };
      if (previous.outcome === 'published' && payload.outcome === 'pr-reviewed' && previous.pr_url)
        return {
          status: 'published',
          pr: previous.pr_url,
          headSha: this.pullRequestResult(runId)?.published_head_sha ?? undefined,
        };
      if (previous.outcome === 'pull-request-stale' && payload.outcome === 'pr-reviewed')
        return { status: 'recorded', outcome: 'pull-request-stale' };
      if (previous.outcome === payload.outcome && payload.outcome !== 'verified' && payload.outcome !== 'pr-reviewed')
        return { status: 'recorded' };
      throw new Error('Completed outcome conflicts with retry');
    }
    const row = await this.leased(runId, payload.leaseToken, true);
    if (!row.prepared || !row.issue_number) throw new Error('Prepared job missing');
    const queued = JSON.parse(row.prepared) as QueuedJob;
    if (queued.mode === 'pull-request') return this.pullRequestOutcome(runId, row, queued, payload);
    if (payload.outcome === 'pr-reviewed')
      throw new PolicyRejection('Pull request review outcome is impossible for an error job');
    const job = queued;
    if (payload.outcome !== 'verified') {
      if (payload.outcome === 'no-fix' && row.status !== 'leased')
        throw new Error('No-fix outcome cannot follow independent verification');
      if (typeof payload.reason !== 'string' || payload.reason.length < 1 || payload.reason.length > 500)
        throw new Error('Invalid no-fix reason');
      const safe =
        payload.outcome === 'no-fix'
          ? '독립 검증 가능한 수정안이 없어서 PR을 생성하지 않았습니다. 모델 결과는 검증 완료로 간주하지 않습니다.'
          : '독립 검증 또는 실행에 실패하여 PR을 생성하지 않았습니다. 오류를 수동으로 검토해 주세요.';
      // Issue comments are trusted statements, never raw model text.
      const token = await installationToken(this.env, 'publish');
      await this.leased(runId, payload.leaseToken, true);
      const reportingUntil = Date.now() + REPORT_MS;
      this.ctx.storage.sql.exec(
        "UPDATE jobs SET status = 'reporting', deadline_at = ? WHERE run_id = ? AND status IN ('leased','verifying')",
        reportingUntil,
        runId,
      );
      await this.ctx.storage.setAlarm(reportingUntil);
      await this.ctx.storage.sync();
      try {
        await github(this.env, token, `/issues/${job.issueNumber}/comments`, 'POST', { body: safe });
        const current = this.ctx.storage.sql
          .exec<{ status: Status }>('SELECT status FROM jobs WHERE run_id = ?', runId)
          .toArray()[0];
        if (Date.now() >= reportingUntil || current?.status !== 'reporting')
          throw new Error('Outcome reporting exceeded deadline');
        this.ctx.storage.sql.exec(
          "UPDATE jobs SET status = 'completed', outcome = ? WHERE run_id = ? AND status = 'reporting'",
          payload.outcome,
          runId,
        );
        await this.ctx.storage.sync();
        return { status: 'recorded' };
      } catch {
        this.ctx.storage.sql.exec(
          "UPDATE jobs SET status = 'failed', outcome = 'report-ambiguous', lease_hash = NULL WHERE run_id = ? AND status = 'reporting'",
          runId,
        );
        await this.ctx.storage.sync();
        throw new Error('Outcome report could not be confirmed; reconcile issue comments manually');
      }
    }
    if (row.status !== 'verifying') throw new Error('Verified result requires independent verification phase');
    validateManifest(payload.manifest, job.context.app);
    const proof: Verification = { ...payload.verification, verifiedManifest: payload.manifest };
    await validateVerification(job, payload.manifest, proof);
    await this.leased(runId, payload.leaseToken, true);
    const publishingUntil = Date.now() + PUBLISH_MS;
    this.ctx.storage.sql.exec(
      "UPDATE jobs SET status = 'publishing', deadline_at = ? WHERE run_id = ? AND status = 'verifying'",
      publishingUntil,
      runId,
    );
    await this.ctx.storage.setAlarm(publishingUntil);
    await this.ctx.storage.sync();
    try {
      const pr = await publish(this.env, job, proof);
      const current = this.ctx.storage.sql
        .exec<{ status: Status }>('SELECT status FROM jobs WHERE run_id = ?', runId)
        .toArray()[0];
      if (Date.now() >= publishingUntil || current?.status !== 'publishing')
        throw new Error('Publication exceeded its absolute deadline');
      this.ctx.storage.sql.exec(
        "UPDATE jobs SET status = 'completed', outcome = 'published', pr_url = ? WHERE run_id = ? AND status = 'publishing'",
        pr,
        runId,
      );
      await this.ctx.storage.sync();
      return { status: 'published', pr };
    } catch {
      this.ctx.storage.sql.exec(
        "UPDATE jobs SET status = 'failed', outcome = 'publication-ambiguous', lease_hash = NULL WHERE run_id = ? AND status = 'publishing'",
        runId,
      );
      await this.ctx.storage.sync();
      throw new Error('Publication could not be confirmed; reconcile branch and PR manually');
    }
  }

  /**
   * PR mode: 'failed' leaves a trusted comment; 'pr-reviewed' requires the verification phase,
   * the fixed PR proof, a bounded review, and the still-pinned head before any publication.
   */
  private async pullRequestOutcome(
    runId: string,
    row: Row,
    job: PreparedPullRequestJob,
    payload: ExecutorResult,
  ): Promise<ResultReceipt> {
    if (payload.outcome === 'verified' || payload.outcome === 'no-fix')
      throw new PolicyRejection(`Outcome ${payload.outcome} is impossible for a pull request job`);
    if (payload.outcome === 'failed') {
      if (typeof payload.reason !== 'string' || payload.reason.length < 1 || payload.reason.length > 500)
        throw new PolicyRejection('Invalid failure reason');
      const safe = `자동 리뷰 실행 또는 독립 검증에 실패하여 PR head \`${job.headSha}\`를 변경하지 않았습니다. 수동으로 리뷰해 주세요.`;
      const token = await installationToken(this.env, 'publish');
      await this.leased(runId, payload.leaseToken, true);
      const reportingUntil = Date.now() + REPORT_MS;
      this.ctx.storage.sql.exec(
        "UPDATE jobs SET status = 'reporting', deadline_at = ? WHERE run_id = ? AND status IN ('leased','verifying')",
        reportingUntil,
        runId,
      );
      await this.ctx.storage.setAlarm(reportingUntil);
      await this.ctx.storage.sync();
      try {
        await github(this.env, token, `/issues/${job.pullNumber}/comments`, 'POST', { body: safe });
        const current = this.ctx.storage.sql
          .exec<{ status: Status }>('SELECT status FROM jobs WHERE run_id = ?', runId)
          .toArray()[0];
        if (Date.now() >= reportingUntil || current?.status !== 'reporting')
          throw new Error('Outcome reporting exceeded deadline');
        this.ctx.storage.sql.exec(
          "UPDATE jobs SET status = 'completed', outcome = 'failed' WHERE run_id = ? AND status = 'reporting'",
          runId,
        );
        await this.ctx.storage.sync();
        return { status: 'recorded' };
      } catch {
        this.ctx.storage.sql.exec(
          "UPDATE jobs SET status = 'failed', outcome = 'report-ambiguous', lease_hash = NULL WHERE run_id = ? AND status = 'reporting'",
          runId,
        );
        await this.ctx.storage.sync();
        throw new Error('Outcome report could not be confirmed; reconcile pull request comments manually');
      }
    }
    if (payload.outcome !== 'pr-reviewed') throw new PolicyRejection('Invalid pull request result outcome');
    if (row.status !== 'verifying')
      throw new PolicyRejection('Reviewed result requires the independent verification phase');
    let review: PullRequestReview;
    try {
      review = validateReview(payload.review);
      await validatePullRequestVerification(job, payload.manifest, payload.verification);
    } catch (error) {
      throw new PolicyRejection(error instanceof Error ? error.message : 'Invalid pull request proof');
    }
    await this.leased(runId, payload.leaseToken, true);
    const publishingUntil = Date.now() + PUBLISH_MS;
    this.ctx.storage.sql.exec(
      "UPDATE jobs SET status = 'publishing', deadline_at = ? WHERE run_id = ? AND status = 'verifying'",
      publishingUntil,
      runId,
    );
    await this.ctx.storage.setAlarm(publishingUntil);
    await this.ctx.storage.sync();
    try {
      let published: Published;
      try {
        published = await publishPullRequest(this.env, job, payload.manifest, review, payload.verification);
      } catch (error) {
        // Rejected before any ref or comment write: a durable, non-ambiguous terminal receipt.
        if (!(error instanceof PullRequestRejected)) throw error;
        this.ctx.storage.sql.exec(
          "UPDATE jobs SET status = 'completed', outcome = 'pull-request-stale' WHERE run_id = ? AND status = 'publishing'",
          runId,
        );
        this.recordPullRequest(runId, job, review, payload.verification, null, null);
        await this.ctx.storage.sync();
        return { status: 'recorded', outcome: 'pull-request-stale' };
      }
      const current = this.ctx.storage.sql
        .exec<{ status: Status }>('SELECT status FROM jobs WHERE run_id = ?', runId)
        .toArray()[0];
      if (Date.now() >= publishingUntil || current?.status !== 'publishing')
        throw new Error('Publication exceeded its absolute deadline');
      this.ctx.storage.sql.exec(
        "UPDATE jobs SET status = 'completed', outcome = 'published', pr_url = ? WHERE run_id = ? AND status = 'publishing'",
        published.url,
        runId,
      );
      this.recordPullRequest(
        runId,
        job,
        review,
        payload.verification,
        published.publishedHeadSha,
        published.commentUrl,
      );
      await this.ctx.storage.sync();
      return { status: 'published', pr: published.url, headSha: published.publishedHeadSha };
    } catch {
      this.ctx.storage.sql.exec(
        "UPDATE jobs SET status = 'failed', outcome = 'publication-ambiguous', lease_hash = NULL WHERE run_id = ? AND status = 'publishing'",
        runId,
      );
      await this.ctx.storage.sync();
      throw new Error('Publication could not be confirmed; reconcile the pull request head and comments manually');
    }
  }

  private recordPullRequest(
    runId: string,
    job: PreparedPullRequestJob,
    review: PullRequestReview,
    proof: PullRequestVerification,
    publishedHeadSha: string | null,
    commentUrl: string | null,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO pull_request_results
       (run_id, reviewed_head_sha, published_head_sha, decision, findings_count, passed_checks, comment_url, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      runId,
      job.headSha,
      publishedHeadSha,
      review.decision,
      review.findings.length,
      JSON.stringify(proof.passedChecks),
      commentUrl,
      Date.now(),
    );
  }
}
