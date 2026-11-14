import { DurableObject } from 'cloudflare:workers';
import { parseErrorMonitorSnapshot, type ErrorMonitorSnapshot } from '@koin/telemetry/monitor';
import { autoMergePullRequest, type AutoMergeOutcome } from './auto-merge';
import { prepare } from './prepare';
import { redact } from './index';
import { github, installationToken, publish, validateManifest, validateVerification } from './github';
import {
  CALL_TIMEOUT_MS,
  MODEL_BY_MODE,
  invokeModel,
  providerBody,
  trustworthyUsage,
  type ModelMode,
  type ModelRequest,
} from './model';
import {
  PullRequestRejected,
  type Published,
  preparePullRequest,
  pullRequestKey,
  validatePullRequestVerification,
  validateReview,
  publishPullRequest,
  reviewComment,
} from './pull-request';
import type {
  Env,
  ErrorReceipt,
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
const AUTO_MERGE_RECHECK_MS = 2 * 60_000;
const AUTO_MERGE_WINDOW_MS = 30 * 60_000;
/**
 * Hard per-job model budgets, persisted per row so restarts, concurrent calls and transport failures can never
 * reset them. Input reserves one token per UTF-8 byte of the exact upstream body plus a fixed overhead allowance;
 * output reserves the forwarded `max_tokens`. Both are replaced by the
 * provider's usage only when it is trustworthy. Verification budgets are separate and unchanged.
 */
const MODEL_BUDGET: Record<
  ModelMode,
  { calls: number; generationMs: number; inputTokens: number; outputTokens: number; maxTokensPerCall: number }
> = {
  error: { calls: 6, generationMs: 4 * 60_000, inputTokens: 50_000, outputTokens: 8_000, maxTokensPerCall: 4096 },
  'pull-request': {
    calls: 20,
    generationMs: 15 * 60_000,
    inputTokens: 400_000,
    outputTokens: 32_000,
    maxTokensPerCall: 8192,
  },
};
/**
 * One token per UTF-8 byte avoids undercounting short/random tokens. The extra allowance covers gateway context;
 * this remains an admission bound, not a provider billing guarantee. Trustworthy usage replaces the reservation.
 */
const INPUT_OVERHEAD_TOKENS = 1024;
const MAX_PENDING = 100;
const encoder = new TextEncoder();

type Status = ErrorMonitorSnapshot['recent'][number]['status'];
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
  reason: string | null;
  outcome: string | null;
  pr_url: string | null;
  model_calls: number;
  model_started_at: number | null;
  model_input_tokens: number;
  model_output_tokens: number;
}

interface MonitorRow extends Record<string, SqlStorageValue> {
  run_id: string | null;
  source: 'sentry' | 'cloudflare' | null;
  app: 'web' | 'api' | null;
  status: Status | null;
  enqueued_at: number | null;
  sentry_count: number;
  sentry_latest_at: number | null;
  cloudflare_count: number;
  cloudflare_latest_at: number | null;
  invalid_count: number;
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
  auto_merge: string | null;
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
/** Earlier prepared error jobs pinned develop and had no explicit PR target. Preserve their leases and result state. */
function storedJob(prepared: string): QueuedJob {
  const job = JSON.parse(prepared) as QueuedJob;
  if (job.mode === undefined && !Object.hasOwn(job, 'targetBranch')) job.targetBranch = 'develop';
  return job;
}

/** One repository coordination atom, not a public arbitrary-execution endpoint. */
export class AutofixQueue extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS jobs (
      run_id TEXT PRIMARY KEY, identity_key TEXT NOT NULL UNIQUE, identity TEXT NOT NULL,
      status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0,
      lease_hash TEXT, claim_nonce_hash TEXT, lease_expires INTEGER, deadline_at INTEGER,
      prepared TEXT, outcome TEXT, reason TEXT, pr_url TEXT,
      model_calls INTEGER NOT NULL DEFAULT 0, model_started_at INTEGER,
      model_input_tokens INTEGER NOT NULL DEFAULT 0, model_output_tokens INTEGER NOT NULL DEFAULT 0,
      enqueued_at INTEGER NOT NULL
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS pull_request_results (
      run_id TEXT PRIMARY KEY, reviewed_head_sha TEXT NOT NULL, published_head_sha TEXT,
      decision TEXT, findings_count INTEGER NOT NULL DEFAULT 0, passed_checks TEXT NOT NULL,
      comment_url TEXT, auto_merge TEXT, recorded_at INTEGER NOT NULL
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS pull_request_branch_updates (
      pull_number INTEGER NOT NULL, head_sha TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'updated', PRIMARY KEY (pull_number, head_sha)
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS pull_request_publisher_heads (
      pull_number INTEGER NOT NULL, head_sha TEXT NOT NULL, PRIMARY KEY (pull_number, head_sha)
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS pending_auto_merges (
      run_id TEXT PRIMARY KEY, next_at INTEGER NOT NULL, until_at INTEGER NOT NULL,
      review TEXT NOT NULL, proof TEXT NOT NULL
    )`);
    const resultColumns = new Set(
      ctx.storage.sql
        .exec<{ name: string }>('PRAGMA table_info(pull_request_results)')
        .toArray()
        .map((column) => column.name),
    );
    if (!resultColumns.has('auto_merge'))
      ctx.storage.sql.exec('ALTER TABLE pull_request_results ADD COLUMN auto_merge TEXT');
    const updateColumns = new Set(
      ctx.storage.sql
        .exec<{ name: string }>('PRAGMA table_info(pull_request_branch_updates)')
        .toArray()
        .map((column) => column.name),
    );
    if (!updateColumns.has('attempts'))
      ctx.storage.sql.exec('ALTER TABLE pull_request_branch_updates ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1');
    if (!updateColumns.has('status'))
      ctx.storage.sql.exec("ALTER TABLE pull_request_branch_updates ADD COLUMN status TEXT NOT NULL DEFAULT 'updated'");
    // Rows created before budgets existed keep their history; the new counters start from zero.
    const columns = new Set(
      ctx.storage.sql
        .exec<{ name: string }>('PRAGMA table_info(jobs)')
        .toArray()
        .map((column) => column.name),
    );
    for (const column of ['model_input_tokens', 'model_output_tokens'])
      if (!columns.has(column))
        ctx.storage.sql.exec(`ALTER TABLE jobs ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    if (!columns.has('reason')) ctx.storage.sql.exec('ALTER TABLE jobs ADD COLUMN reason TEXT');
    if (columns.has('issue_number')) ctx.storage.sql.exec('ALTER TABLE jobs DROP COLUMN issue_number');
  }

  /** 처음 등록된 오류 identity만 집계한다. 조회는 만료 처리·알람·작업 상태를 건드리지 않는다. */
  monitorSnapshot(now: number): ErrorMonitorSnapshot {
    if (!Number.isSafeInteger(now) || now < 24 * 60 * 60_000) throw new Error('Invalid monitor time');
    const windowStart = now - 24 * 60 * 60_000;
    const rows = this.ctx.storage.sql
      .exec<MonitorRow>(
        `WITH registered AS (
          SELECT run_id, status, enqueued_at,
            json_extract(identity, '$.source') AS source,
            json_extract(identity, '$.app') AS app,
            json_extract(identity, '$.scope.workerName') AS worker_name,
            json_type(identity, '$.scope.workerName') AS worker_type
          FROM jobs
          WHERE enqueued_at BETWEEN ? AND ?
            AND (identity_key LIKE 'sentry/%' OR identity_key LIKE 'cloudflare/%')
        ), classified AS (
          SELECT *,
            CASE WHEN source = 'sentry' AND app = 'web' THEN 0
                 WHEN source = 'cloudflare' AND app IN ('web', 'api') AND worker_type = 'text' AND worker_name != '' THEN 0
                 ELSE 1 END AS invalid
          FROM registered
        ), eligible AS (
          SELECT run_id, source, app, status, enqueued_at, invalid
          FROM classified
          WHERE invalid = 1 OR source = 'sentry' OR worker_name != 'koin-api'
        ), totals AS (
          SELECT count(CASE WHEN source = 'sentry' THEN 1 END) AS sentry_count,
            max(CASE WHEN source = 'sentry' THEN enqueued_at END) AS sentry_latest_at,
            count(CASE WHEN source = 'cloudflare' THEN 1 END) AS cloudflare_count,
            max(CASE WHEN source = 'cloudflare' THEN enqueued_at END) AS cloudflare_latest_at,
            coalesce(sum(invalid), 0) AS invalid_count
          FROM eligible
        ), recent AS (
          SELECT run_id, source, app, status, enqueued_at
          FROM eligible
          ORDER BY enqueued_at DESC, run_id DESC
          LIMIT 10
        )
        SELECT recent.*, totals.*
        FROM totals LEFT JOIN recent ON 1 = 1
        ORDER BY recent.enqueued_at DESC, recent.run_id DESC`,
        windowStart,
        now,
      )
      .toArray();
    const snapshot: ErrorMonitorSnapshot = {
      version: 1,
      scope: 'ingress-only',
      checkedAt: now,
      windowStart,
      worker: 'responding',
      sources: {
        sentry: { count: 0, latestAt: null },
        cloudflare: { count: 0, latestAt: null },
      },
      recent: [],
    };
    const totals = rows[0];
    if (totals.invalid_count !== 0) throw new Error('Invalid monitor identity');
    snapshot.sources.sentry = { count: totals.sentry_count, latestAt: totals.sentry_latest_at };
    snapshot.sources.cloudflare = { count: totals.cloudflare_count, latestAt: totals.cloudflare_latest_at };
    for (const row of rows) {
      if (row.run_id === null) continue;
      if (
        (row.source !== 'sentry' && row.source !== 'cloudflare') ||
        row.app === null ||
        row.status === null ||
        row.enqueued_at === null
      )
        throw new Error('Invalid monitor identity');
      snapshot.recent.push({
        id: row.run_id,
        source: row.source,
        app: row.app,
        registeredAt: row.enqueued_at,
        status: row.status,
      });
    }
    if (!parseErrorMonitorSnapshot(snapshot, now)) throw new Error('Invalid monitor snapshot');
    return snapshot;
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

  /** Reserve up to three attempts for transient update-branch failures; completed/conflicted heads stay closed. */
  async reserveBranchUpdate(pullNumber: number, headSha: string): Promise<boolean> {
    if (!Number.isSafeInteger(pullNumber) || pullNumber < 1 || !/^[a-f0-9]{40}$/.test(headSha))
      throw new Error('Invalid branch update identity');
    const existing = this.ctx.storage.sql
      .exec<{ attempts: number; status: string }>(
        'SELECT attempts, status FROM pull_request_branch_updates WHERE pull_number = ? AND head_sha = ?',
        pullNumber,
        headSha,
      )
      .toArray()[0];
    if (existing && (existing.status !== 'retry' || existing.attempts >= 3)) return false;
    this.ctx.storage.sql.exec(
      `INSERT INTO pull_request_branch_updates (pull_number, head_sha, attempts, status) VALUES (?, ?, 1, 'reserved')
       ON CONFLICT(pull_number, head_sha) DO UPDATE SET attempts = attempts + 1, status = 'reserved'`,
      pullNumber,
      headSha,
    );
    await this.ctx.storage.sync();
    return true;
  }

  async finishBranchUpdate(
    pullNumber: number,
    headSha: string,
    status: 'updated' | 'conflict' | 'retry' | 'ambiguous',
  ): Promise<void> {
    this.ctx.storage.sql.exec(
      "UPDATE pull_request_branch_updates SET status = ? WHERE pull_number = ? AND head_sha = ? AND status = 'reserved'",
      status,
      pullNumber,
      headSha,
    );
    await this.ctx.storage.sync();
  }

  async isPublisherHead(pullNumber: number, headSha: string): Promise<boolean> {
    return (
      this.ctx.storage.sql
        .exec('SELECT 1 FROM pull_request_publisher_heads WHERE pull_number = ? AND head_sha = ?', pullNumber, headSha)
        .toArray().length > 0
    );
  }

  private async recordPublisherHead(pullNumber: number, headSha: string): Promise<void> {
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO pull_request_publisher_heads (pull_number, head_sha) VALUES (?, ?)',
      pullNumber,
      headSha,
    );
    await this.ctx.storage.sync();
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
      autoMerge: result?.auto_merge
        ? (JSON.parse(result.auto_merge) as { status: AutoMergeOutcome['status']; reason: string })
        : null,
    };
  }

  async errorStatus(key: string): Promise<ErrorReceipt | null> {
    if (!/^(?:sentry|cloudflare)\//.test(key) || key.length > 250) return null;
    this.expire(Date.now());
    const row = this.ctx.storage.sql.exec<Row>('SELECT * FROM jobs WHERE identity_key = ?', key).toArray()[0];
    if (!row) return null;
    return {
      runId: row.run_id,
      status: row.status,
      outcome: row.outcome,
      reason: row.reason,
      prUrl: row.pr_url,
    };
  }

  async alarm(): Promise<void> {
    this.expire(Date.now());
    const due = this.ctx.storage.sql
      .exec<{ run_id: string; until_at: number; review: string; proof: string }>(
        'SELECT run_id, until_at, review, proof FROM pending_auto_merges WHERE next_at <= ? ORDER BY next_at LIMIT 5',
        Date.now(),
      )
      .toArray();
    for (const pending of due) {
      const row = this.ctx.storage.sql.exec<Row>('SELECT * FROM jobs WHERE run_id = ?', pending.run_id).toArray()[0];
      const receipt = this.pullRequestResult(pending.run_id);
      if (!row?.prepared || !receipt?.comment_url || !row.pr_url) {
        this.ctx.storage.sql.exec('DELETE FROM pending_auto_merges WHERE run_id = ?', pending.run_id);
        continue;
      }
      const job = storedJob(row.prepared);
      if (job.mode !== 'pull-request') {
        this.ctx.storage.sql.exec('DELETE FROM pending_auto_merges WHERE run_id = ?', pending.run_id);
        continue;
      }
      const review = JSON.parse(pending.review) as PullRequestReview;
      const proof = JSON.parse(pending.proof) as PullRequestVerification;
      const now = Date.now();
      const timedOut: AutoMergeOutcome | undefined =
        now >= pending.until_at
          ? { status: 'skipped', reason: '30분 안에 head 검증이 완료되지 않아 자동 merge를 종료했습니다.' }
          : undefined;
      const outcome = await this.recordAutoMerge(
        job,
        { version: 1, files: [] },
        review,
        proof,
        { url: row.pr_url, publishedHeadSha: job.headSha, commentUrl: receipt.comment_url },
        timedOut,
      );
      if (outcome.status === 'pending-checks') {
        this.ctx.storage.sql.exec(
          'UPDATE pending_auto_merges SET next_at = ? WHERE run_id = ?',
          Math.min(Date.now() + AUTO_MERGE_RECHECK_MS, pending.until_at),
          pending.run_id,
        );
      } else {
        this.ctx.storage.sql.exec('DELETE FROM pending_auto_merges WHERE run_id = ?', pending.run_id);
      }
      this.ctx.storage.sql.exec(
        'UPDATE pull_request_results SET auto_merge = ? WHERE run_id = ?',
        JSON.stringify(outcome),
        pending.run_id,
      );
      await this.ctx.storage.sync();
    }
    await this.scheduleAlarm();
  }

  /** One DO alarm serves both active leases and completed reviews awaiting checks. */
  private async scheduleAlarm(): Promise<void> {
    const active = this.ctx.storage.sql
      .exec<Row>(
        "SELECT * FROM jobs WHERE status IN ('preparing','leased','verifying','reporting','publishing') LIMIT 1",
      )
      .toArray()[0];
    const pending = this.ctx.storage.sql
      .exec<{ next_at: number | null }>('SELECT MIN(next_at) AS next_at FROM pending_auto_merges')
      .one();
    const activeAt =
      active?.status === 'leased' || active?.status === 'verifying'
        ? Math.min(active.lease_expires ?? Infinity, active.deadline_at ?? Infinity)
        : (active?.deadline_at ?? Infinity);
    const next = Math.min(activeAt, pending.next_at ?? Infinity);
    if (Number.isFinite(next)) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, next));
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
        job: storedJob(active.prepared),
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
    await this.scheduleAlarm();
    await this.ctx.storage.sync();
    let job: QueuedJob | null;
    let prUrl: string | null = null;
    try {
      if (row.identity_key.startsWith('github-pr/')) {
        const identity = JSON.parse(row.identity) as PullRequestIdentity;
        if (identity.source !== 'github-pr' || pullRequestKey(identity) !== row.identity_key)
          throw new Error('Queued pull request identity mismatch');
        job = await preparePullRequest(this.env, identity);
      } else {
        const prepared = await prepare(this.env, JSON.parse(row.identity) as Identity, row.identity_key);
        job = prepared.job;
        prUrl = prepared.prUrl;
      }
    } catch (error) {
      const outcome =
        error instanceof PullRequestRejected
          ? error.status === 409
            ? 'pull-request-stale'
            : 'pull-request-rejected'
          : 'prepare-failed';
      this.ctx.storage.sql.exec(
        "UPDATE jobs SET status = 'failed', outcome = ?, reason = ? WHERE run_id = ? AND status = 'preparing'",
        outcome,
        redact(error instanceof Error ? error.message : 'Trusted preparation failed', this.env).slice(0, 500),
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
        "UPDATE jobs SET status = 'completed', pr_url = ?, outcome = 'existing-pr' WHERE run_id = ? AND status = 'preparing'",
        prUrl,
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
      "UPDATE jobs SET status = 'leased', lease_hash = ?, lease_expires = ?, deadline_at = ?, prepared = ? WHERE run_id = ? AND status = 'preparing'",
      await hexDigest(token),
      leaseExpiresAt,
      deadlineAt,
      JSON.stringify(job),
      row.run_id,
    );
    await this.scheduleAlarm();
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
    const leased = await this.leased(runId, leaseToken);
    const mode: ModelMode = storedJob(leased.prepared!).mode === 'pull-request' ? 'pull-request' : 'error';
    const budget = MODEL_BUDGET[mode];
    const maxMessages = mode === 'pull-request' ? 240 : 80;
    const maxBytes = mode === 'pull-request' ? 1_000_000 : 256_000;
    if (request.model !== MODEL_BY_MODE[mode]) throw new PolicyRejection('Model tier does not match job mode');
    if (request.maxTokens > budget.maxTokensPerCall)
      throw new PolicyRejection(`Model output limit exceeded (${budget.maxTokensPerCall} tokens per call)`);
    if (request.messages.length > maxMessages || encoder.encode(JSON.stringify(request)).length > maxBytes)
      throw new PolicyRejection('Model context limit exceeded');
    // Everything from this re-read to the reservation is synchronous, so concurrent calls serialize on the row.
    const row = this.ctx.storage.sql.exec<Row>('SELECT * FROM jobs WHERE run_id = ?', runId).toArray()[0];
    const now = Date.now();
    if (
      !row ||
      row.status !== 'leased' ||
      row.lease_hash !== leased.lease_hash ||
      now >= row.lease_expires! ||
      now >= row.deadline_at!
    )
      throw new Error('Expired or invalid executor lease');
    const windowExceeded = row.model_started_at !== null && now - row.model_started_at >= budget.generationMs;
    if (row.model_calls >= budget.calls || windowExceeded)
      throw new PolicyRejection(
        `Model phase call or deadline limit exceeded (${budget.calls} calls, ${budget.generationMs / 60_000} min)`,
      );
    const remainingOutput = budget.outputTokens - row.model_output_tokens;
    if (remainingOutput < 1) throw new PolicyRejection(`Model output budget exhausted (${budget.outputTokens} tokens)`);
    // The forwarded max_tokens is clamped to what is left; the executor sees stop_reason max_tokens, never a reset.
    const bounded: ModelRequest = { ...request, maxTokens: Math.min(request.maxTokens, remainingOutput) };
    const inputEstimate = encoder.encode(providerBody(bounded, mode)).length + INPUT_OVERHEAD_TOKENS;
    if (row.model_input_tokens + inputEstimate > budget.inputTokens)
      throw new PolicyRejection(`Model input budget exhausted (${budget.inputTokens} tokens)`);
    this.ctx.storage.sql.exec(
      `UPDATE jobs SET model_calls = model_calls + 1, model_started_at = COALESCE(model_started_at, ?),
         model_input_tokens = model_input_tokens + ?, model_output_tokens = model_output_tokens + ?
       WHERE run_id = ? AND status = 'leased' AND lease_hash = ? AND lease_expires > ? AND deadline_at > ?
         AND model_calls < ? AND (model_started_at IS NULL OR model_started_at > ?)
         AND model_input_tokens + ? <= ? AND model_output_tokens + ? <= ?`,
      now,
      inputEstimate,
      bounded.maxTokens,
      runId,
      row.lease_hash,
      now,
      now,
      budget.calls,
      now - budget.generationMs,
      inputEstimate,
      budget.inputTokens,
      bounded.maxTokens,
      budget.outputTokens,
    );
    const current = this.ctx.storage.sql
      .exec<{ status: Status; model_calls: number }>('SELECT status, model_calls FROM jobs WHERE run_id = ?', runId)
      .toArray()[0];
    if (current?.status !== 'leased' || current.model_calls !== row.model_calls + 1)
      throw new Error('Model phase no longer owns the lease');
    // The reservation is durable before the upstream call: a failure or restart keeps it consumed.
    await this.ctx.storage.sync();
    // Bounded by the remaining generation window as well as the per-call ceiling; body read included.
    const windowRemaining = (row.model_started_at ?? now) + budget.generationMs - now;
    const response = await invokeModel(this.env, bounded, mode, Math.min(CALL_TIMEOUT_MS[mode], windowRemaining));
    const usage = trustworthyUsage(response);
    if (usage) {
      this.ctx.storage.sql.exec(
        `UPDATE jobs SET model_input_tokens = model_input_tokens - ? + ?, model_output_tokens = model_output_tokens - ? + ?
         WHERE run_id = ?`,
        inputEstimate,
        usage.input,
        bounded.maxTokens,
        usage.output,
        runId,
      );
      await this.ctx.storage.sync();
    }
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
    await this.scheduleAlarm();
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
      (previous?.status === 'completed' || previous?.status === 'failed') &&
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
      if (previous.outcome === 'wont-fix' && payload.outcome === 'no-fix')
        return { status: 'recorded', outcome: 'wont-fix' };
      if (previous.status === 'failed' && previous.outcome === 'failed' && payload.outcome === 'failed')
        return { status: 'recorded', outcome: 'failed' };
      if (previous.outcome === payload.outcome && payload.outcome !== 'verified' && payload.outcome !== 'pr-reviewed')
        return { status: 'recorded' };
      throw new Error('Completed outcome conflicts with retry');
    }
    const row = await this.leased(runId, payload.leaseToken, true);
    if (!row.prepared) throw new Error('Prepared job missing');
    const queued = storedJob(row.prepared);
    if (queued.mode === 'pull-request') return this.pullRequestOutcome(runId, row, queued, payload);
    if (payload.outcome === 'pr-reviewed')
      throw new PolicyRejection('Pull request review outcome is impossible for an error job');
    const job = queued;
    if (payload.outcome !== 'verified') {
      if (payload.outcome === 'no-fix' && row.status !== 'leased')
        throw new Error('No-fix outcome cannot follow independent verification');
      if (typeof payload.reason !== 'string' || payload.reason.length < 1 || payload.reason.length > 500)
        throw new Error('Invalid no-fix reason');
      const outcome = payload.outcome === 'no-fix' ? 'wont-fix' : 'failed';
      const reason = redact(payload.reason, this.env).trim().slice(0, 500);
      if (!reason) throw new Error('Invalid empty disposition reason');
      this.ctx.storage.sql.exec(
        "UPDATE jobs SET status = ?, outcome = ?, reason = ? WHERE run_id = ? AND status IN ('leased','verifying')",
        payload.outcome === 'no-fix' ? 'completed' : 'failed',
        outcome,
        reason,
        runId,
      );
      await this.ctx.storage.sync();
      return { status: 'recorded', outcome };
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
    await this.scheduleAlarm();
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
      await this.scheduleAlarm();
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
    await this.scheduleAlarm();
    await this.ctx.storage.sync();
    try {
      let published: Published;
      try {
        published = await publishPullRequest(this.env, job, payload.manifest, review, payload.verification, (headSha) =>
          this.recordPublisherHead(job.pullNumber, headSha),
        );
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
      const autoMerge = await this.recordAutoMerge(job, payload.manifest, review, payload.verification, published);
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
        autoMerge,
      );
      if (autoMerge.status === 'pending-checks') {
        const now = Date.now();
        this.ctx.storage.sql.exec(
          'INSERT INTO pending_auto_merges (run_id, next_at, until_at, review, proof) VALUES (?, ?, ?, ?, ?)',
          runId,
          now + AUTO_MERGE_RECHECK_MS,
          now + AUTO_MERGE_WINDOW_MS,
          JSON.stringify(review),
          JSON.stringify(payload.verification),
        );
      }
      await this.scheduleAlarm();
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

  private async recordAutoMerge(
    job: PreparedPullRequestJob,
    manifest: PatchManifest,
    review: PullRequestReview,
    proof: PullRequestVerification,
    published: Published,
    forced?: AutoMergeOutcome,
  ): Promise<AutoMergeOutcome> {
    let outcome: AutoMergeOutcome;
    try {
      outcome = forced ?? (await autoMergePullRequest(this.env, job, manifest, review));
    } catch {
      outcome = { status: 'pending-checks', reason: 'GitHub 응답을 확인할 수 없어 제한 시간 내에 재확인합니다.' };
    }
    const id = /#issuecomment-([1-9][0-9]*)$/.exec(published.commentUrl)?.[1];
    const marker = `<!-- pr-auto-merge:${job.pullNumber}:${job.headSha}:${job.baseSha}:${proof.manifestSha256} -->`;
    const report = `### 자동 merge\n\n- ${outcome.status}: ${outcome.reason}\n`;
    let updated = false;
    if (id) {
      try {
        const token = await installationToken(this.env, 'publish');
        await github(this.env, token, `/issues/comments/${id}`, 'PATCH', {
          body: `${reviewComment(job, review, manifest, proof, published.publishedHeadSha)}\n${report}`,
        });
        updated = true;
      } catch {
        // A follow-up marker comment is the fallback if GitHub refuses to edit the review comment.
      }
    }
    if (!updated) {
      try {
        const token = await installationToken(this.env, 'publish');
        const comments = await github<
          { body?: string; user?: { login?: string; type?: string }; performed_via_github_app?: { id?: number } }[]
        >(this.env, token, `/issues/${job.pullNumber}/comments?per_page=100`);
        if (
          !comments.some(
            (comment) =>
              comment.body?.includes(marker) &&
              comment.user?.login === 'bcsd-united-error-publisher[bot]' &&
              comment.user.type === 'Bot' &&
              comment.performed_via_github_app?.id === 5522353,
          )
        )
          await github(this.env, token, `/issues/${job.pullNumber}/comments`, 'POST', {
            body: `${marker}\n\n${report}`,
          });
      } catch {
        // The authenticated durable receipt remains available when GitHub comments are unavailable.
      }
    }
    return outcome;
  }

  private recordPullRequest(
    runId: string,
    job: PreparedPullRequestJob,
    review: PullRequestReview,
    proof: PullRequestVerification,
    publishedHeadSha: string | null,
    commentUrl: string | null,
    autoMerge: AutoMergeOutcome | null = null,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO pull_request_results
       (run_id, reviewed_head_sha, published_head_sha, decision, findings_count, passed_checks, comment_url, auto_merge, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      runId,
      job.headSha,
      publishedHeadSha,
      review.decision,
      review.findings.length,
      JSON.stringify(proof.passedChecks),
      commentUrl,
      autoMerge ? JSON.stringify(autoMerge) : null,
      Date.now(),
    );
  }
}
