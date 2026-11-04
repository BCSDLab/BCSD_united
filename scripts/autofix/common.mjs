import { readFile } from 'node:fs/promises';

export const SHA = /^[a-f0-9]{40}$/;
export const ERROR_CHECKS = [
  'regression-fails-on-base',
  'regression-passes-on-fix',
  'native-fixture-tests',
  'typecheck',
  'autofix-security-tests',
  'lint',
  'build',
  'runtime-route-smoke',
];
export const PR_CHECKS = [
  'pr-head-pinned',
  'native-fixture-tests',
  'typecheck',
  'autofix-security-tests',
  'lint',
  'build',
  'runtime-route-smoke',
];
export const PR_MAX_CHANGED_FILES = 500;
export const PR_MAX_CHANGED_BYTES = 64_000;

export function isSourcePath(path) {
  return typeof path === 'string' && /^apps\/(?:web|api)\/src\//.test(path);
}

function safeSegments(path) {
  return (
    typeof path === 'string' &&
    /^[A-Za-z0-9_./$()-]+$/.test(path) &&
    !path.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))
  );
}

export function allowedPath(path) {
  if (!safeSegments(path)) return false;
  if (/(?:^|\/)(?:__tests__|tests|fixtures)(?:\/|$)/.test(path) && !path.startsWith('tests/autofix/')) return false;
  if (isSourcePath(path) && /\.(?:test|spec)\.[^.]+$/.test(path)) return false;
  return (
    (isSourcePath(path) &&
      /\.(?:ts|tsx|js|jsx|scss|css)$/.test(path) &&
      !/^apps\/(?:web|api)\/src\/generated\//.test(path) &&
      path !== 'apps/api/src/db/schema.ts' &&
      !/routeTree\.gen\./.test(path)) ||
    /^tests\/autofix\/[A-Za-z0-9_-]+\.test\.mjs$/.test(path)
  );
}

/**
 * Canonical GitHub pull-request filenames are untrusted data: bounded count,
 * bounded bytes, plain relative paths, no duplicates. Dotfiles are allowed here
 * because a PR may legitimately touch `.github/` or `.gitignore`; those paths only
 * drive the related-directory set and are never writable by the model.
 */
export function validateChangedFiles(value) {
  if (!Array.isArray(value) || value.length > PR_MAX_CHANGED_FILES) throw new Error('Invalid changed file list');
  const seen = new Set();
  let bytes = 0;
  for (const path of value) {
    if (
      typeof path !== 'string' ||
      !path ||
      path.length > 300 ||
      !/^[A-Za-z0-9_.@/$()+ -]+$/.test(path) ||
      path.split('/').some((part) => !part || part === '.' || part === '..') ||
      seen.has(path)
    )
      throw new Error('Invalid changed file path');
    seen.add(path);
    bytes += Buffer.byteLength(path);
  }
  if (bytes > PR_MAX_CHANGED_BYTES) throw new Error('Changed file list exceeds byte bound');
  return value;
}

const CONTROL = /(?![\t\n])[\p{Cc}\u2028\u2029]/u;
const SAFE_PATH = /^[A-Za-z0-9_.@/$()+ -]+$/;

/**
 * Existing GitHub review/comment context is untrusted DATA for the model:
 * bounded count/length, plain text, canonical author handles. Absent context
 * means the PR has no comments. Returns the normalized object.
 */
export function validateReviewContext(value) {
  if (value === undefined) return { version: 1, comments: [] };
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1)
    throw new Error('Invalid review context');
  const keys = Object.keys(value).sort().join(',');
  if (!['comments,version', 'body,comments,title,version'].includes(keys)) throw new Error('Invalid review context');
  const text = (field, max) => {
    if (typeof field !== 'string' || field.length > max || CONTROL.test(field)) throw new Error('Invalid review text');
    return field;
  };
  if (!Array.isArray(value.comments) || value.comments.length > 50) throw new Error('Invalid review comments');
  const comments = value.comments.map((comment) => {
    if (
      !comment ||
      typeof comment !== 'object' ||
      Array.isArray(comment) ||
      Object.keys(comment).sort().join(',') !== 'author,body,createdAt,kind,line,path' ||
      !['issue-comment', 'review', 'review-comment'].includes(comment.kind) ||
      typeof comment.author !== 'string' ||
      !/^[A-Za-z0-9-]{1,100}(?:\[bot\])?$/.test(comment.author) ||
      typeof comment.createdAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(comment.createdAt) ||
      !(
        comment.path === null ||
        (typeof comment.path === 'string' &&
          comment.path.length <= 300 &&
          SAFE_PATH.test(comment.path) &&
          !comment.path.split('/').some((part) => !part || part === '.' || part === '..'))
      ) ||
      !(comment.line === null || (Number.isSafeInteger(comment.line) && comment.line >= 0 && comment.line <= 1_000_000))
    )
      throw new Error('Invalid review comment');
    return { ...comment, body: text(comment.body, 4000) };
  });
  const normalized =
    keys === 'comments,version'
      ? { version: 1, comments }
      : { version: 1, title: text(value.title, 300), body: text(value.body, 4000), comments };
  if (Buffer.byteLength(JSON.stringify(normalized)) > 64_000) throw new Error('Review context exceeds byte bound');
  return normalized;
}

/** `apps/<x>` and `packages/<x>` directories a pull request touches. */
export function relatedDirectories(changedFiles) {
  const related = new Set();
  for (const path of validateChangedFiles(changedFiles)) {
    const match = /^(apps|packages)\/([A-Za-z0-9_-]+)\//.exec(path);
    if (match) related.add(`${match[1]}/${match[2]}`);
  }
  return related;
}

const REPOSITORY_WIDE =
  /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc|\.nvmrc|tsconfig[^/]*\.json|\.oxlintrc[^/]*|oxlint[^/]*|\.github\/.*)$/;
const BBOT_DIRECTORIES = ['apps/b-bot', 'apps/b-bot-crawler', 'packages/b-bot-ai', 'packages/b-bot-database'];

/**
 * Runtime verification profiles are an allowlist derived from the canonical
 * changed files, never from anything the PR itself says. Root dependency or
 * toolchain changes affect every app; a PR touching no runtime app at all is
 * verified repository-wide rather than skipped.
 */
export function runtimeProfiles(changedFiles) {
  const related = relatedDirectories(changedFiles);
  const profiles = new Set();
  if (related.has('apps/web') || related.has('packages/telemetry')) profiles.add('web');
  if (related.has('apps/api') || related.has('packages/telemetry')) profiles.add('api');
  if (BBOT_DIRECTORIES.some((directory) => related.has(directory))) profiles.add('b-bot');
  const repositoryWide = changedFiles.some((path) => REPOSITORY_WIDE.test(path));
  return repositoryWide || !profiles.size ? new Set(['web', 'api', 'b-bot']) : profiles;
}

const PR_PROTECTED_FILE =
  /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|pnpm-workspace\.yaml|\.npmrc|\.pnpmfile\.cjs|wrangler[^/]*|tsconfig[^/]*|[^/]*\.config\.[^/]+|Dockerfile[^/]*|[^/]*\.sh|\.env[^/]*|[^/]*\.pem|[^/]*\.key|[^/]*\.p12)$/;

/**
 * Pull-request corrections may touch only source/tests/docs inside a related
 * app or package directory. Policy files, secrets, workflows, the automation
 * pipeline and the error regression area are never model-writable; a PR that
 * needs such a change must be reported blocked instead.
 */
export function allowedPullRequestPath(path, related) {
  if (!safeSegments(path) || path.length > 300) return false;
  if (!/\.(?:ts|tsx|js|jsx|mjs|cjs|scss|css|md|mdx|json)$/.test(path)) return false;
  if (PR_PROTECTED_FILE.test(path)) return false;
  if (/^(?:\.github|scripts|tests|apps\/error-automation)\//.test(path)) return false;
  if (/(?:^|\/)generated\//.test(path) || /routeTree\.gen\./.test(path)) return false;
  if (path === 'apps/api/src/db/schema.ts') return false;
  const match = /^(apps|packages)\/([A-Za-z0-9_-]+)\/.+/.exec(path);
  return Boolean(match) && related.has(`${match[1]}/${match[2]}`);
}

export function pullRequestPolicy(changedFiles) {
  const related = relatedDirectories(changedFiles);
  return (path) => allowedPullRequestPath(path, related);
}

export async function jsonFile(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
