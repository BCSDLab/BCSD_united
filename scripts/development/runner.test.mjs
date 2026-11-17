import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runProfile } from './runner.mjs';

const repository = 'BCSDLab/development-fixture';
const node = (script) => [process.execPath, '-e', script];
const build = { id: 'build', kind: 'build', command: node('console.log("build complete")') };
const scenario = {
  id: 'consumer',
  kind: 'scenario',
  scenarioId: 'consumer',
  command: node('console.log("consumer scenario complete")'),
};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'development-runner-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const checkout = path.join(root, 'candidate');
  await mkdir(checkout);
  git(checkout, 'init', '--initial-branch=main');
  git(checkout, 'config', 'user.name', 'Development fixture');
  git(checkout, 'config', 'user.email', 'fixture@example.invalid');
  git(checkout, 'config', 'commit.gpgSign', 'false');
  git(checkout, 'config', 'core.hooksPath', path.join(root, 'no-hooks'));
  git(checkout, 'remote', 'add', 'origin', `https://github.com/${repository}.git`);
  await writeFile(path.join(checkout, '.gitignore'), 'build-output/\n');
  await writeFile(path.join(checkout, 'fixture.txt'), 'base');
  git(checkout, 'add', '.gitignore', 'fixture.txt');
  git(checkout, 'commit', '-m', 'fixture base');
  const baseSha = git(checkout, 'rev-parse', 'HEAD');
  await writeFile(path.join(checkout, 'fixture.txt'), 'candidate');
  git(checkout, 'add', 'fixture.txt');
  git(checkout, 'commit', '-m', 'fixture candidate');
  const sha = git(checkout, 'rev-parse', 'HEAD');
  const task = {
    schemaVersion: 1,
    id: 'consumer-feature',
    kind: 'feature',
    goal: 'Verify a local consumer scenario',
    scenarios: [{ id: 'consumer', expected: 'Consumer command succeeds' }],
    targets: { web: { repository, baseSha, reviewer: 'fixture-reviewer' } },
    dependencies: [],
    feature: { acceptance: 'Build and consumer succeed' },
  };
  return {
    root,
    checkout,
    task,
    sha,
    outputDir: path.join(root, 'evidence'),
    profile: { checkout, repository, steps: [build, scenario] },
  };
}

function run(f, overrides = {}) {
  return runProfile({
    task: f.task,
    platform: 'web',
    profile: f.profile,
    sha: f.sha,
    outputDir: f.outputDir,
    ...overrides,
  });
}

async function commit(f, files) {
  for (const file of files) {
    await mkdir(path.dirname(path.join(f.checkout, file)), { recursive: true });
    await writeFile(path.join(f.checkout, file), 'scoped change');
  }
  git(f.checkout, 'add', ...files);
  git(f.checkout, 'commit', '-m', 'fixture scope');
  f.sha = git(f.checkout, 'rev-parse', 'HEAD');
}

function marking(f) {
  const marker = path.join(f.root, 'executed.txt');
  const command = node(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`);
  f.profile.steps = [{ ...build, command }, scenario];
  return marker;
}

test('a successful build alone cannot satisfy missing scenario evidence', async (t) => {
  const f = await fixture(t);
  f.profile.steps = [build];
  const report = await run(f);
  assert.equal(report.passed, false);
  assert.equal(report.status, 'failed');
  assert.equal(report.steps[0].passed, true);
  assert.deepEqual(report.scenarios, [{ id: 'consumer', passed: false }]);
  assert.match(report.errors.join('\n'), /Every task scenario/);
});

test('a pinned HEAD mismatch refuses to execute any profile command', async (t) => {
  const f = await fixture(t);
  f.profile.steps = [{ ...build, command: node('throw new Error("must not execute")') }, scenario];
  const report = await run(f, { sha: f.task.targets.web.baseSha });
  assert.equal(report.passed, false);
  assert.equal(report.status, 'blocked');
  assert.deepEqual(report.steps, []);
  assert.match(report.errors.join('\n'), /HEAD does not match/);
});

test('a failing command retains stdout, stderr, argv, and exit code evidence', async (t) => {
  const f = await fixture(t);
  const command = node('console.log("consumer stdout"); console.error("consumer stderr"); process.exit(9)');
  f.profile.steps = [build, { ...scenario, command }];
  const report = await run(f);
  const step = report.steps[1];
  assert.equal(report.passed, false);
  assert.equal(report.status, 'failed');
  assert.equal(step.exitCode, 9);
  assert.deepEqual(step.command, command);
  assert.equal(step.timedOut, false);
  assert.equal(await readFile(path.join(f.outputDir, step.stdout), 'utf8'), 'consumer stdout\n');
  assert.equal(await readFile(path.join(f.outputDir, step.stderr), 'utf8'), 'consumer stderr\n');
  assert.ok(Date.parse(step.startedAt) <= Date.parse(step.completedAt));
  assert.doesNotThrow(() => JSON.stringify(report));
  assert.equal(Object.hasOwn(report, 'env'), false);
});

test('successful scenarios copy only declared ignored artifacts with hashes', async (t) => {
  const f = await fixture(t);
  f.profile.steps = [
    build,
    {
      ...scenario,
      command: node(
        'const fs = require("node:fs"); fs.mkdirSync("build-output", { recursive: true }); fs.writeFileSync("build-output/result.txt", "consumer evidence");',
      ),
    },
  ];
  f.profile.artifacts = ['build-output/result.txt'];
  const report = await run(f);
  assert.equal(report.passed, true, report.errors.join('\n'));
  assert.equal(report.status, 'passed');
  assert.deepEqual(report.scenarios, [{ id: 'consumer', passed: true }]);
  assert.equal(report.artifacts.length, 1);
  assert.equal(report.artifacts[0].sha256, createHash('sha256').update('consumer evidence').digest('hex'));
  assert.equal(await readFile(path.join(f.outputDir, report.artifacts[0].path), 'utf8'), 'consumer evidence');
  assert.equal(git(f.checkout, 'status', '--porcelain', '--untracked-files=all'), '');
});

test('error tasks reproduce the expected failure in a separate clean base checkout first', async (t) => {
  const f = await fixture(t);
  const baselineCheckout = path.join(f.root, 'baseline');
  git(f.root, 'clone', '--no-hardlinks', f.checkout, baselineCheckout);
  git(baselineCheckout, 'remote', 'set-url', 'origin', `git@github.com:${repository}.git`);
  git(baselineCheckout, 'checkout', '--detach', f.task.targets.web.baseSha);
  f.task.kind = 'error';
  delete f.task.feature;
  f.task.error = { reproduction: 'The base fixture fails', expectedRecovery: 'Candidate fixture succeeds' };
  f.profile.baselineCheckout = baselineCheckout;
  f.profile.reproduction = {
    command: node(
      'const fs = require("node:fs"); console.log("baseline reproduction"); process.exit(fs.readFileSync("fixture.txt", "utf8") === "base" ? 7 : 0)',
    ),
    expectedExitCode: 7,
  };
  const report = await run(f);
  assert.equal(report.passed, true, report.errors.join('\n'));
  assert.equal(report.steps[0].phase, 'baseline');
  assert.equal(report.steps[0].exitCode, 7);
  assert.equal(report.steps[0].passed, true);
  assert.equal(report.steps[1].kind, 'build');
});

test('a commit touching files outside the task paths is blocked before any step runs', async (t) => {
  const f = await fixture(t);
  const marker = marking(f);
  const stray = Array.from({ length: 11 }, (_, index) => `srcx/${String(index + 1).padStart(2, '0')}.txt`);
  await commit(f, ['src/app/page.txt', ...stray]);
  f.task.targets.web.paths = ['fixture.txt', 'src'];
  const report = await run(f);
  assert.equal(report.passed, false);
  assert.equal(report.status, 'blocked');
  assert.deepEqual(report.steps, []);
  assert.equal(existsSync(marker), false);
  assert.deepEqual(report.scope, { paths: ['fixture.txt', 'src'], changed: 13, outside: stray });
  assert.deepEqual(report.errors, [`Changes outside the task scope: ${stray.slice(0, 10).join(', ')} (+1 more)`]);
});

test('a file moved into the task paths still reports the path it left', async (t) => {
  const f = await fixture(t);
  const marker = marking(f);
  await mkdir(path.join(f.checkout, 'src'));
  git(f.checkout, 'mv', '.gitignore', 'src/.gitignore');
  git(f.checkout, 'commit', '-m', 'fixture move');
  f.sha = git(f.checkout, 'rev-parse', 'HEAD');
  f.task.targets.web.paths = ['fixture.txt', 'src'];
  const report = await run(f);
  assert.equal(report.status, 'blocked');
  assert.deepEqual(report.scope.outside, ['.gitignore']);
  assert.equal(existsSync(marker), false);
});

test('a commit inside the task paths runs normally and records an empty scope violation list', async (t) => {
  const f = await fixture(t);
  const marker = marking(f);
  await commit(f, ['src/app/page.txt', 'lib/util.txt']);
  f.task.targets.web.paths = ['fixture.txt', 'src', 'lib/'];
  const report = await run(f);
  assert.equal(report.passed, true, report.errors.join('\n'));
  assert.equal(report.status, 'passed');
  assert.equal(existsSync(marker), true);
  assert.deepEqual(report.scope, { paths: ['fixture.txt', 'src', 'lib/'], changed: 3, outside: [] });
  delete f.task.targets.web.paths;
  const unscoped = await run(f, { outputDir: path.join(f.root, 'unscoped') });
  assert.equal(unscoped.passed, true, unscoped.errors.join('\n'));
  assert.equal(Object.hasOwn(unscoped, 'scope'), false);
});

test('failed steps carry a bounded log excerpt and passing steps carry none', async (t) => {
  const f = await fixture(t);
  f.profile.steps = [
    build,
    {
      ...scenario,
      command: node(
        'console.log("out first"); console.log(""); console.log("out last"); console.error("err first"); console.error("err last"); process.exit(9)',
      ),
    },
    {
      id: 'noisy',
      kind: 'build',
      command: node(
        'for (let i = 1; i <= 25; i += 1) console.error(`line ${i} ${"x".repeat(400)}`); console.log("not needed"); process.exit(1)',
      ),
    },
  ];
  const report = await run(f);
  assert.equal(report.status, 'failed');
  assert.equal(Object.hasOwn(report.steps[0], 'excerpt'), false);
  assert.deepEqual(report.steps[1].excerpt, ['err first', 'err last', 'out first', 'out last']);
  const noisy = report.steps[2].excerpt;
  assert.equal(noisy.length, 20);
  assert.ok(noisy.every((line) => line.length === 300));
  assert.match(noisy[0], /^line 6 x/);
  assert.match(noisy.at(-1), /^line 25 x/);
});
