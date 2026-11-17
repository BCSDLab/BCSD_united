#!/usr/bin/env node
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  validateTask,
  createState,
  recordImplementation,
  recordVerification,
  recordReview,
  recordRelease,
  summarize,
} from './model.mjs';
import { runProfile } from './runner.mjs';

const usage = `Development harness (local operator only)
  init TASK.json STATE.json
  status TASK.json STATE.json
  brief TASK.json
  run TASK.json PLATFORM PROFILE.json SHA OUTPUT_DIRECTORY
  implement TASK.json STATE.json PLATFORM SHA PR_URL [FIGMA_URL FIGMA_VERSION]
  verify TASK.json STATE.json PLATFORM PROFILE.json OUTPUT_DIRECTORY
  review TASK.json STATE.json PLATFORM SHA REVIEWER EVIDENCE
  release TASK.json STATE.json PLATFORM SHA EVIDENCE
  report TASK.json STATE.json

run executes a profile at a pinned commit and writes report.json without touching any state.
Feature and redesign implementations must record the Figma frame URL and version they match.
Profiles are trusted local executable configuration, never webhook/request input.
Review and release record human attestations; they do not approve or deploy remotely.
Use a new state file after changing task requirements, API version, or target base.
`;

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function atomicWrite(path, value) {
  const absolute = resolve(path);
  const temporary = `${absolute}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    await rename(temporary, absolute);
  } finally {
    await rm(temporary, { force: true });
  }
}

// A second operator must not overwrite a verification or an intervening review.
async function withLock(path, action) {
  await mkdir(dirname(resolve(path)), { recursive: true });
  const lockPath = `${resolve(path)}.lock`;
  const lock = await open(lockPath, 'wx');
  try {
    return await action();
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

function cell(value) {
  return String(value)
    .replaceAll('|', '\\|')
    .replace(/[\r\n]/g, ' ');
}

function brief(task) {
  return [
    `# ${task.id}: ${task.kind}`,
    '',
    task.goal,
    '',
    '## Targets',
    ...Object.entries(task.targets).map(
      ([platform, target]) => `- ${platform}: ${target.repository}@${target.baseSha}; reviewer: ${target.reviewer}`,
    ),
    '',
    '## Acceptance scenarios',
    ...task.scenarios.map((scenario) => `- ${scenario.id}: ${scenario.expected}`),
    '',
    '## Dependencies',
    ...(task.dependencies ?? []).map((dependency) => `- ${dependency.id}: ${dependency.status} — ${dependency.detail}`),
    ...(task.figma ? ['', `Figma: ${task.figma.url} (version: ${task.figma.version})`] : []),
    ...(task.api ? ['', `API: ${task.api.url} (version: ${task.api.version})`] : []),
    '',
    '## Work contract',
    JSON.stringify(task[task.kind], null, 2),
    '',
  ].join('\n');
}

function report(task, state) {
  const summary = summarize(state, task);
  const lines = [
    brief(task),
    '## Platform evidence',
    '',
    '| Platform | Implementation SHA / PR | Figma | Verification | Review | Release |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const [platform, entry] of Object.entries(state.platforms)) {
    const figma = entry.implementation?.figma;
    lines.push(
      `| ${cell(platform)} | ${cell(entry.implementation ? `${entry.implementation.sha} ${entry.implementation.pr}` : 'pending')} | ${cell(figma ? `${figma.url} (version: ${figma.version})` : 'none')} | ${cell(entry.verification ? JSON.stringify(entry.verification) : 'unverified')} | ${cell(entry.review ? JSON.stringify(entry.review) : 'pending')} | ${cell(entry.release ? JSON.stringify(entry.release) : 'pending')} |`,
    );
  }
  lines.push('', `All target platforms released: ${summary.complete ? 'yes' : 'no'}`, '');
  return lines.join('\n');
}

async function execute(task, platform, profileArgument, sha, outputArgument) {
  const profilePath = resolve(profileArgument);
  const profile = await json(profilePath);
  // Resolve paths against the operator profile, not the caller's working directory.
  if (profile.checkout) profile.checkout = resolve(dirname(profilePath), profile.checkout);
  if (profile.baselineCheckout) profile.baselineCheckout = resolve(dirname(profilePath), profile.baselineCheckout);
  const outputDir = resolve(outputArgument);
  await mkdir(outputDir, { recursive: true });
  const result = await runProfile({ task, platform, profile, sha, outputDir });
  const reportPath = resolve(outputDir, 'report.json');
  await atomicWrite(reportPath, result);
  return { result, reportPath };
}

export async function main(args) {
  if (!args.length || args[0] === '--help' || args[0] === 'help') {
    process.stdout.write(usage);
    return;
  }
  const [command, taskPath, statePath, platform, ...rest] = args;
  const lengths = { init: 3, status: 3, brief: 2, run: 6, implement: 6, verify: 6, review: 7, release: 6, report: 3 };
  const figmaArgs = command === 'implement' && args.length === 8;
  if (!Object.hasOwn(lengths, command) || (args.length !== lengths[command] && !figmaArgs)) {
    throw new Error(`Invalid arguments.\n${usage}`);
  }
  const task = validateTask(await json(taskPath));
  if (command === 'brief') {
    process.stdout.write(brief(task));
    return;
  }
  if (command === 'run') {
    // 상태를 바꾸지 않는 현재 상태 재현이다. statePath·platform 자리에 PLATFORM·PROFILE이 온다.
    if (!Object.hasOwn(task.targets, statePath)) throw new Error(`Platform is not targeted: ${statePath}`);
    const { result, reportPath } = await execute(task, statePath, platform, rest[0], rest[1]);
    process.stdout.write(
      `${JSON.stringify({ reportPath, status: result.status, passed: result.passed, scenarios: result.scenarios }, null, 2)}\n`,
    );
    if (!result.passed) process.exitCode = 1;
    return;
  }
  if (command === 'status' || command === 'report') {
    const state = await json(statePath);
    process.stdout.write(
      command === 'report' ? report(task, state) : `${JSON.stringify(summarize(state, task), null, 2)}\n`,
    );
    return;
  }
  await withLock(statePath, async () => {
    if (command === 'init') {
      // Exclusive create: initialization cannot erase existing reviews or release evidence.
      await writeFile(statePath, `${JSON.stringify(createState(task), null, 2)}\n`, { flag: 'wx' });
      process.stdout.write(`Initialized ${task.id}\n`);
      return;
    }
    const state = await json(statePath);
    summarize(state, task);
    if (!Object.hasOwn(task.targets, platform)) throw new Error(`Platform is not targeted: ${platform}`);
    if (command === 'implement') {
      recordImplementation(state, task, platform, {
        sha: rest[0],
        pr: rest[1],
        ...(figmaArgs ? { figma: { url: rest[2], version: rest[3] } } : {}),
      });
    } else if (command === 'verify') {
      const implementation = state.platforms[platform].implementation;
      if (!implementation) throw new Error('Record implementation before verification');
      const { result, reportPath } = await execute(task, platform, rest[0], implementation.sha, rest[1]);
      recordVerification(state, task, platform, { ...result, reportPath });
      await atomicWrite(statePath, state);
      process.stdout.write(`${JSON.stringify({ reportPath, ...summarize(state, task) }, null, 2)}\n`);
      if (!result.passed) process.exitCode = 1;
      return;
    } else if (command === 'review') {
      recordReview(state, task, platform, { sha: rest[0], reviewer: rest[1], evidence: rest[2] });
    } else if (command === 'release') {
      recordRelease(state, task, platform, { sha: rest[0], evidence: rest[1] });
    }
    await atomicWrite(statePath, state);
    process.stdout.write(`${JSON.stringify(summarize(state, task), null, 2)}\n`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
