import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  MAX_FAILED_ROUNDS,
  createState,
  nextActions,
  recordHandback,
  recordImplementation,
  recordRelease,
  recordReview,
  recordVerification,
  requireVerificationRound,
  summarize,
  taskDigest,
  validateTask,
} from './model.mjs';

const BASE = 'a'.repeat(40);
const SHA = 'b'.repeat(40);
const NEXT = 'c'.repeat(40);
const REPOS = { web: 'BCSDLab/BCSD_united', android: 'BCSDLab/KOIN_ANDROID', ios: 'BCSDLab/KOIN_iOS' };

function taskFor(platforms = ['web']) {
  return {
    schemaVersion: 1,
    id: 'improve-login',
    kind: 'feature',
    goal: 'Improve the login experience',
    scenarios: [{ id: 'login', expected: 'The user can sign in' }],
    targets: Object.fromEntries(
      platforms.map((platform) => [
        platform,
        {
          repository: REPOS[platform],
          baseSha: BASE,
          reviewer: `${platform}-reviewer`,
        },
      ]),
    ),
    dependencies: [],
    feature: { acceptance: 'The login scenario passes' },
  };
}

function implementation(task, platform = 'web', sha = SHA) {
  return {
    sha,
    pr: `https://github.com/${task.targets[platform].repository}/pull/12`,
    figma: { url: 'https://www.figma.com/design/example?node-id=1-2', version: '100' },
  };
}

function reportFor(task, platform = 'web', sha = SHA) {
  return {
    platform,
    repository: task.targets[platform].repository,
    baseSha: BASE,
    sha,
    passed: true,
    scenarios: task.scenarios.map(({ id }) => ({ id, passed: true })),
    status: 'passed',
    errors: [],
    steps: [{ phase: 'candidate', command: ['node', 'check.mjs'], exitCode: 0 }],
    artifacts: ['screenshots/login.png'],
  };
}

function reviewFor(task, platform = 'web', sha = SHA) {
  return { sha, reviewer: task.targets[platform].reviewer, evidence: 'Human reviewed the scenario and screenshot' };
}

function implementAndVerify(state, task, platform = 'web') {
  recordImplementation(state, task, platform, implementation(task, platform));
  recordVerification(state, task, platform, reportFor(task, platform));
}

function finishPlatform(state, task, platform = 'web') {
  implementAndVerify(state, task, platform);
  recordReview(state, task, platform, reviewFor(task, platform));
  recordRelease(state, task, platform, { sha: SHA, evidence: `https://releases.example/${platform}/12` });
}

function failedReport(task, platform = 'web', sha = SHA) {
  return {
    ...reportFor(task, platform, sha),
    passed: false,
    status: 'failed',
    errors: ['One or more commands failed, timed out, or could not start'],
    steps: [
      { phase: 'candidate', command: ['node', 'build.mjs'], exitCode: 0, passed: true },
      {
        phase: 'candidate',
        command: ['node', 'check.mjs'],
        exitCode: 1,
        passed: false,
        excerpt: ['TypeError: login is not a function'],
      },
    ],
  };
}

test('valid tasks support any nonempty subset of the three platforms', () => {
  for (const platforms of [['web'], ['android'], ['ios'], ['web', 'android', 'ios']]) {
    const task = taskFor(platforms);
    assert.equal(validateTask(task), task);
    const state = createState(task);
    assert.equal(state.schemaVersion, 1);
    assert.equal(state.taskDigest, taskDigest(task));
    assert.deepEqual(Object.keys(state.platforms), platforms);
    for (const entry of Object.values(state.platforms)) {
      assert.deepEqual(entry, {
        implementation: null,
        verification: null,
        review: null,
        release: null,
        failedRounds: 0,
      });
    }
  }
});

test('kind-specific requirements and HTTPS references are enforced', () => {
  const feature = taskFor();
  delete feature.feature;
  assert.throws(() => validateTask(feature), /feature/);
  const redesign = taskFor();
  redesign.kind = 'redesign';
  redesign.redesign = { preserve: 'Preserve login behavior' };
  assert.throws(() => validateTask(redesign), /standard/);
  redesign.redesign.standard = 'apps/web/src/components/ui/Button';
  assert.equal(validateTask(redesign), redesign);
  delete redesign.redesign.preserve;
  assert.throws(() => validateTask(redesign), /preserve/);
  const error = taskFor();
  error.kind = 'error';
  error.error = { reproduction: 'Submit expired credentials', expectedRecovery: 'Show the login form' };
  assert.equal(validateTask(error), error);
  delete error.error.expectedRecovery;
  assert.throws(() => validateTask(error), /expectedRecovery/);
  for (const name of ['figma', 'api']) {
    const task = taskFor();
    task[name] = { url: 'http://example.com/spec', version: '1' };
    assert.throws(() => validateTask(task), /HTTPS/);
    task[name].url = 'https://example.com/spec';
    assert.equal(validateTask(task), task);
  }
});

test('malformed inputs produce explicit validation failures', () => {
  for (const value of [null, [], 'task', 12]) assert.throws(() => validateTask(value), /task must be an object/);
  for (const mutate of [
    (task) => {
      task.schemaVersion = 2;
    },
    (task) => {
      task.id = 'not a slug';
    },
    (task) => {
      task.goal = ' ';
    },
    (task) => {
      task.scenarios = null;
    },
    (task) => {
      task.scenarios.push({ ...task.scenarios[0] });
    },
    (task) => {
      task.targets = {};
    },
    (task) => {
      task.targets.web.baseSha = 'main';
    },
    (task) => {
      task.targets.web.repository = REPOS.android;
    },
    (task) => {
      task.targets.web.reviewer = '';
    },
    (task) => {
      task.dependencies = [null];
    },
    (task) => {
      task.dependencies = [{ id: 'api', status: 'unknown', detail: 'Waiting' }];
    },
    (task) => {
      task.extra = undefined;
    },
    (task) => {
      task.extra = task;
    },
  ]) {
    const task = taskFor();
    mutate(task);
    assert.throws(() => validateTask(task), Error);
  }
});

test('digest sorts nested keys, preserves array order, and hashes canonical JSON', () => {
  const task = taskFor();
  const reverse = (value) => {
    if (Array.isArray(value)) return value.map(reverse);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value)
          .reverse()
          .map(([key, item]) => [key, reverse(item)]),
      );
    }
    return value;
  };
  const encode = (value) => {
    if (Array.isArray(value)) return `[${value.map(encode).join(',')}]`;
    if (value !== null && typeof value === 'object') {
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${encode(value[key])}`)
        .join(',')}}`;
    }
    return JSON.stringify(value);
  };
  task.extra = { 2: 'two', 10: 'ten', nested: { z: 1, a: 2 } };
  assert.equal(taskDigest(task), taskDigest(reverse(task)));
  assert.equal(taskDigest(task), createHash('sha256').update(encode(task)).digest('hex'));
  task.scenarios.push({ id: 'logout', expected: 'The user can sign out' });
  const changed = structuredClone(task);
  changed.scenarios.reverse();
  assert.notEqual(taskDigest(task), taskDigest(changed));
});

test('all operations invalidate changed task contracts', () => {
  const task = taskFor();
  const state = createState(task);
  finishPlatform(state, task);
  task.goal = 'A changed goal';
  for (const operation of [
    () => summarize(state, task),
    () => recordImplementation(state, task, 'web', implementation(task)),
    () => recordVerification(state, task, 'web', reportFor(task)),
    () => recordReview(state, task, 'web', reviewFor(task)),
    () => recordRelease(state, task, 'web', { sha: SHA, evidence: 'Released by a human' }),
    () => recordHandback(state, task, 'web', { reviewer: 'web-reviewer', note: 'Reviewed by a human' }),
    () => requireVerificationRound(state, task, 'web'),
    () => nextActions(state, task),
  ])
    assert.throws(operation, /fresh state/);
});

test('partial platform completion never marks the task complete', () => {
  const task = taskFor(['web', 'android', 'ios']);
  const state = createState(task);
  finishPlatform(state, task, 'web');
  let summary = summarize(state, task);
  assert.equal(summary.complete, false);
  assert.deepEqual(summary.pending, ['android', 'ios']);
  assert.deepEqual(summary.platforms.web, {
    implemented: true,
    verified: true,
    reviewed: true,
    released: true,
    failedRounds: 0,
    escalated: false,
    status: 'released',
  });
  assert.deepEqual(summary.platforms.ios, {
    implemented: false,
    verified: false,
    reviewed: false,
    released: false,
    failedRounds: 0,
    escalated: false,
    status: 'pending',
  });
  finishPlatform(state, task, 'android');
  finishPlatform(state, task, 'ios');
  summary = summarize(state, task);
  assert.equal(summary.complete, true);
  assert.deepEqual(summary.pending, []);
});

test('new implementation commits reset verification, review, and release', () => {
  const task = taskFor();
  const state = createState(task);
  finishPlatform(state, task);
  recordImplementation(state, task, 'web', implementation(task));
  assert.equal(summarize(state, task).complete, true);
  recordImplementation(state, task, 'web', implementation(task, 'web', NEXT));
  assert.deepEqual(state.platforms.web, {
    implementation: implementation(task, 'web', NEXT),
    verification: null,
    review: null,
    release: null,
    failedRounds: 0,
  });
  assert.throws(() => recordVerification(state, task, 'web', reportFor(task)), /SHA/);
  assert.throws(() => recordReview(state, task, 'web', reviewFor(task)), /verification/);
  recordVerification(state, task, 'web', reportFor(task, 'web', NEXT));
  assert.throws(() => recordReview(state, task, 'web', reviewFor(task)), /SHA/);
  recordReview(state, task, 'web', reviewFor(task, 'web', NEXT));
  assert.throws(() => recordRelease(state, task, 'web', { sha: SHA, evidence: 'Old release' }), /SHA/);
});

test('UI implementations must ship a Figma frame version, and a new version invalidates approvals', () => {
  const task = taskFor();
  const state = createState(task);
  const pr = 'https://github.com/BCSDLab/BCSD_united/pull/12';
  assert.throws(() => recordImplementation(state, task, 'web', { sha: SHA, pr }), /figma/);
  assert.throws(
    () =>
      recordImplementation(state, task, 'web', { sha: SHA, pr, figma: { url: 'https://example.com/a', version: '1' } }),
    /figma\.com/,
  );
  finishPlatform(state, task);
  assert.equal(summarize(state, task).complete, true);
  const revised = { ...implementation(task), figma: { url: implementation(task).figma.url, version: '101' } };
  recordImplementation(state, task, 'web', revised);
  assert.deepEqual(state.platforms.web, {
    implementation: revised,
    verification: null,
    review: null,
    release: null,
    failedRounds: 0,
  });

  const error = {
    ...taskFor(),
    kind: 'error',
    error: { reproduction: 'Open the page', expectedRecovery: 'Page renders' },
  };
  delete error.feature;
  const errorState = createState(error);
  recordImplementation(errorState, error, 'web', { sha: SHA, pr });
  assert.equal(errorState.platforms.web.implementation.figma, undefined);
});

test('verification failures, missing scenarios, extra scenarios, and blocked dependencies cannot be approved', () => {
  for (const mutate of [
    (report) => {
      report.passed = false;
    },
    (report) => {
      report.scenarios[0].passed = false;
    },
    (report) => {
      report.scenarios = [];
    },
    (report) => {
      report.scenarios.push({ id: 'unrequested', passed: true });
    },
    (report) => {
      report.steps[0].exitCode = 1;
    },
    (report) => {
      report.status = 'blocked';
    },
    (report) => {
      report.errors.push('Missing device');
    },
  ]) {
    const task = taskFor();
    const state = createState(task);
    finishPlatform(state, task);
    const report = reportFor(task);
    mutate(report);
    recordVerification(state, task, 'web', report);
    assert.equal(state.platforms.web.verification.passed, false);
    assert.equal(state.platforms.web.verification.status, 'failed');
    assert.equal(state.platforms.web.review, null);
    assert.equal(state.platforms.web.release, null);
    assert.equal(summarize(state, task).complete, false);
    assert.throws(() => recordReview(state, task, 'web', reviewFor(task)), /verification/);
  }
  const task = taskFor();
  task.dependencies = [{ id: 'api', status: 'blocked', detail: 'API contract unavailable' }];
  const state = createState(task);
  implementAndVerify(state, task);
  assert.equal(state.platforms.web.verification.passed, false);
  assert.match(state.platforms.web.verification.failures.join(' '), /Dependency is blocked/);
});

test('error baseline failures are evidence rather than candidate verification failures', () => {
  const task = taskFor();
  task.kind = 'error';
  task.error = { reproduction: 'Expired login crashes', expectedRecovery: 'Display a recoverable error' };
  const state = createState(task);
  recordImplementation(state, task, 'web', implementation(task));
  const report = reportFor(task);
  report.steps.unshift({ phase: 'baseline', command: ['node', 'reproduce.mjs'], exitCode: 1 });
  recordVerification(state, task, 'web', report);
  assert.equal(state.platforms.web.verification.passed, true);
});

test('implementation and reports bind to the exact platform repository, base, and commit', () => {
  const task = taskFor();
  const state = createState(task);
  for (const pr of [
    'http://github.com/BCSDLab/BCSD_united/pull/1',
    'https://github.com/BCSDLab/KOIN_ANDROID/pull/1',
    'https://github.com.evil.example/BCSDLab/BCSD_united/pull/1',
    'https://github.com/BCSDLab/BCSD_united/issues/1',
  ])
    assert.throws(() => recordImplementation(state, task, 'web', { sha: SHA, pr }), /HTTPS|PR/);
  assert.throws(() => recordImplementation(state, task, 'ios', implementation(task)), /not a task target/);
  recordImplementation(state, task, 'web', implementation(task));
  for (const patch of [
    { platform: 'android' },
    { repository: REPOS.android },
    { baseSha: NEXT },
    { sha: NEXT },
    { passed: 'true' },
    { scenarios: null },
    { scenarios: [{ id: 'login', passed: 'true' }] },
    {
      scenarios: [
        { id: 'login', passed: true },
        { id: 'login', passed: true },
      ],
    },
  ])
    assert.throws(() => recordVerification(state, task, 'web', { ...reportFor(task), ...patch }), Error);
  const report = reportFor(task);
  report.repository = report.repository.toLowerCase();
  recordVerification(state, task, 'web', report);
  assert.equal(state.platforms.web.verification.passed, true);
});

test('review and release require separate human evidence and preserve attestation fields', () => {
  const task = taskFor();
  const state = createState(task);
  implementAndVerify(state, task);
  assert.equal(state.platforms.web.review, null);
  assert.equal(state.platforms.web.release, null);
  assert.throws(
    () => recordReview(state, task, 'web', { ...reviewFor(task), reviewer: 'someone-else' }),
    /designated reviewer/,
  );
  assert.throws(() => recordReview(state, task, 'web', { ...reviewFor(task), evidence: '' }), /evidence/);
  assert.throws(() => recordRelease(state, task, 'web', { sha: SHA, evidence: 'Deployed' }), /review/);
  const review = {
    ...reviewFor(task),
    evidence: 'https://reviews.example/12',
    notes: { accessibility: 'Reviewed by a human' },
  };
  recordReview(state, task, 'web', review);
  assert.deepEqual(state.platforms.web.review, review);
  review.notes.accessibility = 'Changed caller data';
  assert.equal(state.platforms.web.review.notes.accessibility, 'Reviewed by a human');
  assert.equal(summarize(state, task).platforms.web.status, 'reviewed');
  assert.throws(() => recordRelease(state, task, 'web', { sha: SHA, evidence: ' ' }), /evidence/);
  const release = { sha: SHA, evidence: 'Human confirmed production release', deployedBy: 'release-owner' };
  recordRelease(state, task, 'web', release);
  assert.deepEqual(state.platforms.web.release, release);
  assert.equal(summarize(state, task).complete, true);
  recordReview(state, task, 'web', reviewFor(task));
  assert.equal(state.platforms.web.release, null);
  assert.equal(summarize(state, task).complete, false);
});

test('target paths must be bounded repository-relative prefixes and are part of the digest', () => {
  const task = taskFor();
  const digest = taskDigest(task);
  task.targets.web.paths = ['apps/web/src/routes', 'apps/web/src/api/'];
  assert.equal(validateTask(task), task);
  assert.notEqual(taskDigest(task), digest);
  for (const paths of [
    [],
    'apps/web',
    ['apps/web/../secrets'],
    ['..'],
    ['/apps/web'],
    ['apps\\web'],
    ['apps/web', ''],
    [1],
  ]) {
    task.targets.web.paths = paths;
    assert.throws(() => validateTask(task), /task\.targets\.web\.paths/);
  }
});

test('only executed failures use up verification rounds, and a new commit does not buy more', () => {
  const task = taskFor();
  const state = createState(task);
  recordImplementation(state, task, 'web', implementation(task));
  recordVerification(state, task, 'web', { ...failedReport(task), status: 'blocked', steps: [] });
  assert.equal(state.platforms.web.verification.passed, false);
  assert.equal(state.platforms.web.failedRounds, 0);
  recordVerification(state, task, 'web', failedReport(task));
  assert.equal(state.platforms.web.failedRounds, 1);
  recordVerification(state, task, 'web', reportFor(task));
  assert.equal(state.platforms.web.failedRounds, 1);
  assert.equal(summarize(state, task).platforms.web.escalated, false);

  recordImplementation(state, task, 'web', implementation(task, 'web', NEXT));
  assert.equal(state.platforms.web.verification, null);
  assert.equal(state.platforms.web.failedRounds, 1);
  recordVerification(state, task, 'web', failedReport(task, 'web', NEXT));
  assert.equal(state.platforms.web.failedRounds, MAX_FAILED_ROUNDS);

  const before = structuredClone(state);
  const exhausted = /Verification rounds exhausted for web; a human must review and run handback/;
  assert.throws(() => recordVerification(state, task, 'web', reportFor(task, 'web', NEXT)), exhausted);
  assert.throws(() => requireVerificationRound(state, task, 'web'), exhausted);
  assert.deepEqual(state, before);
  recordImplementation(state, task, 'web', implementation(task));
  assert.throws(() => recordVerification(state, task, 'web', reportFor(task)), exhausted);
});

test('an escalated platform is never complete, and older states without a counter start at zero', () => {
  const task = taskFor();
  const state = createState(task);
  finishPlatform(state, task);
  delete state.platforms.web.failedRounds;
  let summary = summarize(state, task);
  assert.equal(summary.complete, true);
  assert.equal(summary.platforms.web.failedRounds, 0);
  assert.equal(summary.platforms.web.escalated, false);
  state.platforms.web.failedRounds = MAX_FAILED_ROUNDS;
  summary = summarize(state, task);
  assert.equal(summary.complete, false);
  assert.deepEqual(summary.pending, ['web']);
  assert.equal(summary.platforms.web.failedRounds, MAX_FAILED_ROUNDS);
  assert.equal(summary.platforms.web.escalated, true);
  state.platforms.web.failedRounds = -1;
  assert.throws(() => summarize(state, task), /failedRounds/);
});

test('handback needs the designated reviewer and a note, then reopens verification', () => {
  const task = taskFor();
  const state = createState(task);
  recordImplementation(state, task, 'web', implementation(task));
  recordVerification(state, task, 'web', failedReport(task));
  recordVerification(state, task, 'web', failedReport(task));
  assert.equal(summarize(state, task).platforms.web.escalated, true);
  assert.throws(
    () => recordHandback(state, task, 'web', { reviewer: 'someone-else', note: 'Looked at the failure' }),
    /designated reviewer/,
  );
  assert.throws(() => recordHandback(state, task, 'web', { reviewer: 'web-reviewer', note: ' ' }), /note/);
  assert.equal(state.platforms.web.failedRounds, MAX_FAILED_ROUNDS);
  assert.equal(state.platforms.web.handbacks, undefined);

  recordHandback(state, task, 'web', { reviewer: 'web-reviewer', note: 'Selector was wrong; one more round' });
  assert.equal(state.platforms.web.failedRounds, 0);
  assert.equal(summarize(state, task).platforms.web.escalated, false);
  const [handback] = state.platforms.web.handbacks;
  assert.deepEqual(
    { ...handback, at: null },
    { reviewer: 'web-reviewer', note: 'Selector was wrong; one more round', at: null, sha: SHA },
  );
  assert.equal(new Date(handback.at).toISOString(), handback.at);
  recordVerification(state, task, 'web', reportFor(task));
  assert.equal(state.platforms.web.verification.passed, true);
  recordHandback(state, task, 'web', { reviewer: 'web-reviewer', note: 'Second review' });
  assert.equal(state.platforms.web.handbacks.length, 2);

  const untouched = createState(task);
  recordHandback(untouched, task, 'web', { reviewer: 'web-reviewer', note: 'Nothing implemented yet' });
  assert.equal(untouched.platforms.web.handbacks[0].sha, null);
});

test('nextActions names the single next step for each platform state', () => {
  const task = taskFor();
  const state = createState(task);
  const action = () => nextActions(state, task).platforms[0];
  const fix = {
    platform: 'web',
    action: 'fix',
    error: 'One or more commands failed, timed out, or could not start',
    excerpt: ['TypeError: login is not a function'],
  };
  assert.deepEqual(action(), { platform: 'web', action: 'implement' });
  recordImplementation(state, task, 'web', implementation(task));
  assert.deepEqual(action(), { platform: 'web', action: 'verify', sha: SHA });
  recordVerification(state, task, 'web', failedReport(task));
  assert.deepEqual(action(), fix);
  recordVerification(state, task, 'web', failedReport(task));
  assert.deepEqual(action(), {
    platform: 'web',
    action: 'escalated',
    failedRounds: MAX_FAILED_ROUNDS,
    reviewer: 'web-reviewer',
  });
  recordHandback(state, task, 'web', { reviewer: 'web-reviewer', note: 'Reviewed the failure' });
  assert.deepEqual(action(), fix);
  recordVerification(state, task, 'web', reportFor(task));
  assert.deepEqual(action(), { platform: 'web', action: 'review', reviewer: 'web-reviewer' });
  recordReview(state, task, 'web', reviewFor(task));
  assert.deepEqual(action(), { platform: 'web', action: 'release' });
  recordRelease(state, task, 'web', { sha: SHA, evidence: 'Human confirmed production release' });
  assert.deepEqual(action(), { platform: 'web', action: 'done' });
  assert.deepEqual(nextActions(state, task).blocked, []);
});

test('nextActions follows task platform order and lists only blocked dependencies', () => {
  const task = taskFor(['android', 'web']);
  task.dependencies = [
    { id: 'api', status: 'blocked', detail: 'API contract unavailable' },
    { id: 'design', status: 'ready', detail: 'Design approved' },
  ];
  const state = createState(task);
  implementAndVerify(state, task, 'web');
  assert.deepEqual(nextActions(state, task), {
    platforms: [
      { platform: 'android', action: 'implement' },
      { platform: 'web', action: 'fix', error: 'Dependency is blocked: api', excerpt: [] },
    ],
    blocked: [{ id: 'api', detail: 'API contract unavailable' }],
  });
});
