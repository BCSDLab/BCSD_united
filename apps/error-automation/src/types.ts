import type { AutofixQueue } from './queue';

export type App = 'web' | 'api';
export type Identity =
  | { source: 'sentry'; sourceId: string; project: string; app: 'web'; scope: { organization: string } }
  | { source: 'cloudflare'; sourceId: string; project: string; app: App; scope: { accountId: string; policyId: string; workerName: string } };

export interface Diagnostic {
  version: 1;
  identity: Identity;
  capturedAt: string;
  summary: string;
  details: Record<string, unknown>;
}

export interface PreparedJob {
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

export interface Env {
  ENVIRONMENT: 'production' | 'preview';
  SENTRY_CLIENT_SECRET: string;
  SENTRY_READ_TOKEN: string;
  SENTRY_ORGANIZATION: string;
  SENTRY_PROJECT_APPS: string;
  SENTRY_PROJECT_HOSTS: string;
  CLOUDFLARE_WEBHOOK_SECRET: string;
  CLOUDFLARE_SOURCES: string;
  DIAGNOSTICS_READ_TOKEN: string;
  ERROR_PROJECT_DOMAINS: string;
  ANTHROPIC_API_KEY?: string;
  GITHUB_OWNER: string;
  GITHUB_REPOSITORY: string;
  GITHUB_DISPATCH_APP_ID: string;
  GITHUB_DISPATCH_APP_PRIVATE_KEY: string;
  GITHUB_DISPATCH_INSTALLATION_ID: string;
  ERROR_ISSUES: DurableObjectNamespace;
  AUTOFIX_QUEUE: DurableObjectNamespace<AutofixQueue>;
  AUTOFIX_EXECUTOR_ID: 'koin-rocky-umpc';
  AUTOFIX_EXECUTOR_TOKEN: string;
}
