import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateMatrix } from './verify-matrix.mjs';

const SHA = 'a'.repeat(40);
function fixture() {
  const matrix = {
    schemaVersion: 1,
    sources: [{ id: 'web', path: 'web.json', sha: SHA, platform: 'web', kind: 'web-screen' }],
    checks: [
      { id: 'home-render', feature: 'home', platform: 'web', level: 'render', source: 'web', scenarios: ['home'] },
    ],
  };
  const report = {
    sha: SHA,
    platform: 'web',
    status: 'passed',
    scenarios: [{ id: 'home', passed: true }],
    steps: [
      { kind: 'build', phase: 'candidate', passed: true },
      { kind: 'scenario', phase: 'candidate', scenarioId: 'home', passed: true },
    ],
  };
  return { matrix, report };
}

test('missing iOS and API evidence leaves whole-system acceptance incomplete', () => {
  const { matrix, report } = fixture();
  matrix.checks.push({
    id: 'ios-home',
    feature: 'home',
    platform: 'ios',
    level: 'journey',
    source: null,
    scenarios: [],
  });
  matrix.checks.push({
    id: 'api-home',
    feature: 'home',
    platform: 'api',
    level: 'api-smoke',
    source: null,
    scenarios: [],
  });
  const result = evaluateMatrix(matrix, new Map([['web', report]]));
  assert.equal(result.passed, false);
  assert.deepEqual(result.counts, { passed: 1, failed: 0, blocked: 0, unverified: 2 });
});

test('a screenshot sweep cannot satisfy an authenticated journey or foldable posture', () => {
  for (const level of ['journey', 'auth', 'posture', 'continuity']) {
    const { matrix, report } = fixture();
    matrix.checks[0].level = level;
    assert.equal(evaluateMatrix(matrix, new Map([['web', report]])).checks[0].status, 'blocked');
  }
});

test('a different commit or platform cannot satisfy the same scenario id', () => {
  for (const change of [{ sha: 'b'.repeat(40) }, { platform: 'ios' }]) {
    const { matrix, report } = fixture();
    assert.equal(evaluateMatrix(matrix, new Map([['web', { ...report, ...change }]])).checks[0].status, 'blocked');
  }
});

test('later invalidation revokes an earlier screen pass', () => {
  const { matrix, report } = fixture();
  matrix.sources[0].invalidated = ['home'];
  const result = evaluateMatrix(matrix, new Map([['web', report]]));
  assert.equal(result.checks[0].status, 'unverified');
  assert.match(result.checks[0].reason, /invalidated/);
});

test('a missing or failed command cannot become a successful scenario verdict', () => {
  const { matrix, report } = fixture();
  assert.equal(evaluateMatrix(matrix, new Map()).checks[0].status, 'unverified');
  report.steps[1].passed = false;
  assert.equal(evaluateMatrix(matrix, new Map([['web', report]])).checks[0].status, 'failed');
  report.steps.pop();
  assert.equal(evaluateMatrix(matrix, new Map([['web', report]])).checks[0].status, 'unverified');
});

test('failed build and invalid reports fail closed', () => {
  const { matrix, report } = fixture();
  report.steps[0].passed = false;
  assert.equal(evaluateMatrix(matrix, new Map([['web', report]])).checks[0].status, 'blocked');
  assert.equal(evaluateMatrix(matrix, new Map([['web', { ...report, sha: null }]])).checks[0].status, 'blocked');
  assert.equal(evaluateMatrix(matrix, new Map([['web', { readError: 'bad JSON' }]])).checks[0].reason, 'bad JSON');
});

test('a missing scenario does not hide another scenario failure', () => {
  const { matrix, report } = fixture();
  matrix.checks[0].scenarios = ['missing', 'home'];
  report.steps[1].passed = false;
  assert.equal(evaluateMatrix(matrix, new Map([['web', report]])).checks[0].status, 'failed');
});
