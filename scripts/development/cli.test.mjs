import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const sha = 'a'.repeat(40);
const task = {
  schemaVersion: 1,
  id: 'translation',
  kind: 'feature',
  goal: 'Switch language without losing screen state',
  feature: { acceptance: 'Selected language survives navigation' },
  dependencies: [],
  scenarios: [{ id: 'language-switch', expected: 'Localized labels and selected language persist' }],
  targets: { web: { repository: 'BCSDLab/BCSD_united', baseSha: sha, reviewer: 'designated-reviewer' } },
};
const invoke = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'development-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const taskPath = join(root, 'task.json');
  const statePath = join(root, 'state.json');
  await writeFile(taskPath, JSON.stringify(task));
  return { taskPath, statePath };
}

test('CLI preserves existing progress and refuses review without execution evidence', async (t) => {
  const { taskPath, statePath } = await fixture(t);
  let result = invoke('init', taskPath, statePath);
  assert.equal(result.status, 0, result.stderr);
  result = invoke('implement', taskPath, statePath, 'web', sha, 'https://github.com/BCSDLab/BCSD_united/pull/42');
  assert.notEqual(result.status, 0, 'UI work without a Figma output must be refused');
  result = invoke(
    'implement',
    taskPath,
    statePath,
    'web',
    sha,
    'https://github.com/BCSDLab/BCSD_united/pull/42',
    'https://www.figma.com/design/example?node-id=1-2',
    '100',
  );
  assert.equal(result.status, 0, result.stderr);
  result = invoke(
    'review',
    taskPath,
    statePath,
    'web',
    sha,
    'designated-reviewer',
    'https://github.com/BCSDLab/BCSD_united/pull/42#pullrequestreview-1',
  );
  assert.notEqual(result.status, 0);
  const before = await readFile(statePath, 'utf8');
  result = invoke('init', taskPath, statePath);
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(statePath, 'utf8'), before);
  result = invoke('status', taskPath, statePath);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).complete, false);
});

test('CLI refuses changed requirements instead of reusing approval state', async (t) => {
  const { taskPath, statePath } = await fixture(t);
  const initialized = invoke('init', taskPath, statePath);
  assert.equal(initialized.status, 0, initialized.stderr);
  await writeFile(taskPath, JSON.stringify({ ...task, goal: 'Changed user-visible behavior' }));
  const result = invoke('report', taskPath, statePath);
  assert.notEqual(result.status, 0);
});
