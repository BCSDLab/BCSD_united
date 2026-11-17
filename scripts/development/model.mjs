import { createHash } from 'node:crypto';

const REPOSITORIES = {
  // 웹 수정 대상은 모노레포 하나로 고정한다.
  web: ['bcsdlab/bcsd_united'],
  android: ['bcsdlab/koin_android'],
  ios: ['bcsdlab/koin_ios'],
};
const SHA = /^[a-fA-F0-9]{40}$/;
const STAGES = ['implementation', 'verification', 'review', 'release'];

function object(value, name) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function text(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a nonempty string`);
  }
}

function sha(value, name) {
  if (typeof value !== 'string' || !SHA.test(value)) {
    throw new Error(`${name} must be a 40-character hexadecimal SHA`);
  }
}

function https(value, name) {
  text(value, name);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an HTTPS URL`);
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
    throw new Error(`${name} must be an HTTPS URL without credentials`);
  }
  return url;
}

function canonical(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object') throw new Error('Task must contain only JSON values');
  if (ancestors.has(value)) throw new Error('Task must not contain circular references');
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) {
    result = `[${Array.from(value, (item) => canonical(item, ancestors)).join(',')}]`;
  } else {
    object(value, 'Task value');
    result = `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key], ancestors)}`)
      .join(',')}}`;
  }
  ancestors.delete(value);
  return result;
}

export function validateTask(task) {
  object(task, 'task');
  if (task.schemaVersion !== 1) throw new Error('task.schemaVersion must be 1');
  if (typeof task.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(task.id)) {
    throw new Error('task.id must be a nonempty lowercase slug');
  }
  if (!['feature', 'redesign', 'error'].includes(task.kind)) {
    throw new Error('task.kind must be feature, redesign, or error');
  }
  text(task.goal, 'task.goal');
  if (!Array.isArray(task.scenarios)) throw new Error('task.scenarios must be an array');
  const scenarioIds = new Set();
  for (const [index, scenario] of task.scenarios.entries()) {
    object(scenario, `task.scenarios[${index}]`);
    text(scenario.id, `task.scenarios[${index}].id`);
    text(scenario.expected, `task.scenarios[${index}].expected`);
    if (scenarioIds.has(scenario.id)) throw new Error(`Duplicate scenario id: ${scenario.id}`);
    scenarioIds.add(scenario.id);
  }
  object(task.targets, 'task.targets');
  if (Object.keys(task.targets).length === 0) throw new Error('task.targets must include a platform');
  for (const [platform, target] of Object.entries(task.targets)) {
    if (!Object.hasOwn(REPOSITORIES, platform)) throw new Error(`Unknown target platform: ${platform}`);
    object(target, `task.targets.${platform}`);
    if (typeof target.repository !== 'string' || !REPOSITORIES[platform].includes(target.repository.toLowerCase())) {
      throw new Error(`task.targets.${platform}.repository must match the platform repository`);
    }
    sha(target.baseSha, `task.targets.${platform}.baseSha`);
    text(target.reviewer, `task.targets.${platform}.reviewer`);
  }
  for (const name of ['figma', 'api']) {
    if (task[name] !== undefined) {
      object(task[name], `task.${name}`);
      https(task[name].url, `task.${name}.url`);
      text(task[name].version, `task.${name}.version`);
    }
  }
  if (!Array.isArray(task.dependencies)) throw new Error('task.dependencies must be an array');
  for (const [index, dependency] of task.dependencies.entries()) {
    object(dependency, `task.dependencies[${index}]`);
    text(dependency.id, `task.dependencies[${index}].id`);
    if (!['ready', 'blocked'].includes(dependency.status)) {
      throw new Error(`task.dependencies[${index}].status must be ready or blocked`);
    }
    text(dependency.detail, `task.dependencies[${index}].detail`);
  }
  object(task[task.kind], `task.${task.kind}`);
  if (task.kind === 'feature') text(task.feature.acceptance, 'task.feature.acceptance');
  if (task.kind === 'redesign') {
    text(task.redesign.preserve, 'task.redesign.preserve');
    // 기준은 디자인 시스템 패턴·결정 기록·Figma 중 수락된 하나다. Figma 제작을 선행 조건으로 두지 않는다.
    text(task.redesign.standard, 'task.redesign.standard');
  }
  if (task.kind === 'error') {
    text(task.error.reproduction, 'task.error.reproduction');
    text(task.error.expectedRecovery, 'task.error.expectedRecovery');
  }
  canonical(task);
  return task;
}

export function taskDigest(task) {
  validateTask(task);
  return createHash('sha256').update(canonical(task)).digest('hex');
}

export function createState(task) {
  return {
    schemaVersion: 1,
    taskDigest: taskDigest(task),
    platforms: Object.fromEntries(
      Object.keys(task.targets).map((platform) => [
        platform,
        {
          implementation: null,
          verification: null,
          review: null,
          release: null,
        },
      ]),
    ),
  };
}

function checkState(state, task) {
  const digest = taskDigest(task);
  object(state, 'state');
  if (state.schemaVersion !== 1) throw new Error('state.schemaVersion must be 1');
  if (state.taskDigest !== digest) throw new Error('Task changed: create a fresh state before continuing');
  object(state.platforms, 'state.platforms');
  const expected = Object.keys(task.targets);
  if (
    Object.keys(state.platforms).length !== expected.length ||
    expected.some((platform) => !Object.hasOwn(state.platforms, platform))
  ) {
    throw new Error('State platforms must match task targets');
  }
  for (const platform of expected) {
    const entry = object(state.platforms[platform], `state.platforms.${platform}`);
    for (const stage of STAGES) {
      if (entry[stage] !== null) object(entry[stage], `state.platforms.${platform}.${stage}`);
    }
  }
}

function platformState(state, task, platform) {
  checkState(state, task);
  if (typeof platform !== 'string' || !Object.hasOwn(task.targets, platform)) {
    throw new Error(`Platform is not a task target: ${String(platform)}`);
  }
  return state.platforms[platform];
}

function sameSha(left, right) {
  return (
    typeof left === 'string' &&
    typeof right === 'string' &&
    SHA.test(left) &&
    SHA.test(right) &&
    left.toLowerCase() === right.toLowerCase()
  );
}

function validateReport(report, task, platform, implementation) {
  object(report, 'report');
  if (report.platform !== platform) throw new Error('Report platform does not match target');
  const target = task.targets[platform];
  if (typeof report.repository !== 'string' || report.repository.toLowerCase() !== target.repository.toLowerCase()) {
    throw new Error('Report repository does not match target');
  }
  sha(report.baseSha, 'report.baseSha');
  if (!sameSha(report.baseSha, target.baseSha)) throw new Error('Report baseSha does not match target');
  sha(report.sha, 'report.sha');
  if (!implementation || !sameSha(report.sha, implementation.sha)) {
    throw new Error('Report SHA does not match current implementation');
  }
  if (typeof report.passed !== 'boolean') throw new Error('report.passed must be boolean');
  if (!Array.isArray(report.scenarios)) throw new Error('report.scenarios must be an array');
  const ids = new Set();
  for (const [index, scenario] of report.scenarios.entries()) {
    object(scenario, `report.scenarios[${index}]`);
    text(scenario.id, `report.scenarios[${index}].id`);
    if (typeof scenario.passed !== 'boolean') throw new Error(`report.scenarios[${index}].passed must be boolean`);
    if (ids.has(scenario.id)) throw new Error(`Duplicate report scenario id: ${scenario.id}`);
    ids.add(scenario.id);
  }
  if (report.steps !== undefined) {
    if (!Array.isArray(report.steps)) throw new Error('report.steps must be an array');
    for (const [index, step] of report.steps.entries()) {
      object(step, `report.steps[${index}]`);
      if (!['baseline', 'candidate'].includes(step.phase))
        throw new Error(`report.steps[${index}].phase must be baseline or candidate`);
      if (step.exitCode !== null && !Number.isInteger(step.exitCode))
        throw new Error(`report.steps[${index}].exitCode must be an integer or null`);
    }
  }
  if (report.errors !== undefined && !Array.isArray(report.errors)) throw new Error('report.errors must be an array');
}

function verificationFailures(report, task) {
  const failures = [];
  if (!report.passed) failures.push('Verification report failed');
  if (report.status !== undefined && report.status !== 'passed') failures.push('Verification status is not passed');
  if (report.errors?.length) failures.push('Verification contains errors');
  if (report.steps?.some((step) => step.phase === 'candidate' && step.exitCode !== 0)) {
    failures.push('A candidate verification step failed');
  }
  const requiredIds = new Set(task.scenarios.map((scenario) => scenario.id));
  if (report.scenarios.some((scenario) => !requiredIds.has(scenario.id)))
    failures.push('Report contains an unexpected scenario');
  if (report.scenarios.some((scenario) => !scenario.passed)) failures.push('A reported scenario failed');
  const passed = new Set(report.scenarios.filter((scenario) => scenario.passed).map((scenario) => scenario.id));
  for (const scenario of task.scenarios) {
    if (!passed.has(scenario.id)) failures.push(`Required scenario did not pass: ${scenario.id}`);
  }
  for (const dependency of task.dependencies) {
    if (dependency.status !== 'ready') failures.push(`Dependency is blocked: ${dependency.id}`);
  }
  return failures;
}

export function recordImplementation(state, task, platform, record) {
  const entry = platformState(state, task, platform);
  object(record, 'implementation');
  sha(record.sha, 'implementation.sha');
  const pr = https(record.pr, 'implementation.pr');
  const prefix = `/${task.targets[platform].repository.toLowerCase()}/pull/`;
  const pathname = pr.pathname.toLowerCase();
  if (
    pr.hostname !== 'github.com' ||
    pr.port ||
    !pathname.startsWith(prefix) ||
    !/^[1-9]\d*\/?$/.test(pathname.slice(prefix.length))
  ) {
    throw new Error('Implementation PR must match the target GitHub repository');
  }
  // UI를 바꾸는 작업은 구현과 같은 Figma 프레임·버전을 산출물로 남긴다. 오류 복구는 선택이다.
  if (task.kind !== 'error' || record.figma !== undefined) {
    if (record.figma === undefined)
      throw new Error('Feature and redesign implementations require implementation.figma');
    object(record.figma, 'implementation.figma');
    const figma = https(record.figma.url, 'implementation.figma.url');
    if (figma.hostname !== 'figma.com' && !figma.hostname.endsWith('.figma.com')) {
      throw new Error('implementation.figma.url must be a figma.com URL');
    }
    text(record.figma.version, 'implementation.figma.version');
  }
  const previous = entry.implementation;
  if (
    !previous ||
    !sameSha(previous.sha, record.sha) ||
    previous.figma?.url !== record.figma?.url ||
    previous.figma?.version !== record.figma?.version
  ) {
    entry.verification = null;
    entry.review = null;
    entry.release = null;
  }
  entry.implementation = structuredClone(record);
  return state;
}

export function recordVerification(state, task, platform, report) {
  const entry = platformState(state, task, platform);
  validateReport(report, task, platform, entry.implementation);
  const failures = verificationFailures(report, task);
  entry.verification = {
    ...structuredClone(report),
    passed: failures.length === 0,
    status: failures.length === 0 ? 'passed' : 'failed',
    failures,
  };
  entry.review = null;
  entry.release = null;
  return state;
}

function verified(entry, task, platform) {
  if (!entry.implementation || !entry.verification) return false;
  validateReport(entry.verification, task, platform, entry.implementation);
  return verificationFailures(entry.verification, task).length === 0;
}

export function recordReview(state, task, platform, record) {
  const entry = platformState(state, task, platform);
  object(record, 'review');
  sha(record.sha, 'review.sha');
  text(record.reviewer, 'review.reviewer');
  text(record.evidence, 'review.evidence');
  if (!verified(entry, task, platform) || !sameSha(record.sha, entry.implementation.sha)) {
    throw new Error('Review requires successful verification of the exact implementation SHA');
  }
  if (record.reviewer !== task.targets[platform].reviewer) {
    throw new Error('Review requires the designated reviewer');
  }
  entry.review = structuredClone(record);
  entry.release = null;
  return state;
}

function reviewed(entry, task, platform) {
  return (
    verified(entry, task, platform) &&
    entry.review !== null &&
    sameSha(entry.review.sha, entry.implementation.sha) &&
    entry.review.reviewer === task.targets[platform].reviewer &&
    typeof entry.review.evidence === 'string' &&
    entry.review.evidence.trim().length > 0
  );
}

export function recordRelease(state, task, platform, record) {
  const entry = platformState(state, task, platform);
  object(record, 'release');
  sha(record.sha, 'release.sha');
  text(record.evidence, 'release.evidence');
  if (!reviewed(entry, task, platform) || !sameSha(record.sha, entry.review.sha)) {
    throw new Error('Release requires review of the exact implementation SHA');
  }
  entry.release = structuredClone(record);
  return state;
}

export function summarize(state, task) {
  checkState(state, task);
  const platforms = {};
  const pending = [];
  for (const platform of Object.keys(task.targets)) {
    const entry = state.platforms[platform];
    const implemented = entry.implementation !== null;
    const isVerified = verified(entry, task, platform);
    const isReviewed = reviewed(entry, task, platform);
    const released =
      isReviewed &&
      entry.release !== null &&
      sameSha(entry.release.sha, entry.implementation.sha) &&
      typeof entry.release.evidence === 'string' &&
      entry.release.evidence.trim().length > 0;
    platforms[platform] = {
      implemented,
      verified: isVerified,
      reviewed: isReviewed,
      released,
      status: released
        ? 'released'
        : isReviewed
          ? 'reviewed'
          : isVerified
            ? 'verified'
            : implemented
              ? 'implemented'
              : 'pending',
    };
    if (!released) pending.push(platform);
  }
  return { complete: pending.length === 0, platforms, pending };
}
