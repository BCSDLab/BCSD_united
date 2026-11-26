#!/usr/bin/env node
// KOIN_ANDROID Maestro 워크플로 런의 흐름 전체를 하니스 작업 파일과 프로필로 만든다.
// - 런의 job 중 이름이 "Maestro <흐름>"인 것마다 시나리오 하나와 github-run.mjs 단계 하나를 만든다.
// - 런의 head_sha가 --sha와 같아야 한다. 실패한 job도 시나리오로 넣는다. 통과 여부는 하니스 실행이 판정한다.
// - 읽기 전용이다. 워크플로를 실행하지 않는다.
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const GH = process.platform === 'win32' ? 'gh.exe' : 'gh';
const BUILD_JOB = 'Build stage QA APK';
const usage =
  'Usage: android-suite.mjs --run-id N --sha FULL_SHA --checkout ABSOLUTE_DIR --reviewer NAME --work DIR [--repo OWNER/REPO]';

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function gh(args) {
  return new Promise((resolve, reject) => {
    execFile(GH, args, { maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(`gh failed: ${stderr.trim() || error.message}`));
      else resolve(JSON.parse(stdout));
    });
  });
}

/** job 이름 목록에서 흐름 이름을 뽑는다. 빌드 job이 없거나 흐름 이름이 겹치면 거부한다. */
export function flowsFromJobs(names) {
  requireValue(names.includes(BUILD_JOB), `Run has no "${BUILD_JOB}" job`);
  const flows = names
    .map((name) => /^Maestro ([a-z0-9_]+)$/.exec(name)?.[1])
    .filter(Boolean)
    .sort();
  requireValue(flows.length > 0, 'Run has no "Maestro <flow>" jobs');
  requireValue(new Set(flows).size === flows.length, 'Run has duplicate Maestro flow jobs');
  return flows;
}

export function buildSuite({ flows, successfulFlows = [], repo, runId, sha, checkout, reviewer, script }) {
  const step = (job, extra = []) => [
    'node',
    script,
    '--repo',
    repo,
    '--run-id',
    String(runId),
    '--sha',
    sha,
    '--job',
    job,
    ...extra,
  ];
  const out = (flow) => `build/harness/android/${flow}`;
  return {
    task: {
      schemaVersion: 1,
      id: `android-flows-${sha.slice(0, 7)}`,
      kind: 'feature',
      goal: `KOIN_ANDROID ${sha.slice(0, 7)}의 Maestro 흐름 전체를 실행 증거로 확인한다`,
      scenarios: flows.map((flow) => ({ id: flow, expected: `.maestro/${flow}.yaml 흐름이 통과한다` })),
      targets: { android: { repository: repo, baseSha: sha, reviewer } },
      dependencies: [],
      feature: { acceptance: '모든 흐름의 job이 성공하고 흐름별 산출물이 남는다' },
    },
    profile: {
      checkout,
      repository: repo,
      timeoutMs: 1_800_000,
      steps: [
        { id: 'build-stage-qa-apk', kind: 'build', command: step(BUILD_JOB) },
        ...flows.map((flow) => ({
          id: flow,
          kind: 'scenario',
          scenarioId: flow,
          command: step(`Maestro ${flow}`, [
            '--artifact',
            `^maestro-${flow}-\\d{4}-\\d{2}-\\d{2}$`,
            '--out',
            out(flow),
          ]),
        })),
      ],
      // 실패한 job은 evidence.json을 만들지 않는다. 성공 job의 증거만 수집하되 실패 단계는 그대로 남긴다.
      artifacts: successfulFlows.map((flow) => `${out(flow)}/evidence.json`),
    },
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      repo: { type: 'string', default: 'BCSDLab/KOIN_ANDROID' },
      'run-id': { type: 'string' },
      sha: { type: 'string' },
      checkout: { type: 'string' },
      reviewer: { type: 'string' },
      work: { type: 'string' },
    },
  });
  requireValue(values['run-id'] && values.sha && values.checkout && values.reviewer && values.work, usage);
  requireValue(/^[a-f0-9]{40}$/.test(values.sha), '--sha must be a full lowercase commit hash');
  requireValue(path.isAbsolute(values.checkout), '--checkout must be an absolute path');
  const run = await gh(['api', `repos/${values.repo}/actions/runs/${values['run-id']}`]);
  requireValue(run.head_sha === values.sha, `Run ${values['run-id']} head_sha is ${run.head_sha}, not ${values.sha}`);
  const jobs = await gh(['api', `repos/${values.repo}/actions/runs/${values['run-id']}/jobs?per_page=100`]);
  const suite = buildSuite({
    flows: flowsFromJobs(jobs.jobs.map((job) => job.name)),
    successfulFlows: jobs.jobs
      .filter((job) => job.conclusion === 'success' && /^Maestro [a-z0-9_]+$/.test(job.name))
      .map((job) => job.name.slice('Maestro '.length)),
    repo: values.repo,
    runId: values['run-id'],
    sha: values.sha,
    checkout: values.checkout,
    reviewer: values.reviewer,
    script: fileURLToPath(new URL('./github-run.mjs', import.meta.url)),
  });
  await mkdir(values.work, { recursive: true });
  await writeFile(path.join(values.work, 'android.task.json'), `${JSON.stringify(suite.task, null, 2)}\n`);
  await writeFile(path.join(values.work, 'android.profile.json'), `${JSON.stringify(suite.profile, null, 2)}\n`);
  console.log(`${suite.task.scenarios.length} flows: ${suite.task.scenarios.map(({ id }) => id).join(', ')}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
