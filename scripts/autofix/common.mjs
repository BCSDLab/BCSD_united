import { readFile } from 'node:fs/promises';

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

export async function jsonFile(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
