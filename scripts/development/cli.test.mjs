import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
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
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const taskPath = join(root, 'task.json');
  const statePath = join(root, 'state.json');
  await writeFile(taskPath, JSON.stringify(task));
  return { root, taskPath, statePath };
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// 빌드는 통과하고 시나리오는 항상 실패하는 프로필이다. 빌드가 실행될 때마다 runs.log에 한 줄이 쌓인다.
async function verifiable(t) {
  const f = await fixture(t);
  const checkout = join(f.root, 'checkout');
  await mkdir(checkout);
  git(checkout, 'init', '--initial-branch=main');
  git(checkout, 'config', 'user.name', 'Development fixture');
  git(checkout, 'config', 'user.email', 'fixture@example.invalid');
  git(checkout, 'config', 'commit.gpgSign', 'false');
  git(checkout, 'config', 'core.hooksPath', join(f.root, 'no-hooks'));
  git(checkout, 'remote', 'add', 'origin', 'https://github.com/BCSDLab/BCSD_united.git');
  await writeFile(join(checkout, 'fixture.txt'), 'base');
  git(checkout, 'add', 'fixture.txt');
  git(checkout, 'commit', '-m', 'fixture base');
  const baseSha = git(checkout, 'rev-parse', 'HEAD');
  await writeFile(join(checkout, 'fixture.txt'), 'candidate');
  git(checkout, 'add', 'fixture.txt');
  git(checkout, 'commit', '-m', 'fixture candidate');
  const head = git(checkout, 'rev-parse', 'HEAD');
  const marker = join(f.root, 'runs.log');
  const profilePath = join(f.root, 'profile.json');
  await writeFile(f.taskPath, JSON.stringify({ ...task, targets: { web: { ...task.targets.web, baseSha } } }));
  await writeFile(
    profilePath,
    JSON.stringify({
      checkout,
      repository: 'BCSDLab/BCSD_united',
      steps: [
        {
          id: 'build',
          kind: 'build',
          command: [process.execPath, '-e', `require("node:fs").appendFileSync(${JSON.stringify(marker)}, "run\\n")`],
        },
        {
          id: 'language-switch',
          kind: 'scenario',
          scenarioId: 'language-switch',
          command: [
            process.execPath,
            '-e',
            'console.log("opened settings"); console.error("labels stayed in Korean"); process.exit(1)',
          ],
        },
      ],
    }),
  );
  let result = invoke('init', f.taskPath, f.statePath);
  assert.equal(result.status, 0, result.stderr);
  result = invoke(
    'implement',
    f.taskPath,
    f.statePath,
    'web',
    head,
    'https://github.com/BCSDLab/BCSD_united/pull/42',
    'https://www.figma.com/design/example?node-id=1-2',
    '100',
  );
  assert.equal(result.status, 0, result.stderr);
  return {
    ...f,
    head,
    verify: (round) => invoke('verify', f.taskPath, f.statePath, 'web', profilePath, join(f.root, `evidence-${round}`)),
    runs: async () => (await readFile(marker, 'utf8')).split('\n').filter(Boolean).length,
  };
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

test('CLI stops verifying after the failed-round limit until the designated reviewer hands back', async (t) => {
  const f = await verifiable(t);
  assert.equal(f.verify(1).status, 1);
  assert.equal(f.verify(2).status, 1);
  assert.equal(await f.runs(), 2);
  let result = f.verify(3);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Verification rounds exhausted for web; a human must review and run handback/);
  assert.equal(await f.runs(), 2, 'an exhausted platform must not execute the profile');
  result = invoke('next', f.taskPath, f.statePath);
  assert.equal(result.stdout, 'web: escalated - 2 failed rounds; reviewer designated-reviewer must run handback\n');
  result = invoke('handback', f.taskPath, f.statePath, 'web', 'someone-else', 'Looked at the failure');
  assert.notEqual(result.status, 0);
  assert.equal(f.verify(4).status, 1);
  assert.equal(await f.runs(), 2);
  result = invoke('handback', f.taskPath, f.statePath, 'web', 'designated-reviewer', 'Fixture label was stale');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).platforms.web.escalated, false);
  const { handbacks } = JSON.parse(await readFile(f.statePath, 'utf8')).platforms.web;
  assert.equal(handbacks.length, 1);
  assert.equal(handbacks[0].note, 'Fixture label was stale');
  assert.equal(handbacks[0].sha, f.head);
  assert.equal(f.verify(5).status, 1);
  assert.equal(await f.runs(), 3);
});

test('CLI next tells a new session what to do, with the failing output when a fix is needed', async (t) => {
  const f = await verifiable(t);
  let result = invoke('next', f.taskPath, f.statePath);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `web: verify - ${f.head.slice(0, 7)} not verified\n`);
  assert.equal(f.verify(1).status, 1);
  result = invoke('next', f.taskPath, f.statePath);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    'web: fix - verification failed: Every task scenario requires successful matching command evidence\n' +
      '  labels stayed in Korean\n' +
      '  opened settings\n',
  );
});

test('CLI next lists blocked dependencies after the platform lines', async (t) => {
  const { taskPath, statePath } = await fixture(t);
  const dependencies = [{ id: 'api', status: 'blocked', detail: 'Contract not published' }];
  await writeFile(taskPath, JSON.stringify({ ...task, dependencies }));
  const initialized = invoke('init', taskPath, statePath);
  assert.equal(initialized.status, 0, initialized.stderr);
  const result = invoke('next', taskPath, statePath);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    'web: implement - no implementation recorded\nblocked dependency api: Contract not published\n',
  );
});
