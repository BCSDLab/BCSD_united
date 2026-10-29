import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { allowedPath, isSourcePath } from './common.mjs';

const TOOL_NAMES = ['Read', 'Edit', 'Write', 'Glob', 'Grep'];
const MAX_TEXT_BYTES = 256_000;
const MAX_RESULT = 10_000;
const MAX_FILES = 24;

function relativeFile(root, input, mode, app) {
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
  const readable =
    name === 'error-input/diagnostics.json' ||
    /^apps\/(?:web|api)\/src(?:\/|$)/.test(name) ||
    /^tests\/autofix(?:\/|$)/.test(name);
  const writable = allowedPath(name) && (!isSourcePath(name) || name.startsWith(`apps/${app}/src/`));
  if (mode === 'write' ? !writable : !readable) throw new Error('Path is outside allowed application source');
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

/** No model-provided command, URL, secret path or JS callback enters this dispatcher. */
export function sourceTools(root, app, tracked) {
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
    const { name: file, path, lineRange } = relativeFile(root, input.path, mode, app);
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
        return (
          rel === 'error-input/diagnostics.json' ||
          /^apps\/(?:web|api)\/src\//.test(rel) ||
          rel.startsWith('tests/autofix/')
        );
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
