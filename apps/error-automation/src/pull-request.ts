import { BRANCH_NAME, GitHubError, HEX, SHA256, base64, github, installationToken } from './github';
import { MODEL_BY_MODE } from './model';
import type {
  Env,
  PatchManifest,
  PreparedPullRequestJob,
  PullRequestIdentity,
  PullRequestReview,
  PullRequestVerification,
  ReviewContext,
} from './types';

const encoder = new TextEncoder();
export const PR_CHECKS = [
  'pr-head-pinned',
  'native-fixture-tests',
  'typecheck',
  'autofix-security-tests',
  'lint',
  'build',
  'runtime-route-smoke',
];
const PROTECTED_REFS: Record<string, true> = { main: true, preview: true, develop: true };
const MAX_CHANGED_FILES = 500;
const MAX_CHANGED_FILE_BYTES = 64_000;
const MAX_FINDINGS = 50;
const MAX_FINDING_LENGTHS = { path: 300, message: 1000 };
const PROTECTED_BASENAME =
  /^(?:package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|pnpm-workspace\.yaml|wrangler\.[a-z]+|tsconfig[A-Za-z0-9_.-]*\.json|[A-Za-z0-9_.-]*\.config\.[a-z]+|Dockerfile[A-Za-z0-9_.-]*|[A-Za-z0-9_.-]*\.(?:sh|pem|key|env))$/;
const EXTENSION = /\.(?:ts|tsx|js|jsx|mjs|cjs|scss|css|md|mdx|json)$/;
/** Control characters except tab and newline, plus line/paragraph separators. */
const CONTROL = /(?![\t\n])[\p{Cc}\u2028\u2029]/gu;
/** Line breaks and tabs that a single-line field must not carry into the evidence comment. */
const LINE_BREAKS = /[\t\n\r\u2028\u2029]+/g;

/** Intake rejection with the HTTP status the authenticated executor should see. */
export class PullRequestRejected extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface PullRequestPolicy {
  enabled: boolean;
  allowed: Set<number>;
  auto?: boolean;
}

/** Default closed: review runs only for the literal 'true' flag and an explicit PR allowlist. */
export function pullRequestPolicy(env: Env): PullRequestPolicy {
  const allowed = new Set<number>();
  for (const part of (env.PR_REVIEW_ALLOWED_PRS ?? '').split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (!/^[1-9][0-9]{0,8}$/.test(trimmed)) throw new PullRequestRejected(503, 'Invalid PR_REVIEW_ALLOWED_PRS.');
    allowed.add(Number(trimmed));
  }
  return { enabled: env.PR_REVIEW_ENABLED === 'true', allowed, auto: env.PR_REVIEW_AUTO === 'true' };
}

export function pullRequestKey(identity: PullRequestIdentity): string {
  return `github-pr/${identity.pullNumber}/${identity.headSha}/${identity.baseSha}`;
}

export function parsePullRequestIdentity(value: Record<string, unknown>): PullRequestIdentity {
  if (
    !Number.isSafeInteger(value.pullNumber) ||
    (value.pullNumber as number) < 1 ||
    (value.pullNumber as number) > 999_999_999 ||
    typeof value.headSha !== 'string' ||
    !HEX.test(value.headSha) ||
    typeof value.baseSha !== 'string' ||
    !HEX.test(value.baseSha) ||
    value.headSha === value.baseSha
  )
    throw new PullRequestRejected(400, 'Invalid pull request pin.');
  return {
    source: 'github-pr',
    pullNumber: value.pullNumber as number,
    headSha: value.headSha,
    baseSha: value.baseSha,
  };
}

interface Pull {
  number: number;
  state: string;
  draft?: boolean;
  html_url: string;
  head: { sha: string; ref: string; repo: { full_name: string; fork?: boolean } | null };
  base: { ref: string; repo: { full_name: string } };
  user?: { login?: unknown; type?: unknown };
  mergeable?: boolean | null;
  labels?: { name?: unknown }[];
  changed_files?: number;
  additions?: number;
  deletions?: number;
  title?: unknown;
  body?: unknown;
}

export interface CanonicalPullRequest {
  pullNumber: number;
  headSha: string;
  headRef: string;
  baseRef: string;
  /** Actual current target branch tip, independent of the PR object's lagging base.sha. */
  baseSha: string;
  htmlUrl: string;
  /** Sanitized, bounded canonical title/body: untrusted data. */
  author: string;
  authorBot: boolean;
  mergeable: boolean | null;
  labels: string[] | null;
  changedFilesCount: number;
  additions: number;
  mergeTitle: string | null;
  deletions: number;
  title: string;
  body: string;
}

/**
 * Canonical GitHub facts for one allowlisted PR of the fixed repository. Rejects forks,
 * closed/draft PRs, protected head refs and any base other than develop. Pins are checked
 * separately so stale (409) differs from unauthorized (403).
 */
export async function inspectPullRequest(
  env: Env,
  token: string,
  pullNumber: number,
  policy: PullRequestPolicy,
): Promise<CanonicalPullRequest> {
  if (!policy.enabled) throw new PullRequestRejected(503, 'Pull request review is not enabled.');
  if (!policy.auto && !policy.allowed.has(pullNumber))
    throw new PullRequestRejected(403, 'Pull request is not allowlisted.');
  const repository = `${env.GITHUB_OWNER}/${env.GITHUB_REPOSITORY}`.toLowerCase();
  if (repository !== 'bcsdlab/bcsd_united') throw new PullRequestRejected(503, 'Unexpected repository.');
  let pull: Pull;
  try {
    pull = await github<Pull>(env, token, `/pulls/${pullNumber}`);
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404)
      throw new PullRequestRejected(403, 'Pull request not found in the fixed repository.');
    throw error;
  }
  if (pull.number !== pullNumber) throw new PullRequestRejected(403, 'Pull request identity mismatch.');
  if (pull.state !== 'open' || pull.draft === true)
    throw new PullRequestRejected(403, 'Only open, non-draft pull requests are reviewed.');
  if (
    !pull.head.repo ||
    pull.head.repo.fork === true ||
    pull.head.repo.full_name.toLowerCase() !== repository ||
    pull.base.repo.full_name.toLowerCase() !== repository
  )
    throw new PullRequestRejected(403, 'Fork pull requests are never reviewed.');
  if (pull.base.ref !== 'develop') throw new PullRequestRejected(403, 'Pull request must target develop.');
  if (
    !BRANCH_NAME.test(pull.head.ref) ||
    pull.head.ref.includes('..') ||
    pull.head.ref.startsWith('refs/') ||
    PROTECTED_REFS[pull.head.ref] === true
  )
    throw new PullRequestRejected(403, 'Pull request head ref is protected or invalid.');
  if (!HEX.test(pull.head.sha)) throw new PullRequestRejected(503, 'GitHub returned an invalid head SHA.');
  const base = await github<{ object: { sha: string } }>(env, token, '/git/ref/heads/develop');
  if (!HEX.test(base.object.sha)) throw new PullRequestRejected(503, 'GitHub returned an invalid base SHA.');
  if (typeof pull.html_url !== 'string' || !pull.html_url.startsWith('https://github.com/'))
    throw new PullRequestRejected(503, 'GitHub returned an invalid pull request URL.');
  return {
    pullNumber,
    headSha: pull.head.sha,
    headRef: pull.head.ref,
    baseRef: pull.base.ref,
    baseSha: base.object.sha,
    htmlUrl: pull.html_url,
    title: contextText(pull.title, MAX_CONTEXT_TITLE),
    body: contextText(pull.body, MAX_CONTEXT_BODY),
    author: typeof pull.user?.login === 'string' ? pull.user.login : '',
    authorBot:
      pull.user?.type !== 'User' || (typeof pull.user?.login === 'string' && /\[bot\]$/i.test(pull.user.login)),
    mergeable: pull.mergeable === true ? true : pull.mergeable === false ? false : null,
    labels:
      Array.isArray(pull.labels) && pull.labels.every((label) => typeof label.name === 'string')
        ? pull.labels.map((label) => label.name as string)
        : null,
    changedFilesCount: pull.changed_files ?? -1,
    additions: pull.additions ?? -1,
    deletions: pull.deletions ?? -1,
    mergeTitle:
      typeof pull.title === 'string' &&
      pull.title.length <= 300 &&
      pull.title.trim().length > 0 &&
      !/[\p{Cc}\u2028\u2029]/u.test(pull.title)
        ? pull.title
        : null,
  };
}

export function assertPinned(current: CanonicalPullRequest, identity: PullRequestIdentity): void {
  if (current.headSha !== identity.headSha)
    throw new PullRequestRejected(409, 'Pull request head moved since it was pinned.');
  if (current.baseSha !== identity.baseSha)
    throw new PullRequestRejected(409, 'Target develop moved since it was pinned.');
}

export async function changedFiles(env: Env, token: string, pullNumber: number): Promise<string[]> {
  const files: string[] = [];
  let bytes = 0;
  for (let page = 1; page <= MAX_CHANGED_FILES / 100; page++) {
    const batch = await github<{ filename?: unknown }[]>(
      env,
      token,
      `/pulls/${pullNumber}/files?per_page=100&page=${page}`,
    );
    for (const entry of batch) {
      if (typeof entry.filename !== 'string' || !entry.filename || entry.filename.length > 300)
        throw new Error('Canonical changed file name invalid');
      bytes += encoder.encode(entry.filename).length;
      if (files.length >= MAX_CHANGED_FILES || bytes > MAX_CHANGED_FILE_BYTES)
        throw new Error('Pull request diff exceeds the bounded file list');
      files.push(entry.filename);
    }
    if (batch.length < 100) return files;
  }
  throw new Error('Pull request diff exceeds the bounded file list');
}

export async function preparePullRequest(env: Env, identity: PullRequestIdentity): Promise<PreparedPullRequestJob> {
  if (env.GITHUB_DISPATCH_APP_ID !== '5522353' || env.GITHUB_DISPATCH_INSTALLATION_ID !== '176455083')
    throw new Error('Unexpected GitHub App');
  const token = await installationToken(env, 'read');
  const current = await inspectPullRequest(env, token, identity.pullNumber, pullRequestPolicy(env));
  assertPinned(current, identity);
  const head = await github<{ sha: string; tree: { sha: string } }>(env, token, `/git/commits/${identity.headSha}`);
  if (head.sha !== identity.headSha || !HEX.test(head.tree.sha)) throw new Error('Invalid pinned head commit');
  return {
    mode: 'pull-request',
    owner: 'BCSDLab',
    repository: 'BCSD_united',
    pullNumber: identity.pullNumber,
    headSha: identity.headSha,
    headTree: head.tree.sha,
    headRef: current.headRef,
    baseBranch: 'develop',
    baseSha: identity.baseSha,
    changedFiles: await changedFiles(env, token, identity.pullNumber),
    reviewContext: await reviewContext(env, token, identity.pullNumber, current),
  };
}

const MAX_CONTEXT_ENTRIES = 50;
const MAX_CONTEXT_BYTES = 32_000;
const MAX_CONTEXT_BODY = 2000;
const MAX_CONTEXT_TITLE = 300;
const SECRET_LIKE =
  /(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{32,}\.[A-Za-z0-9_-]{32,})/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const LOGIN = /^[A-Za-z0-9-]{1,100}(?:\[bot\])?$/;

/** Bounded untrusted text: control characters, secret-like tokens and emails removed. */
function contextText(value: unknown, max: number): string {
  const text =
    typeof value === 'string'
      ? value.replace(CONTROL, '').replace(SECRET_LIKE, '[REDACTED]').replace(EMAIL, '[EMAIL]').trim()
      : '';
  return text.length > max ? `${text.slice(0, max)}[TRUNCATED]` : text;
}

interface RawReview {
  user?: { login?: unknown };
  state?: unknown;
  body?: unknown;
  path?: unknown;
  line?: unknown;
  original_line?: unknown;
  created_at?: unknown;
  submitted_at?: unknown;
}

/**
 * Bounded, sanitized review observations from canonical GitHub endpoints, oldest first. Our own
 * automation comments, auth/private fields and secret-like strings are dropped. The result is
 * untrusted evidence for the model to verify against the pinned head, never paths or permissions.
 */
export async function reviewContext(
  env: Env,
  token: string,
  pullNumber: number,
  current: Pick<CanonicalPullRequest, 'title' | 'body'>,
): Promise<ReviewContext> {
  const marker = `<!-- pr-review:${pullNumber}:`;
  const sources: { kind: ReviewContext['comments'][number]['kind']; path: string }[] = [
    { kind: 'review', path: `/pulls/${pullNumber}/reviews?per_page=100` },
    { kind: 'review-comment', path: `/pulls/${pullNumber}/comments?per_page=100` },
    { kind: 'issue-comment', path: `/issues/${pullNumber}/comments?per_page=100` },
  ];
  const collected: ReviewContext['comments'] = [];
  for (const source of sources) {
    for (const item of await github<RawReview[]>(env, token, source.path)) {
      const author = typeof item.user?.login === 'string' ? item.user.login : '';
      if (!LOGIN.test(author)) continue;
      if (typeof item.body === 'string' && item.body.includes(marker)) continue;
      let body = contextText(item.body, MAX_CONTEXT_BODY);
      if (source.kind === 'review' && typeof item.state === 'string' && /^[A-Z_]{1,40}$/.test(item.state))
        body = body ? `[${item.state}] ${body}` : `[${item.state}]`;
      if (!body) continue;
      const stamp = source.kind === 'review' ? item.submitted_at : item.created_at;
      if (typeof stamp !== 'string' || stamp.length > 40 || Number.isNaN(Date.parse(stamp))) continue;
      const path =
        source.kind === 'review-comment' &&
        typeof item.path === 'string' &&
        item.path.length <= 300 &&
        /^[A-Za-z0-9_./$()-]+$/.test(item.path)
          ? item.path
          : null;
      const rawLine = source.kind === 'review-comment' ? (item.line ?? item.original_line) : null;
      const line =
        Number.isSafeInteger(rawLine) && (rawLine as number) >= 0 && (rawLine as number) <= 1_000_000
          ? (rawLine as number)
          : null;
      collected.push({ kind: source.kind, author, createdAt: stamp, path, line, body });
    }
  }
  collected.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const comments: ReviewContext['comments'] = [];
  let bytes = 0;
  for (const entry of collected) {
    const size = encoder.encode(JSON.stringify(entry)).length;
    if (comments.length >= MAX_CONTEXT_ENTRIES || bytes + size > MAX_CONTEXT_BYTES) break;
    bytes += size;
    comments.push(entry);
  }
  return { version: 1, title: current.title, body: current.body, comments };
}

/** Trusted edit policy: related app/package source, tests and docs only; never policy/security files. */
export function allowedPullRequestPath(path: string, changed: readonly string[]): boolean {
  if (
    path.length > 300 ||
    !/^[A-Za-z0-9_./$()-]+$/.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))
  )
    return false;
  const scope = /^(apps|packages)\/([A-Za-z0-9_-]+)\/.+/.exec(path);
  if (!scope) return false;
  const prefix = `${scope[1]}/${scope[2]}/`;
  if (prefix === 'apps/error-automation/') return false;
  if (!changed.some((file) => file.startsWith(prefix))) return false;
  if (!EXTENSION.test(path)) return false;
  const basename = path.slice(path.lastIndexOf('/') + 1);
  if (PROTECTED_BASENAME.test(basename)) return false;
  if (/(?:^|\/)generated\//.test(path) || /routeTree\.gen\./.test(path)) return false;
  if (path === 'apps/api/src/db/schema.ts') return false;
  return true;
}

export function validatePullRequestManifest(manifest: PatchManifest, job: PreparedPullRequestJob): void {
  if (manifest?.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length > 24)
    throw new Error('Invalid correction manifest');
  const names = new Set<string>();
  let total = 0;
  for (const file of manifest.files) {
    if (
      !allowedPullRequestPath(file.path, job.changedFiles) ||
      names.has(file.path) ||
      (file.before !== null && !SHA256.test(file.before)) ||
      (file.content !== null && (typeof file.content !== 'string' || file.content.includes('\0'))) ||
      (file.before === null && file.content === null)
    )
      throw new Error('Forbidden correction entry');
    names.add(file.path);
    if (file.content !== null) {
      const bytes = encoder.encode(file.content).length;
      if (bytes > 256000) throw new Error('Oversized correction file');
      total += bytes;
    }
  }
  if (total > 1000000) throw new Error('Correction exceeds retained bytes');
}

/** Single-line review text: breaks collapse to one space so no field can start a new Markdown line. */
function sanitize(value: unknown, max: number): string {
  if (typeof value !== 'string') throw new Error('Invalid review text');
  const clean = value.replace(LINE_BREAKS, ' ').replace(CONTROL, '').trim();
  if (!clean || clean.length > max) throw new Error('Invalid review text');
  return clean;
}

export function validateReview(value: unknown): PullRequestReview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid review');
  const review = value as Record<string, unknown>;
  if (
    Object.keys(review).sort().join(',') !== 'decision,findings' ||
    (review.decision !== 'approved' && review.decision !== 'changes-requested') ||
    !Array.isArray(review.findings) ||
    review.findings.length > MAX_FINDINGS
  )
    throw new Error('Invalid review');
  const findings = review.findings.map((raw): PullRequestReview['findings'][number] => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid review finding');
    const finding = raw as Record<string, unknown>;
    if (
      Object.keys(finding).sort().join(',') !== 'line,message,path,severity' ||
      !['P1', 'P2', 'P3'].includes(String(finding.severity)) ||
      !Number.isSafeInteger(finding.line) ||
      (finding.line as number) < 0 ||
      (finding.line as number) > 1_000_000
    )
      throw new Error('Invalid review finding');
    return {
      severity: finding.severity as PullRequestReview['findings'][number]['severity'],
      path: sanitize(finding.path, MAX_FINDING_LENGTHS.path),
      line: finding.line as number,
      message: sanitize(finding.message, MAX_FINDING_LENGTHS.message),
    };
  });
  const material = findings.some((finding) => finding.severity !== 'P3');
  if (review.decision === 'approved' && material) throw new Error('Approval conflicts with material findings');
  if (review.decision === 'changes-requested' && !findings.length)
    throw new Error('Changes requested without a finding');
  return { decision: review.decision, findings };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

/** Hash over the canonical key order the executor must also use. */
export async function manifestDigest(manifest: PatchManifest): Promise<string> {
  const canonical: PatchManifest = {
    version: 1,
    files: manifest.files.map((file) => ({ path: file.path, before: file.before, content: file.content })),
  };
  return sha256Hex(encoder.encode(JSON.stringify(canonical)));
}

export async function validatePullRequestVerification(
  job: PreparedPullRequestJob,
  manifest: PatchManifest,
  proof: PullRequestVerification,
): Promise<void> {
  validatePullRequestManifest(manifest, job);
  if (
    proof.headSha !== job.headSha ||
    proof.baseSha !== job.baseSha ||
    proof.headSha === proof.baseSha ||
    !HEX.test(proof.headSha) ||
    !HEX.test(proof.baseSha) ||
    JSON.stringify(proof.passedChecks) !== JSON.stringify(PR_CHECKS)
  )
    throw new Error('Independent pull request verification provenance mismatch');
  if (proof.manifestSha256 !== (await manifestDigest(manifest))) throw new Error('Verified bytes hash mismatch');
}

/** Marker binds the PR, reviewed head, actual base and the verified manifest digest. */
export function reviewMarker(
  job: Pick<PreparedPullRequestJob, 'pullNumber' | 'headSha' | 'baseSha'>,
  proof: Pick<PullRequestVerification, 'manifestSha256'>,
): string {
  return `<!-- pr-review:${job.pullNumber}:${job.headSha}:${job.baseSha}:${proof.manifestSha256} -->`;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.replaceAll('\n', ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Every `before` hash must match the regular (non-symlink) file at the pinned head; new files must not exist. */
async function assertHeadContents(env: Env, token: string, job: PreparedPullRequestJob, manifest: PatchManifest) {
  for (const file of manifest.files) {
    const path = `/contents/${file.path.split('/').map(encodeURIComponent).join('/')}?ref=${job.headSha}`;
    let entry: { type?: string; encoding?: string; content?: string; size?: number } | null;
    try {
      entry = await github(env, token, path);
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) entry = null;
      else throw error;
    }
    if (file.before === null) {
      if (entry !== null) throw new Error('Correction would overwrite an existing head file');
      continue;
    }
    if (!entry || entry.type !== 'file' || entry.encoding !== 'base64' || typeof entry.content !== 'string')
      throw new Error('Correction targets a missing, symlink or oversized head file');
    if ((await sha256Hex(decodeBase64(entry.content))) !== file.before)
      throw new Error('Head file differs from the reviewed content: never overwrite human changes');
  }
}

export interface Published {
  url: string;
  publishedHeadSha: string;
  commentUrl: string;
}

function severityLabel(review: PullRequestReview): string {
  const counts = { P1: 0, P2: 0, P3: 0 };
  for (const finding of review.findings) counts[finding.severity] += 1;
  return `P1 ${counts.P1} / P2 ${counts.P2} / P3 ${counts.P3}`;
}

/** Content of an inline code span: a backtick would close the span, so it cannot survive. */
function inlineCode(value: string): string {
  return value.replaceAll('`', '');
}

/** Inline prose outside code spans: raw HTML and code-span openers render as literal characters. */
function inlineText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('`', '&#96;');
}

export function reviewComment(
  job: PreparedPullRequestJob,
  review: PullRequestReview,
  manifest: PatchManifest,
  proof: PullRequestVerification,
  publishedHeadSha: string,
): string {
  const findings = review.findings.length
    ? review.findings
        .map(
          (finding) =>
            `- **${finding.severity}** \`${inlineCode(finding.path)}:${finding.line}\` — ${inlineText(finding.message)}`,
        )
        .join('\n')
    : '- 없음';
  const corrections = manifest.files.length
    ? manifest.files
        .map(
          (file) =>
            `- \`${inlineCode(file.path)}\` (${file.content === null ? '삭제' : file.before === null ? '추가' : '수정'})`,
        )
        .join('\n')
    : '- 없음 (리뷰 head 유지)';
  return `${reviewMarker(job, proof)}\n\n## 자동 리뷰 결과 (${MODEL_BY_MODE['pull-request']}, 독립 검증)\n\n- 리뷰 head: \`${job.headSha}\`\n- 발행 head: \`${publishedHeadSha}\`\n- base(develop): \`${job.baseSha}\`\n- manifest sha256: \`${proof.manifestSha256}\`\n- 판정: **${review.decision}** (${severityLabel(review)})\n\n### 발견 사항\n\n${findings}\n\n### 적용된 수정\n\n${corrections}\n\n### 독립 검증 통과 항목\n\n${proof.passedChecks.map((check) => `- [x] ${check}`).join('\n')}\n\n### 주의\n\n- 리뷰 판정은 GitHub approval이 아닙니다. merge 여부는 아래 자동 merge 정책으로 별도 결정하며 main 승격과 배포는 수동입니다. PR 제목/본문/diff와 모델 출력은 신뢰할 수 없는 입력으로 취급했습니다.\n- 수정 커밋은 리뷰 head를 부모로 하는 fast-forward만 적용했으며 사람의 변경을 덮어쓰지 않습니다.\n`;
}

/** The fixed App installation's bot; a human or another app can never satisfy this. */
export const PUBLISHER_LOGIN = 'bcsd-united-error-publisher[bot]';
const PUBLISHER_APP_ID = 5522353;

interface IssueComment {
  body?: unknown;
  html_url?: unknown;
  user?: { login?: unknown; type?: unknown };
  performed_via_github_app?: { id?: unknown } | null;
}

export function isPublisherComment(comment: IssueComment): boolean {
  const app = comment.performed_via_github_app;
  return comment.user?.login === PUBLISHER_LOGIN && comment.user.type === 'Bot' && app?.id === PUBLISHER_APP_ID;
}

/** Only our own bot comment carrying the exact proof-bound marker counts as a prior publication. */
async function findExistingComment(
  env: Env,
  token: string,
  job: PreparedPullRequestJob,
  proof: PullRequestVerification,
): Promise<string | null> {
  const needle = reviewMarker(job, proof);
  for (let page = 1; page <= 10; page++) {
    const comments = await github<IssueComment[]>(
      env,
      token,
      `/issues/${job.pullNumber}/comments?per_page=100&page=${page}`,
    );
    const found = comments.find(
      (comment) =>
        isPublisherComment(comment) &&
        typeof comment.body === 'string' &&
        comment.body.includes(needle) &&
        typeof comment.html_url === 'string' &&
        comment.html_url.startsWith('https://github.com/'),
    );
    if (found) return found.html_url as string;
    if (comments.length < 100) return null;
  }
  return null;
}

/**
 * Publishes a verified correction (or none) onto the existing PR head by fast-forward only and
 * posts one evidence comment. Returns the receipt, or throws PullRequestRejected(409) when the
 * PR moved before any remote write.
 */
export async function publishPullRequest(
  env: Env,
  job: PreparedPullRequestJob,
  manifest: PatchManifest,
  review: PullRequestReview,
  proof: PullRequestVerification,
  onPublisherHead: (headSha: string) => Promise<void>,
): Promise<Published> {
  const token = await installationToken(env, 'publish');
  const current = await inspectPullRequest(env, token, job.pullNumber, pullRequestPolicy(env));
  if (current.headRef !== job.headRef) throw new PullRequestRejected(409, 'Pull request head ref changed.');
  if (current.baseSha !== job.baseSha) throw new PullRequestRejected(409, 'Target develop moved since review.');
  let publishedHeadSha = job.headSha;
  if (manifest.files.length) {
    // Blob/tree/commit objects are inert until a ref moves; build them before deciding on staleness.
    await assertHeadContents(env, token, job, manifest);
    const tree: { path: string; mode: '100644'; type: 'blob'; sha: string | null }[] = [];
    for (const file of manifest.files) {
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
      base_tree: job.headTree,
      tree,
    });
    if (current.headSha !== job.headSha) {
      // Lost response on a previous attempt: accept only our own fast-forward commit.
      const head = await github<{ tree: { sha: string }; parents: { sha: string }[] }>(
        env,
        token,
        `/git/commits/${current.headSha}`,
      );
      if (head.tree.sha !== resultTree.sha || head.parents.length !== 1 || head.parents[0].sha !== job.headSha)
        throw new PullRequestRejected(409, 'Pull request head moved since review.');
      await onPublisherHead(current.headSha);
      publishedHeadSha = current.headSha;
    } else {
      const commit = await github<{ sha: string }>(env, token, '/git/commits', 'POST', {
        message: `fix: PR #${job.pullNumber} 자동 리뷰 수정\n\nReviewed-Head: ${job.headSha}\nBase: ${job.baseSha}`,
        tree: resultTree.sha,
        parents: [job.headSha],
      });
      if (!HEX.test(commit.sha)) throw new Error('Invalid generated commit');
      // Persist our generated head before moving the ref: synchronize can race the comment write.
      await onPublisherHead(commit.sha);
      try {
        await github(env, token, `/git/refs/heads/${encodeURIComponent(job.headRef)}`, 'PATCH', {
          sha: commit.sha,
          force: false,
        });
      } catch (error) {
        if (!(error instanceof GitHubError) || error.status !== 422) throw error;
        throw new Error('Pull request head is no longer a fast-forward: never overwrite human changes');
      }
      publishedHeadSha = commit.sha;
    }
  } else if (current.headSha !== job.headSha) {
    throw new PullRequestRejected(409, 'Pull request head moved since review.');
  }
  const existing = await findExistingComment(env, token, job, proof);
  if (existing) return { url: current.htmlUrl, publishedHeadSha, commentUrl: existing };
  const comment = await github<{ html_url: string }>(env, token, `/issues/${job.pullNumber}/comments`, 'POST', {
    body: reviewComment(job, review, manifest, proof, publishedHeadSha),
  });
  if (typeof comment.html_url !== 'string') throw new Error('Comment receipt missing');
  return { url: current.htmlUrl, publishedHeadSha, commentUrl: comment.html_url };
}
