import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { allowedPath, allowedPullRequestPath, isSourcePath, relatedDirectories } from './common.mjs';

const TOOL_NAMES = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];
const MAX_TEXT_BYTES = 256_000;
const MAX_RESULT = 10_000;
const MAX_FILES = 24;

/** Error mode: redacted diagnostics plus the two application src trees; writes only in the observed app. */
export function errorToolScope(app) {
  if (!['web', 'api'].includes(app)) throw new Error('Unknown application scope');
  return {
    mode: 'error',
    readable: (name) =>
      name === 'error-input/diagnostics.json' ||
      /^apps\/(?:web|api)\/src(?:\/|$)/.test(name) ||
      /^tests\/autofix(?:\/|$)/.test(name),
    writable: (name) => allowedPath(name) && (!isSourcePath(name) || name.startsWith(`apps/${app}/src/`)),
  };
}

const PR_UNREADABLE =
  /(?:^|\/)(?:\.env[^/]*|\.dev\.vars[^/]*|[^/]*\.(?:pem|p12|key)|webhook-secret\.txt|google-auth-secret\.txt)$/;

const PR_PUBLIC_ROOT =
  /^(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*\.json|README\.md|CONTRIBUTING\.md)$/;

/**
 * PR mode: trusted review inputs, every related app/package tree, the public
 * root dependency/config files and every canonical changed file are readable
 * (bounded by the Read tool); writes follow the PR correction policy only.
 */
export function pullRequestToolScope(changedFiles) {
  const related = relatedDirectories(changedFiles);
  const changed = new Set(changedFiles);
  const inside = (name) => {
    const match = /^(apps|packages)\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(name);
    return Boolean(match) && related.has(`${match[1]}/${match[2]}`);
  };
  return {
    mode: 'pull-request',
    readable: (name) =>
      name === 'pr-input/review.json' ||
      name === 'pr-input/diff.patch' ||
      name === 'pr-input' ||
      (!PR_UNREADABLE.test(name) && (inside(name) || PR_PUBLIC_ROOT.test(name) || changed.has(name))),
    writable: (name) => allowedPullRequestPath(name, related),
  };
}

function relativeFile(root, input, mode, scope) {
  if (typeof input !== 'string' || !input || input.includes('\0') || input.includes('://'))
    throw new Error('An explicit local source path is required');
  const lineRange = mode === 'read' ? /:(\d+)(?:-(\d+))?$/.exec(input) : null;
  const name = lineRange ? input.slice(0, lineRange.index) : input;
  if (
    !/^[A-Za-z0-9_./$()-]+$/.test(name) ||
    name.split('/').some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))
  )
    throw new Error('Unsafe source path');
  const path = resolve(root, name);
  if (!path.startsWith(`${root}${sep}`) || relative(root, path) !== name) throw new Error('Path escaped workspace');
  if (mode === 'write' ? !scope.writable(name) : !scope.readable(name))
    throw new Error('Path is outside allowed application source');
  return { name, path, lineRange };
}

async function noSymlinks(root, target) {
  for (let current = target; current !== root; current = dirname(current)) {
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Symlinks are forbidden in model tools');
      if (current !== target && !stat.isDirectory()) throw new Error('Non-directory path component');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

async function listFiles(root, folder, max = 300) {
  const files = [];
  const pending = [folder];
  while (pending.length) {
    const directory = pending.pop();
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (item.isSymbolicLink() || item.name.startsWith('.')) continue;
      const path = resolve(directory, item.name);
      if (item.isDirectory()) pending.push(path);
      else if (item.isFile()) files.push(path);
      if (files.length + pending.length > max) throw new Error('Source listing too large; narrow the directory');
    }
  }
  return files.sort();
}

function exact(input, keys) {
  return (
    input &&
    typeof input === 'object' &&
    !Array.isArray(input) &&
    Object.keys(input).sort().join(',') === keys.sort().join(',')
  );
}

/**
 * No model-provided command, URL, secret path or JS callback enters this dispatcher.
 * `scope` is a trusted {@link errorToolScope} or {@link pullRequestToolScope}.
 */
export function sourceTools(root, scope, tracked) {
  const changed = new Set();
  async function apply(name, input) {
    if (!TOOL_NAMES.includes(name)) throw new Error('Tool unavailable');
    const fields = {
      Read: ['path'],
      Write: ['path', 'content'],
      Edit: ['path', 'oldText', 'newText'],
      Glob: ['path'],
      Grep: ['path', 'pattern'],
    };
    if (!exact(input, fields[name])) throw new Error('Unexpected tool input fields');
    const mode = name === 'Write' || name === 'Edit' ? 'write' : 'read';
    const { name: file, path, lineRange } = relativeFile(root, input.path, mode, scope);
    await noSymlinks(root, path);
    if (name === 'Read') {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.size > 1_000_000) throw new Error('Read requires a bounded regular file');
      const text = await readFile(path, 'utf8');
      if (text.includes('\0')) throw new Error('Binary source is forbidden');
      if (lineRange) {
        const start = Number(lineRange[1]);
        const end = lineRange[2] ? Number(lineRange[2]) : start;
        if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(end) || end < start || end - start > 200)
          throw new Error('Invalid line range');
        return text
          .split('\n')
          .slice(start - 1, end)
          .map((line, index) => `${start + index}:${line}`)
          .join('\n')
          .slice(0, MAX_RESULT);
      }
      return text.slice(0, MAX_RESULT);
    }
    if (name === 'Glob' || name === 'Grep') {
      const stat = await lstat(path);
      if (!stat.isDirectory() && !stat.isFile()) throw new Error('Search requires a regular source path');
      const files = stat.isFile() ? [path] : await listFiles(root, path);
      const scoped = files.filter((candidate) => {
        const rel = relative(root, candidate);
        return rel.split('/').every((part) => !part.startsWith('.')) && scope.readable(rel);
      });
      if (name === 'Glob')
        return scoped
          .map((item) => relative(root, item))
          .join('\n')
          .slice(0, MAX_RESULT);
      if (typeof input.pattern !== 'string' || !input.pattern || input.pattern.length > 200)
        throw new Error('Grep requires a bounded literal substring');
      const hits = [];
      for (const candidate of scoped) {
        const stat = await lstat(candidate);
        if (stat.size > MAX_TEXT_BYTES) continue;
        const lines = (await readFile(candidate, 'utf8')).split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          if (lines[i].includes(input.pattern)) hits.push(`${relative(root, candidate)}:${i + 1}:${lines[i]}`);
          if (hits.length >= 80) return hits.join('\n').slice(0, MAX_RESULT);
        }
      }
      return hits.join('\n').slice(0, MAX_RESULT);
    }
    if (name === 'Write' && typeof input.content !== 'string') throw new Error('Write content must be text');
    if (name === 'Edit' && (typeof input.oldText !== 'string' || !input.oldText || typeof input.newText !== 'string'))
      throw new Error('Edit requires nonempty old text and replacement text');
    if (file.startsWith('tests/autofix/') && tracked.has(file))
      throw new Error('Existing regression tests are immutable');
    if (!changed.has(file) && changed.size >= MAX_FILES) throw new Error('Patch file count exceeded');
    let content = input.content;
    if (name === 'Edit') {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.size > MAX_TEXT_BYTES) throw new Error('Edit requires bounded regular source');
      const before = await readFile(path, 'utf8');
      const at = before.indexOf(input.oldText);
      if (at < 0 || before.indexOf(input.oldText, at + input.oldText.length) >= 0)
        throw new Error('Edit old text must occur exactly once');
      content = before.slice(0, at) + input.newText + before.slice(at + input.oldText.length);
    }
    if (Buffer.byteLength(content) > MAX_TEXT_BYTES || content.includes('\0'))
      throw new Error('Source edit exceeds text limit');
    await mkdir(dirname(path), { recursive: true });
    await noSymlinks(root, path);
    await writeFile(path, content, { flag: 'w' });
    changed.add(file);
    return `Updated ${file}`;
  }
  return { apply };
}
