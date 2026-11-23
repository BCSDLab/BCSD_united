#!/usr/bin/env node
// 계약: 이미 끝난 GitHub Actions 실행을 고정 커밋의 실행 증거로 검증한다.
// - 실행의 head_sha가 --sha와 정확히 같고 실행이 --repo 소속일 때만 통과한다.
// - --job과 이름이 정확히 같은 작업이 하나이고 결론이 success일 때만 통과한다.
// - --artifact를 주면 만료되지 않은 일치 아티팩트를 --out(cwd 안쪽 상대 경로)에 내려받고
//   evidence.json에 실행·작업 정보와 파일별 크기·SHA-256을 기록한다.
// - --out은 비어 있거나 이 스크립트가 만든 디렉터리여야 하며, 재실행 시 그 디렉터리만 비운다.
// 한계: 워크플로 디스패치는 구현하지 않는다. 대상 워크플로를 디스패치하면 팀 Slack 채널에
// 알림이 전송되므로, 실행은 사람이 직접 시작하고 이 스크립트는 읽기 전용 조회와 다운로드만 한다.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const TOOL = 'github-run';
const GH = process.platform === 'win32' ? 'gh.exe' : 'gh';
const usage =
  'Usage: github-run.mjs --repo OWNER/REPO --run-id N --sha FULL_SHA --job "JOB NAME" [--artifact NAME_REGEX --out RELATIVE_DIR]';

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function gh(args, timeout = 60_000) {
  return new Promise((resolve, reject) => {
    execFile(
      GH,
      args,
      {
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        env: { ...process.env, GH_PROMPT_DISABLED: '1' },
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${stderr.trim() || error.message}`));
        else resolve(stdout);
      },
    );
  });
}

async function ghList(endpoint, key) {
  const lines = await gh(['api', '--paginate', `${endpoint}?per_page=100`, '--jq', `.${key}[]`]);
  return lines
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function within(root, filename) {
  const relative = path.relative(root, filename);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function prepareOutput(out) {
  const segments = out.split(/[\\/]/);
  requireValue(
    !path.isAbsolute(out) && !out.includes(':') && segments.every((part) => part && part !== '.' && part !== '..'),
    '--out must be a relative directory inside the working directory',
  );
  const root = await realpath(process.cwd());
  const directory = path.join(root, ...segments);
  const existing = await readdir(directory).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  if (existing.length > 0) {
    const previous = await readFile(path.join(directory, 'evidence.json'), 'utf8')
      .then(JSON.parse)
      .catch(() => null);
    requireValue(previous?.tool === TOOL, '--out must be empty or a directory previously written by this script');
    requireValue(within(root, await realpath(directory)), '--out escapes the working directory');
    await rm(directory, { recursive: true });
  }
  await mkdir(directory, { recursive: true });
  requireValue((await realpath(directory)) === directory, '--out must not traverse symlinks');
  return directory;
}

async function listFiles(root, directory = root) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(root, filename)));
    else if (entry.isFile()) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(filename)) hash.update(chunk);
      files.push({
        path: path.relative(root, filename).split(path.sep).join('/'),
        bytes: (await stat(filename)).size,
        sha256: hash.digest('hex'),
      });
    }
  }
  return files.toSorted((a, b) => (a.path < b.path ? -1 : 1));
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      'run-id': { type: 'string' },
      sha: { type: 'string' },
      job: { type: 'string' },
      artifact: { type: 'string' },
      out: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  const { repo, sha, job: jobName, artifact, out } = values;
  const runId = values['run-id'];
  requireValue(repo && runId && sha && jobName, usage);
  requireValue(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo), '--repo must be OWNER/REPO');
  requireValue(/^[1-9]\d*$/.test(runId), '--run-id must be a positive integer');
  requireValue(/^[a-f\d]{40}$/.test(sha), '--sha must be a full 40-character lowercase commit hash');
  requireValue((artifact === undefined) === (out === undefined), '--artifact and --out must be given together');
  const pattern = artifact === undefined ? null : new RegExp(artifact);

  const run = JSON.parse(await gh(['api', `repos/${repo}/actions/runs/${runId}`]));
  requireValue(String(run.id) === runId, `Run ${runId} was not returned by GitHub`);
  requireValue(run.repository?.full_name === repo, `Run ${runId} belongs to ${run.repository?.full_name}, not ${repo}`);
  requireValue(run.head_sha === sha, `Run ${runId} head_sha is ${run.head_sha}, not ${sha}`);

  const jobs = (await ghList(`repos/${repo}/actions/runs/${runId}/jobs`, 'jobs')).filter(
    (candidate) => candidate.name === jobName,
  );
  requireValue(jobs.length === 1, `Run ${runId} has ${jobs.length} jobs named "${jobName}" in its latest attempt`);
  const [job] = jobs;
  requireValue(job.head_sha === sha, `Job "${jobName}" head_sha is ${job.head_sha}, not ${sha}`);
  requireValue(
    job.status === 'completed' && job.conclusion === 'success',
    `Job "${jobName}" is ${job.status}/${job.conclusion}, not completed/success: ${job.html_url}`,
  );

  const evidence = {
    schemaVersion: 1,
    tool: TOOL,
    repository: repo,
    run: {
      id: run.id,
      url: run.html_url,
      event: run.event,
      workflow: run.path,
      attempt: run.run_attempt,
      headSha: run.head_sha,
      status: run.status,
      conclusion: run.conclusion,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
    },
    job: {
      id: job.id,
      name: job.name,
      url: job.html_url,
      conclusion: job.conclusion,
      startedAt: job.started_at,
      completedAt: job.completed_at,
    },
  };

  if (pattern) {
    const artifacts = (await ghList(`repos/${repo}/actions/runs/${runId}/artifacts`, 'artifacts')).filter(
      (candidate) => !candidate.expired && pattern.test(candidate.name),
    );
    requireValue(artifacts.length > 0, `Run ${runId} has no unexpired artifact matching /${artifact}/`);
    const names = new Set(artifacts.map(({ name }) => name));
    requireValue(
      names.size === artifacts.length && [...names].every((name) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)),
      'Matching artifact names must be distinct plain directory names',
    );
    const directory = await prepareOutput(out);
    for (const { name } of artifacts) {
      await gh(
        ['run', 'download', runId, '--repo', repo, '--name', name, '--dir', path.join(directory, name)],
        10 * 60_000,
      );
    }
    evidence.artifacts = artifacts.map((item) => ({
      id: item.id,
      name: item.name,
      zipBytes: item.size_in_bytes,
      zipDigest: item.digest ?? null,
      createdAt: item.created_at,
      expiresAt: item.expires_at,
    }));
    evidence.files = await listFiles(directory);
    requireValue(evidence.files.length > 0, 'Downloaded artifacts contain no files');
    await writeFile(path.join(directory, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  }
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
