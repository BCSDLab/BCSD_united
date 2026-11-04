import { execFileSync } from 'node:child_process';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
