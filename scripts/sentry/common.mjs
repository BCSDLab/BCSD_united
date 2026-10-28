import { appendFile, readFile } from 'node:fs/promises';

export function validateDispatch(event, name, config) {
  const payload = name === 'workflow_dispatch'
    ? { sentryIssueId: event.inputs?.sentryIssueId, sentryProject: event.inputs?.sentryProject, sentryOrganization: config.organization }
    : event.client_payload;
  if (!['workflow_dispatch', 'repository_dispatch'].includes(name)
      || (name === 'repository_dispatch' && event.action !== 'sentry-autofix')) throw new Error('Unsupported dispatch');
  if (!payload || Object.keys(payload).sort().join(',') !== 'sentryIssueId,sentryOrganization,sentryProject') throw new Error('Unexpected dispatch fields');
  if (!/^[1-9]\d{0,19}$/.test(payload.sentryIssueId ?? '') || typeof payload.sentryIssueId !== 'string') throw new Error('Invalid Sentry issue ID');
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(config.organization ?? '') || payload.sentryOrganization !== config.organization) throw new Error('Organization not allowed');
  if (!/^[a-z0-9][a-z0-9_-]{0,99}$/.test(payload.sentryProject ?? '') || !config.projects.includes(payload.sentryProject)) throw new Error('Project not allowed');
  return payload;
}

export function marker(payload) {
  return `<!-- sentry-autofix:${payload.sentryOrganization}:${payload.sentryProject}:${payload.sentryIssueId} -->`;
}

export function isSourcePath(path) {
  return typeof path === 'string' && /^apps\/(?:web|api)\/src\//.test(path);
}

export function allowedPath(path) {
  if (typeof path !== 'string' || !/^[A-Za-z0-9_./$()-]+$/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) return false;
  return (isSourcePath(path) && /\.(?:ts|tsx|js|jsx|scss|css)$/.test(path) && !/^apps\/(?:web|api)\/src\/generated\//.test(path) && path !== 'apps/api/src/db/schema.ts' && !/routeTree\.gen\./.test(path))
    || /^tests\/sentry\/[A-Za-z0-9_-]+\.test\.mjs$/.test(path);
}

export function safeRoute(value, hosts) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || !hosts.includes(url.hostname) || url.username || url.password) return null;
    if (!/^\/[A-Za-z0-9_/-]*$/.test(url.pathname) || url.pathname.startsWith('//') || url.pathname.includes('..')) return null;
    return url.pathname;
  } catch { return null; }
}

export async function jsonFile(path) { return JSON.parse(await readFile(path, 'utf8')); }
export async function output(name, value) {
  if (!/^[A-Za-z0-9_-]+$/.test(name) || /[\r\n]/.test(String(value))) throw new Error('Unsafe workflow output');
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

export async function github(path, options = {}) {
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`, {
    method: options.method ?? 'GET',
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(30000), redirect: 'error',
  });
  if (!response.ok) {
    const error = new Error(`GitHub ${response.status} for ${path.split('?')[0]}`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

export async function findIssue(payload) {
  for (let page = 1; page <= 100; page += 1) {
    const issues = await github(`/issues?state=all&per_page=100&page=${page}`);
    const found = issues.find((issue) => !issue.pull_request && issue.user?.login === 'github-actions[bot]' && issue.body?.includes(marker(payload)));
    if (found) return found;
    if (issues.length < 100) return null;
  }
  throw new Error('Issue dedup scan exceeded 10000 records; manual reconciliation required');
}
