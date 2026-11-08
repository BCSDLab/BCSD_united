import type { Env, Identity, PatchManifest, PreparedJob, Verification } from './types';

const encoder = new TextEncoder();
export const HEX = /^[a-f0-9]{40}$/;
export const SHA256 = /^[a-f0-9]{64}$/;
export const BRANCH_NAME = new RegExp('^[A-Za-z0-9_./-]{1,100}$');
const CHECKS = [
  'regression-fails-on-base',
  'regression-passes-on-fix',
  'native-fixture-tests',
  'typecheck',
  'autofix-security-tests',
  'lint',
  'build',
  'runtime-route-smoke',
];

type Permission = 'read' | 'merge-evidence' | 'publish';

export function base64(bytes: Uint8Array): string {
  let encoded = '';
  // Fixed multiples of three avoid both call-stack exhaustion and intermediate padding.
  for (let i = 0; i < bytes.length; i += 12288) {
    encoded += btoa(String.fromCharCode(...bytes.subarray(i, i + 12288)));
  }
  return encoded;
}
function base64url(bytes: Uint8Array): string {
  return base64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function length(bytes: number[]): number[] {
  if (bytes.length < 128) return [bytes.length];
  const result: number[] = [];
  for (let n = bytes.length; n > 0; n = Math.floor(n / 256)) result.unshift(n % 256);
  return [128 | result.length, ...result];
}
function der(tag: number, bytes: number[]): number[] {
  return [tag, ...length(bytes), ...bytes];
}
function privateKey(pem: string): Uint8Array {
  const pkcs1 = pem.includes('-----BEGIN RSA PRIVATE KEY-----');
  if (!pkcs1 && !pem.includes('-----BEGIN PRIVATE KEY-----')) throw new Error('Invalid GitHub App key');
  const base64 = pem.replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----|-----END (?:RSA )?PRIVATE KEY-----|\s/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error('Invalid GitHub App key');
  const bytes = Array.from(atob(base64), (char) => char.charCodeAt(0));
  if (!pkcs1) return new Uint8Array(bytes);
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  return new Uint8Array(der(0x30, [0x02, 0x01, 0x00, ...algorithm, ...der(0x04, bytes)]));
}

export async function installationToken(env: Env, role: Permission): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const message = `${base64url(encoder.encode('{"alg":"RS256","typ":"JWT"}'))}.${base64url(encoder.encode(JSON.stringify({ iat: now - 60, exp: now + 540, iss: env.GITHUB_DISPATCH_APP_ID })))}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    privateKey(env.GITHUB_DISPATCH_APP_PRIVATE_KEY),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const jwt = `${message}.${base64url(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(message))))}`;
  const permissions =
    role === 'read'
      ? { contents: 'read', issues: 'read', pull_requests: 'read' }
      : role === 'merge-evidence'
        ? { contents: 'read', pull_requests: 'read', checks: 'read', statuses: 'read' }
        : { contents: 'write', issues: 'write', pull_requests: 'write' };
  const response = await fetch(
    `https://api.github.com/app/installations/${env.GITHUB_DISPATCH_INSTALLATION_ID}/access_tokens`,
    {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'koin-error-automation',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ repositories: [env.GITHUB_REPOSITORY], permissions }),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`GitHub App token rejected (${response.status})`);
  }
  const issued = (await response.json()) as {
    token?: string;
    expires_at?: string;
    permissions?: Record<string, string>;
    repositories?: { full_name: string }[];
  };
  if (
    !issued.token ||
    !issued.expires_at ||
    Date.parse(issued.expires_at) < Date.now() + 60000 ||
    !issued.repositories ||
    issued.repositories.length !== 1 ||
    issued.repositories[0].full_name.toLowerCase() !== `${env.GITHUB_OWNER}/${env.GITHUB_REPOSITORY}`.toLowerCase() ||
    Object.entries(permissions).some(([name, level]) => issued.permissions?.[name] !== level)
  )
    throw new Error('GitHub returned an invalid scoped token');
  return issued.token;
}

export async function github<T>(env: Env, token: string, path: string, method = 'GET', body?: unknown): Promise<T> {
  const init: RequestInit = {
    method,
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'koin-error-automation',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  };
  if (body !== undefined) {
    if (method === 'GET' || method === 'HEAD') throw new Error('A read-only GitHub request cannot carry a body');
    init.body = JSON.stringify(body);
  }
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPOSITORY)}${path}`,
    init,
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new GitHubError(response.status, `GitHub ${method} ${path.split('?')[0]} rejected`);
  }
  return response.status === 204 ? (null as T) : ((await response.json()) as T);
}
export class GitHubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export function marker(identity: Identity): string {
  const scope =
    identity.source === 'sentry'
      ? identity.scope.organization
      : `${identity.scope.accountId}:${identity.scope.policyId}`;
  return `<!-- error-autofix:${identity.source}:${scope}:${identity.project}:${identity.sourceId} -->`;
}
/** Mirror identityKey's canonical provider scope without importing the Worker entrypoint. */
export async function branch(identity: Identity): Promise<string> {
  const key =
    identity.source === 'sentry'
      ? `sentry/${identity.scope.organization}/${identity.project}/${identity.sourceId}`
      : `cloudflare/${identity.scope.accountId}/${identity.scope.policyId}/${identity.project}/${identity.sourceId}`;
  let digest = '';
  for (const byte of new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(key))))
    digest += byte.toString(16).padStart(2, '0');
  return `fix/${identity.source}-${digest}`;
}
export function allowedPath(path: string): boolean {
  if (
    !/^[A-Za-z0-9_./$()-]+$/.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))
  )
    return false;
  if (/(?:^|\/)(?:__tests__|tests|fixtures)(?:\/|$)/.test(path) && !path.startsWith('tests/autofix/')) return false;
  if (/^apps\/(?:web|api)\/src\//.test(path) && /\.(?:test|spec)\.[^.]+$/.test(path)) return false;
  return (
    (/^apps\/(?:web|api)\/src\//.test(path) &&
      /\.(?:ts|tsx|js|jsx|scss|css)$/.test(path) &&
      !/^apps\/(?:web|api)\/src\/generated\//.test(path) &&
      path !== 'apps/api/src/db/schema.ts' &&
      !/routeTree\.gen\./.test(path)) ||
    /^tests\/autofix\/[A-Za-z0-9_-]+\.test\.mjs$/.test(path)
  );
}
export function validateManifest(manifest: PatchManifest, app: 'web' | 'api'): void {
  if (
    manifest?.version !== 1 ||
    !Array.isArray(manifest.files) ||
    manifest.files.length < 2 ||
    manifest.files.length > 24
  )
    throw new Error('Invalid candidate manifest');
  const names = new Set<string>();
  let total = 0;
  let source = false;
  let regression = false;
  for (const file of manifest.files) {
    if (
      !allowedPath(file.path) ||
      names.has(file.path) ||
      (file.before !== null && !SHA256.test(file.before)) ||
      (file.content !== null && (typeof file.content !== 'string' || file.content.includes('\0')))
    )
      throw new Error('Forbidden manifest entry');
    names.add(file.path);
    if (file.path.startsWith('apps/')) {
      if (!file.path.startsWith(`apps/${app}/src/`)) throw new Error('Cross-app candidate');
      source = true;
    } else {
      if (file.before !== null || file.content === null) throw new Error('Regression must be a new test');
      regression = true;
    }
    if (file.content !== null) {
      const bytes = encoder.encode(file.content).length;
      if (bytes > 256000) throw new Error('Oversized file');
      total += bytes;
    }
  }
  if (!source || !regression || total > 1000000) throw new Error('Candidate lacks source fix and real regression');
}
export async function validateVerification(
  job: PreparedJob,
  manifest: PatchManifest,
  result: Verification,
): Promise<void> {
  validateManifest(manifest, job.context.app);
  validateManifest(result.verifiedManifest, job.context.app);
  if (
    result.baseSha !== job.baseSha ||
    !HEX.test(result.baseSha) ||
    JSON.stringify(result.verifiedManifest) !== JSON.stringify(manifest) ||
    JSON.stringify(result.passedChecks) !== JSON.stringify(CHECKS)
  )
    throw new Error('Independent verification provenance mismatch');
  const digest = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify(result.verifiedManifest)))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
  if (result.manifestSha256 !== digest) throw new Error('Verified bytes hash mismatch');
}

interface Repository {
  default_branch: string;
  owner: { login: string };
}
interface Commit {
  sha: string;
  commit: { tree: { sha: string } };
}
interface Pull {
  html_url: string;
}
export async function baseRepository(
  env: Env,
  token: string,
  baseBranch: PreparedJob['baseBranch'],
): Promise<{ baseBranch: PreparedJob['baseBranch']; baseSha: string; baseTree: string }> {
  const repo = await github<Repository>(env, token, '');
  if (
    !BRANCH_NAME.test(repo.default_branch) ||
    repo.default_branch.includes('..') ||
    repo.owner.login.toLowerCase() !== env.GITHUB_OWNER.toLowerCase()
  )
    throw new Error('Repository identity changed');
  const commit = await github<Commit>(env, token, `/commits/${baseBranch}`);
  if (!HEX.test(commit.sha) || !HEX.test(commit.commit.tree.sha)) throw new Error('Invalid base commit');
  return { baseBranch, baseSha: commit.sha, baseTree: commit.commit.tree.sha };
}
export async function existingPull(env: Env, token: string, job: Pick<PreparedJob, 'branch'>): Promise<Pull | null> {
  const pulls = await github<Pull[]>(
    env,
    token,
    `/pulls?state=all&head=${encodeURIComponent(`${env.GITHUB_OWNER}:${job.branch}`)}&per_page=100`,
  );
  return pulls[0] ?? null;
}

export async function publish(env: Env, job: PreparedJob, verification: Verification): Promise<string> {
  const token = await installationToken(env, 'publish');
  const base = await baseRepository(env, token, job.baseBranch);
  if (base.baseSha !== job.baseSha) throw new Error('Source branch advanced since independent verification');
  if (job.targetBranch !== 'develop') throw new Error('Invalid pull request target branch');
  if (job.branch !== (await branch(job.identity))) throw new Error('Prepared branch identity mismatch');
  const existing = await existingPull(env, token, job);
  if (existing)
    throw new Error('A PR already exists for this identity; never label another head as independently verified');
  const tree: { path: string; mode: '100644'; type: 'blob'; sha: string | null }[] = [];
  for (const file of verification.verifiedManifest.files) {
    const sha =
      file.content === null
        ? null
        : (
            await github<{ sha: string }>(env, token, '/git/blobs', 'POST', {
              content: base64(encoder.encode(file.content)),
              encoding: 'base64',
            })
          ).sha;
    if (sha !== null && !HEX.test(sha)) throw new Error('Invalid blob SHA');
    tree.push({ path: file.path, mode: '100644', type: 'blob', sha });
  }
  const resultTree = await github<{ sha: string }>(env, token, '/git/trees', 'POST', {
    base_tree: base.baseTree,
    tree,
  });
  const commit = await github<{ sha: string }>(env, token, '/git/commits', 'POST', {
    message: `fix: ${job.identity.source} ${job.identity.sourceId} 오류 수정`,
    tree: resultTree.sha,
    parents: [job.baseSha],
  });
  if (!HEX.test(commit.sha)) throw new Error('Invalid generated commit');
  try {
    await github(env, token, '/git/refs', 'POST', { ref: `refs/heads/${job.branch}`, sha: commit.sha });
  } catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 422) throw error;
    const ref = await github<{ object: { sha: string } }>(
      env,
      token,
      `/git/ref/heads/${encodeURIComponent(job.branch)}`,
    );
    const previous = await github<{ tree: { sha: string }; parents: { sha: string }[] }>(
      env,
      token,
      `/git/commits/${ref.object.sha}`,
    );
    if (
      previous.tree.sha !== resultTree.sha ||
      previous.parents.length !== 1 ||
      previous.parents[0].sha !== job.baseSha
    )
      throw new Error('Existing branch differs: never overwrite human changes');
  }
  const source =
    job.identity.source === 'sentry'
      ? `[Sentry issue](https://${job.identity.scope.organization}.sentry.io/issues/${job.identity.sourceId}/)`
      : `[Cloudflare account dashboard](https://dash.cloudflare.com/${job.identity.scope.accountId}/) (Issue ID: \`${job.identity.sourceId}\`, policy: \`${job.identity.scope.policyId}\`)`;
  const body = `${marker(job.identity)}\n\n## What is this PR?\n\n- Source: ${source}\n- Project: \`${job.identity.project}\`\n- App: \`apps/${job.context.app}\`\n- Verified request: \`${job.context.requestMethod} ${job.context.route}\`\n- Verified source branch: \`${job.baseBranch}\` at \`${job.baseSha}\`\n- PR target branch: \`${job.targetBranch}\`\n\n## Changes\n\n${verification.verifiedManifest.files.map((file) => `- \`${file.path}\``).join('\n')}\n\n## Independent checks\n\n${verification.passedChecks.map((check) => `- [x] ${check}`).join('\n')}\n\n## Precaution\n\n- Candidate was independently verified on the source branch (\`${job.baseBranch}\`), not on the develop integration tip. The PR's CI must validate develop integration before human merge.\n- This PR is authored by the GitHub App bot and is never eligible for automatic PR-review merge.\n- Rocky 실행기에서 독립 생성/검증; 자동 merge/배포는 하지 않습니다. 실제 사용자 데이터와 인증된 화면은 검증하지 않았습니다.\n- 오류 문자열과 생성 코드는 신뢰할 수 없는 입력입니다. 원인 및 테스트 타당성을 리뷰해 주세요.\n`;
  let pr: Pull;
  try {
    pr = await github<Pull>(env, token, '/pulls', 'POST', {
      title: `[${job.domain}] ${job.identity.source} ${job.identity.sourceId} 오류 수정`,
      body,
      head: job.branch,
      base: job.targetBranch,
      draft: false,
    });
  } catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 422) throw error;
    const raced = await existingPull(env, token, job);
    if (raced) throw new Error('A PR appeared concurrently; reconcile its head before claiming publication');
    throw error;
  }
  return pr.html_url;
}
