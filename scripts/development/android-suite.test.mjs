import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSuite, flowsFromJobs } from './android-suite.mjs';
import { validateTask } from './model.mjs';

const SHA = 'a'.repeat(40);

test('flows come only from "Maestro <flow>" jobs and are sorted', () => {
  const names = [
    'Notify Maestro results',
    'Maestro store',
    'Build stage QA APK',
    'Maestro auth_sign_in',
    'Maestro Extra Job',
  ];
  assert.deepEqual(flowsFromJobs(names), ['auth_sign_in', 'store']);
});

test('runs without a build job, without flows, or with duplicate flows are refused', () => {
  assert.throws(() => flowsFromJobs(['Maestro store']), /Build stage QA APK/);
  assert.throws(() => flowsFromJobs(['Build stage QA APK', 'Notify Maestro results']), /no "Maestro/);
  assert.throws(() => flowsFromJobs(['Build stage QA APK', 'Maestro store', 'Maestro store']), /duplicate/);
});

test('the generated task is valid and every scenario has exactly one step pinned to the run and commit', () => {
  const { task, profile } = buildSuite({
    flows: ['bus', 'store'],
    successfulFlows: ['bus'],
    repo: 'BCSDLab/KOIN_ANDROID',
    runId: 7,
    sha: SHA,
    checkout: '/work/KOIN_ANDROID',
    reviewer: 'android-reviewer',
    script: '/harness/github-run.mjs',
  });
  assert.equal(validateTask(task), task);
  assert.deepEqual(
    task.scenarios.map(({ id }) => id),
    ['bus', 'store'],
  );
  assert.equal(profile.steps[0].kind, 'build');
  assert.deepEqual(profile.artifacts, ['build/harness/android/bus/evidence.json']);
  for (const flow of ['bus', 'store']) {
    const steps = profile.steps.filter((step) => step.scenarioId === flow);
    assert.equal(steps.length, 1);
    const { command } = steps[0];
    assert.equal(command[command.indexOf('--job') + 1], `Maestro ${flow}`);
    assert.equal(command[command.indexOf('--sha') + 1], SHA);
    assert.equal(command[command.indexOf('--run-id') + 1], '7');
    assert.ok(new RegExp(command[command.indexOf('--artifact') + 1]).test(`maestro-${flow}-2026-11-16`));
    assert.equal(command[command.indexOf('--out') + 1], `build/harness/android/${flow}`);
  }
});
