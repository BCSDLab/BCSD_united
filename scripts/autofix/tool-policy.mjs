import { realpath, lstat } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export function permitted(tool, path) {
  const source = /^apps\/(?:web|api)\/src(?:\/|$)/.test(path);
  const readable =
    source || path === 'tests/autofix' || path.startsWith('tests/autofix/') || path === 'error-input/diagnostics.json';
  const writable =
    (/^apps\/(?:web|api)\/src\//.test(path) && path !== 'apps/api/src/db/schema.ts') ||
    /^tests\/autofix\/[A-Za-z0-9_-]+\.test\.mjs$/.test(path);
  if (
    ['Edit', 'Write'].includes(tool) &&
    ((/(?:^|\/)(?:__tests__|tests|fixtures)(?:\/|$)/.test(path) && !path.startsWith('tests/autofix/')) ||
      (/\.(?:test|spec)\.[^.]+$/.test(path) && source))
  )
    return false;
  if (
    path.split('/').some((part) => part.startsWith('.')) ||
    /^apps\/(?:web|api)\/src\/generated\//.test(path) ||
    path.includes('routeTree.gen.')
  )
    return false;
  return ['Read', 'Glob', 'Grep'].includes(tool) ? readable : ['Edit', 'Write'].includes(tool) && writable;
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 1_000_000) throw new Error('Tool request too large');
  }
  const request = JSON.parse(input);
  const value = request.tool_input?.file_path ?? request.tool_input?.path;
  if (typeof value !== 'string') throw new Error('An explicit allowed file/directory path is required');
  const root = await realpath(process.cwd());
  const target = resolve(root, value);
  const path = relative(root, target).replaceAll('\\', '/');
  if (isAbsolute(path) || !permitted(request.tool_name, path))
    throw new Error('Tool path is outside the diagnostic/source/test sandbox');
  let ancestor = target;
  for (;;) {
    try {
      const info = await lstat(ancestor);
      if (info.isSymbolicLink()) throw new Error('Symlink access denied');
      const physical = await realpath(ancestor);
      const contained = relative(root, physical).replaceAll('\\', '/');
      if (
        contained !== relative(root, ancestor).replaceAll('\\', '/') ||
        contained.startsWith('../') ||
        isAbsolute(contained)
      )
        throw new Error('Path escapes source sandbox');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      ancestor = dirname(ancestor);
    }
  }
  if (request.tool_name === 'Grep' || request.tool_name === 'Glob') {
    if (path === 'error-input/diagnostics.json' || request.tool_input?.pattern?.includes('..'))
      throw new Error('Invalid search scope');
    if (
      request.tool_name === 'Glob' &&
      (/^[/\\]/.test(request.tool_input.pattern ?? '') || /^[A-Za-z]:/.test(request.tool_input.pattern ?? ''))
    )
      throw new Error('Absolute glob patterns are denied');
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('Denied: only source files, regression tests, and diagnostic JSON may be accessed.\n');
    process.exitCode = 2;
  });
}
