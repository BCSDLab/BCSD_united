import type { AutofixQueue } from './queue';

export type App = 'web' | 'api';
export type Identity =
  | { source: 'sentry'; sourceId: string; project: string; app: 'web'; scope: { organization: string } }
  | {
      source: 'cloudflare';
      sourceId: string;
      project: string;
      app: App;
      scope: { accountId: string; policyId: string; workerName: string };
    };

export interface Diagnostic {
  version: 1;
  identity: Identity;
  capturedAt: string;
  summary: string;
  details: Record<string, unknown>;
}

/** Error-mode job (external Sentry/Cloudflare identity). `mode` is absent on persisted rows. */
export interface PreparedJob {
  mode?: undefined;
  identity: Identity;
  owner: string;
  repository: string;
  baseBranch: string;
  baseSha: string;
  issueNumber: number;
  branch: string;
  domain: string;
  diagnostics: Record<string, unknown>;
  context: { app: App; route: string; requestMethod: 'GET' };
}

/** Internal queue identity for an allowlisted pull request; never accepted from external webhooks. */
export interface PullRequestIdentity {
  source: 'github-pr';
  pullNumber: number;
  headSha: string;
  baseSha: string;
}
export type QueueIdentity = Identity | PullRequestIdentity;

export interface PreparedPullRequestJob {
  mode: 'pull-request';
  owner: 'BCSDLab';
  repository: 'BCSD_united';
  pullNumber: number;
  headSha: string;
  headTree: string;
  headRef: string;
  baseBranch: 'develop';
  baseSha: string;
  /** Canonical GitHub filenames of the PR diff: untrusted data, never instructions. */
  changedFiles: string[];
  /**
   * Existing human PR reviews/comments fetched canonically from GitHub (bounded, sanitized).
   * UNTRUSTED observations for the model to verify against pinned code; never paths or permissions.
   */
  reviewContext: ReviewContext;
}

export interface ReviewContext {
  version: 1;
  /** Canonical PR title/body from GitHub (bounded, sanitized): untrusted feature intent, never instructions. */
  title: string;
  body: string;
  comments: {
    kind: 'issue-comment' | 'review' | 'review-comment';
    author: string;
    createdAt: string;
    path: string | null;
    line: number | null;
    body: string;
  }[];
}
export type QueuedJob = PreparedJob | PreparedPullRequestJob;

export interface PatchManifest {
  version: 1;
  files: { path: string; before: string | null; content: string | null }[];
}

export interface Verification {
  baseSha: string;
  manifestSha256: string;
  passedChecks: string[];
  verifiedManifest: PatchManifest;
}

export type ReviewSeverity = 'P1' | 'P2' | 'P3';
export interface PullRequestReview {
  decision: 'approved' | 'changes-requested';
  findings: { severity: ReviewSeverity; path: string; line: number; message: string }[];
}

export interface PullRequestVerification {
  headSha: string;
  baseSha: string;
  manifestSha256: string;
  passedChecks: string[];
}

/** Durable, token-free receipt returned by the authenticated status endpoint. */
export interface PullRequestReceipt {
  version: 1;
  runId: string;
  pullNumber: number;
  headSha: string;
  baseSha: string;
  status: string;
  outcome: string | null;
  attempt: number;
  enqueuedAt: number;
  result: {
    reviewedHeadSha: string;
    publishedHeadSha: string | null;
    decision: PullRequestReview['decision'] | null;
    findingsCount: number;
    passedChecks: string[];
    commentUrl: string | null;
  } | null;
}

export interface Env {
  ENVIRONMENT: 'production' | 'preview';
  SENTRY_CLIENT_SECRET: string;
  SENTRY_READ_TOKEN: string;
  SENTRY_ORGANIZATION: string;
  SENTRY_PROJECT_APPS: string;
  SENTRY_PROJECT_HOSTS: string;
  CLOUDFLARE_WEBHOOK_SECRET: string;
  CLOUDFLARE_SOURCES: string;
  CLOUDFLARE_DIAGNOSTICS_TOKEN?: string;
  DIAGNOSTICS_READ_TOKEN: string;
  ERROR_PROJECT_DOMAINS: string;
  ANTHROPIC_API_KEY?: string;
  GITHUB_OWNER: string;
  GITHUB_REPOSITORY: string;
  GITHUB_DISPATCH_APP_ID: string;
  GITHUB_DISPATCH_APP_PRIVATE_KEY: string;
  GITHUB_DISPATCH_INSTALLATION_ID: string;
  /** Explicit opt-in; only the literal string 'true' enables PR review intake. */
  PR_REVIEW_ENABLED?: string;
  /** Comma-separated explicit PR numbers; empty means no PR is accepted. */
  PR_REVIEW_ALLOWED_PRS?: string;
  ERROR_ISSUES: DurableObjectNamespace;
  AUTOFIX_QUEUE: DurableObjectNamespace<AutofixQueue>;
  AUTOFIX_EXECUTOR_ID: 'koin-rocky-umpc';
  AUTOFIX_EXECUTOR_TOKEN: string;
}
