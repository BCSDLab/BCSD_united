import { appendFile, readFile } from 'node:fs/promises';

export function dispatchConfig(env = process.env) {
  return {
    organization: env.SENTRY_ORGANIZATION,
    sentryApps: JSON.parse(env.SENTRY_PROJECT_APPS || '{}'),
    cloudflareSources: JSON.parse(env.CLOUDFLARE_SOURCES || '[]'),
  };
}

export function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
  );
}

export function validateDispatch(event, name, config) {
  if (
    !['workflow_dispatch', 'repository_dispatch'].includes(name) ||
    (name === 'repository_dispatch' && event.action !== 'error-autofix')
  )
    throw new Error('Unsupported dispatch');
  const payload = name === 'workflow_dispatch' ? JSON.parse(event.inputs?.identity ?? 'null') : event.client_payload;
  if (!exactKeys(payload, ['source', 'sourceId', 'project', 'app', 'scope']))
    throw new Error('Unexpected dispatch fields');
  if (
    typeof payload.project !== 'string' ||
    !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(payload.project) ||
    typeof payload.sourceId !== 'string'
  )
    throw new Error('Invalid identity');
  if (payload.source === 'sentry') {
    if (
      !exactKeys(payload.scope, ['organization']) ||
      !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(config.organization ?? '') ||
      payload.scope.organization !== config.organization ||
      !/^[1-9]\d{0,19}$/.test(payload.sourceId) ||
      payload.app !== 'web' ||
      config.sentryApps?.[payload.project] !== 'web'
    )
      throw new Error('Sentry browser identity not allowed');
  } else if (payload.source === 'cloudflare') {
    if (
      !exactKeys(payload.scope, ['accountId', 'policyId', 'workerName']) ||
      typeof payload.scope.accountId !== 'string' ||
      typeof payload.scope.policyId !== 'string' ||
      !/^[a-f0-9]{32}$/.test(payload.sourceId) ||
      !/^[a-f0-9]{32}$/.test(payload.scope.accountId) ||
      !/^[a-f0-9]{32}$/.test(payload.scope.policyId) ||
      payload.scope.workerName !== payload.project ||
      !['web', 'api'].includes(payload.app) ||
      !Array.isArray(config.cloudflareSources) ||
      config.cloudflareSources.filter(
        (entry) =>
          entry &&
          entry.accountId === payload.scope.accountId &&
          typeof entry.policyId === 'string' &&
          entry.policyId.replaceAll('-', '') === payload.scope.policyId &&
          entry.workerName === payload.project &&
          entry.app === payload.app,
      ).length !== 1
    )
      throw new Error('Cloudflare identity not allowed');
  } else throw new Error('Unsupported provider');
  return payload;
}

export function marker(payload) {
  const scope =
    payload.source === 'sentry' ? payload.scope.organization : `${payload.scope.accountId}:${payload.scope.policyId}`;
  return `<!-- error-autofix:${payload.source}:${scope}:${payload.project}:${payload.sourceId} -->`;
}

export function isSourcePath(path) {
  return typeof path === 'string' && /^apps\/(?:web|api)\/src\//.test(path);
}

export function allowedPath(path) {
  if (
    typeof path !== 'string' ||
    !/^[A-Za-z0-9_./$()-]+$/.test(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))
  )
    return false;
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

export function safeRoute(value, hosts) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || !hosts.includes(url.hostname) || url.username || url.password)
      return null;
    if (!/^\/[A-Za-z0-9_/-]*$/.test(url.pathname) || url.pathname.startsWith('//') || url.pathname.includes('..'))
      return null;
    return url.pathname;
  } catch {
    return null;
  }
}

export async function jsonFile(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
export async function output(name, value) {
  if (!/^[A-Za-z0-9_-]+$/.test(name) || /[\r\n]/.test(String(value))) throw new Error('Unsafe workflow output');
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

export async function github(path, options = {}) {
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(30000),
    redirect: 'error',
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
    const found = issues.find(
      (issue) =>
        !issue.pull_request && issue.user?.login === 'github-actions[bot]' && issue.body?.includes(marker(payload)),
    );
    if (found) return found;
    if (issues.length < 100) return null;
  }
  throw new Error('Issue dedup scan exceeded 10000 records; manual reconciliation required');
}
