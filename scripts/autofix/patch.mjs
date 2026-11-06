import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { allowedPath, jsonFile, pullRequestPolicy } from './common.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** `allowed` is the trusted path policy: error mode (default) or a pull-request policy. */
export function validateManifest(manifest, allowed = allowedPath) {
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.files) || manifest.files.length > 24)
    throw new Error('Patch permits at most 24 files');
  let size = 0;
  const paths = new Set();
  for (const file of manifest.files) {
    if (!allowed(file.path) || paths.has(file.path)) throw new Error('Patch contains forbidden or duplicate path');
    paths.add(file.path);
    if (file.before !== null && !/^[a-f0-9]{64}$/.test(file.before)) throw new Error('Invalid baseline hash');
    if (
      file.content !== null &&
      (typeof file.content !== 'string' || Buffer.byteLength(file.content) > 256_000 || file.content.includes('\0'))
    )
      throw new Error('Invalid text patch');
    if (file.content !== null) size += Buffer.byteLength(file.content);
  }
  if (size > 1_000_000) throw new Error('Patch exceeds 1 MB');
  return manifest;
}

async function assertRegular(root, path) {
  for (let part = path; part !== '.'; part = dirname(part)) {
    try {
      const stat = await lstat(resolve(root, part));
      if (stat.isSymbolicLink() || (!stat.isDirectory() && part !== path) || (part === path && !stat.isFile()))
        throw new Error('Only regular files are permitted');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

export async function applyManifest(manifest, root, testsOnly = false, checkBefore = true, allowed = allowedPath) {
  validateManifest(manifest, allowed);
  for (const file of manifest.files) {
    if (testsOnly && !file.path.startsWith('tests/autofix/')) continue;
    await assertRegular(root, file.path);
    let before = null;
    try {
      before = hash(await readFile(resolve(root, file.path)));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (checkBefore && before !== file.before) throw new Error(`Baseline mismatch: ${file.path}`);
  }
  for (const file of manifest.files) {
    if (testsOnly && !file.path.startsWith('tests/autofix/')) continue;
    const target = resolve(root, file.path);
    if (file.content === null) await rm(target);
    else {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content);
    }
  }
}

const blobHash = (bytes) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const TREE_MODES = { 100644: true, 100755: true, 120000: true };
function safeTreePath(path) {
  return !path.split('/').some((part) => !part || part === '.' || part === '..' || /^\.git$/i.test(part));
}

/**
 * The exact blob list of a pinned tree. Only regular files and symlinks are
 * accepted; submodules and unknown modes fail closed.
 */
export function pinnedTree(sha) {
  const entries = [];
  for (const record of execFileSync('git', ['ls-tree', '-r', '-z', '--full-tree', sha], { maxBuffer: 50_000_000 })
    .toString()
    .split('\0')) {
    if (!record) continue;
    const match = /^(\d{6}) (\w+) ([a-f0-9]{40})\t(.+)$/s.exec(record);
    if (!match) throw new Error('Unreadable pinned tree entry');
    const [, mode, type, hash, path] = match;
    if (type !== 'blob' || !Object.hasOwn(TREE_MODES, mode)) throw new Error(`Unsupported pinned tree entry: ${path}`);
    if (!safeTreePath(path)) throw new Error(`Unsafe pinned tree path: ${path}`);
    entries.push({ mode, hash, path });
  }
  return entries;
}

/** Creates one snapshot directory level at a time; an existing level must be a real directory. */
async function snapshotDirectory(root, relative, verified) {
  if (relative === '.' || verified.has(relative)) return;
  await snapshotDirectory(root, dirname(relative), verified);
  const path = resolve(root, relative);
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Snapshot path is not a directory: ${relative}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(path);
  }
  verified.add(relative);
}

/** Creates trusted scratch paths as their owner without traversing symlinks. */
export async function prepareScratch(root, paths) {
  const verified = new Set();
  for (const path of paths) {
    if (!safeTreePath(path)) throw new Error('Unsafe scratch path');
    await snapshotDirectory(resolve(root), path, verified);
  }
}

/**
 * Materialises a pinned tree into an empty `root` from the object database, so
 * tree-controlled `.gitattributes` (`export-ignore`, `export-subst`) cannot
 * shrink or rewrite the snapshot. Symlinks are written as links, never followed.
 */
export async function exportTree(sha, root) {
  const entries = pinnedTree(sha);
  const objects = execFileSync('git', ['cat-file', '--batch'], {
    input: entries.map((entry) => `${entry.hash}\n`).join(''),
    maxBuffer: 100_000_000,
  });
  const verified = new Set();
  let offset = 0;
  for (const entry of entries) {
    const headerEnd = objects.indexOf(0x0a, offset);
    if (headerEnd < 0) throw new Error('Truncated pinned object stream');
    const header = objects.subarray(offset, headerEnd).toString().split(' ');
    const size = Number(header[2]);
    if (header[0] !== entry.hash || header[1] !== 'blob' || !Number.isSafeInteger(size) || size < 0)
      throw new Error(`Pinned object is not the expected blob: ${entry.path}`);
    const start = headerEnd + 1;
    const end = start + size;
    if (end >= objects.length || objects[end] !== 0x0a) throw new Error('Truncated pinned object stream');
    const content = objects.subarray(start, end);
    offset = end + 1;
    await snapshotDirectory(root, dirname(entry.path), verified);
    const destination = resolve(root, entry.path);
    if (entry.mode === '120000') await symlink(content.toString(), destination);
    else await writeFile(destination, content, { mode: entry.mode === '100755' ? 0o755 : 0o644, flag: 'wx' });
  }
  if (offset !== objects.length) throw new Error('Pinned object stream has trailing data');
  return entries;
}

/**
 * Proves the snapshot still equals the pinned tree: every pinned blob/symlink
 * is byte-identical with its executable bit intact, and no file or symlink
 * outside `skip`ped directories was added. Nothing is followed through symlinks.
 */
export async function assertSnapshotMatchesTree(entries, root, skip = () => false) {
  const pinned = new Map(entries.map((entry) => [entry.path, entry]));
  const pending = ['.'];
  while (pending.length) {
    const directory = pending.pop();
    for (const dirent of await readdir(resolve(root, directory), { withFileTypes: true })) {
      const relative = directory === '.' ? dirent.name : `${directory}/${dirent.name}`;
      if (dirent.isDirectory()) {
        if (!skip(relative)) pending.push(relative);
      } else if (!pinned.has(relative)) throw new Error(`Snapshot contains an unpinned path: ${relative}`);
    }
  }
  for (const entry of entries) {
    const path = resolve(root, entry.path);
    const stat = await lstat(path).catch((error) => {
      if (error.code === 'ENOENT') throw new Error(`Snapshot lost a pinned file: ${entry.path}`);
      throw error;
    });
    if (entry.mode === '120000') {
      if (!stat.isSymbolicLink() || blobHash(Buffer.from(await readlink(path))) !== entry.hash)
        throw new Error(`Snapshot differs from the pinned tree: ${entry.path}`);
      continue;
    }
    if (
      !stat.isFile() ||
      ((stat.mode & 0o100) !== 0) !== (entry.mode === '100755') ||
      blobHash(await readFile(path)) !== entry.hash
    )
      throw new Error(`Snapshot differs from the pinned tree: ${entry.path}`);
  }
}

async function collect() {
  const base = process.env.BASE_SHA;
  if (!/^[a-f0-9]{40}$/.test(base ?? '')) throw new Error('Missing trusted base SHA');
  // PR mode: the executor passes the canonical changed-file list; corrections stay
  // inside those related app/package directories and never touch tests/autofix.
  const related = process.env.PR_CHANGED_FILES ? JSON.parse(process.env.PR_CHANGED_FILES) : null;
  const allowed = related ? pullRequestPolicy(related) : allowedPath;
  const git = (args) => execFileSync('git', args, { maxBuffer: 2_000_000 });
  const tracked = git(['diff', '--name-only', '-z', base]).toString().split('\0');
  const scope = related ? ['apps', 'packages'] : ['apps/web/src', 'apps/api/src', 'tests/autofix'];
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z', '--', ...scope])
    .toString()
    .split('\0');
  // A fresh worktree holds no ignored files, so any ignored path here was written
  // by the model and would otherwise vanish from the manifest silently.
  const ignored = git(['ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', ...scope])
    .toString()
    .split('\0')
    .filter(Boolean);
  if (ignored.length) throw new Error(`Agent wrote an ignored path: ${ignored[0]}`);
  const files = [];
  for (const path of new Set([...tracked, ...untracked].filter(Boolean))) {
    if (!allowed(path)) throw new Error(`Agent changed forbidden path: ${path}`);
    await assertRegular('.', path);
    let before = null;
    try {
      before = hash(git(['show', `${base}:${path}`]));
    } catch (error) {
      if (error.status !== 128) throw error;
    }
    let content = null;
    try {
      content = await readFile(path, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    files.push({ path, before, content });
  }
  const manifest = validateManifest({ version: 1, files }, allowed);
  await mkdir('error-patch', { recursive: true });
  await writeFile('error-patch/patch.json', JSON.stringify(manifest));
}
if (process.argv[2] === 'collect') await collect();
if (process.argv[2] === 'apply') await applyManifest(await jsonFile(process.argv[3]), process.argv[4]);
if (process.argv[2] === 'prepare-scratch') await prepareScratch(process.argv[3], process.argv.slice(4));
