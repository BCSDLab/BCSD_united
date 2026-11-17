import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const SHA = /^[a-f\d]{40}$/i;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TIMEOUT_MS = 60 * 60 * 1000;

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function commandValue(command) {
  return (
    Array.isArray(command) &&
    command.length > 0 &&
    command.every((part) => typeof part === 'string' && !part.includes('\0')) &&
    command[0].length > 0
  );
}

function within(root, filename) {
  const relative = path.relative(root, filename);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function normalizedOrigin(value) {
  let origin = value.trim();
  const scp = /^git@github\.com:([^\s]+)$/.exec(origin);
  if (scp) origin = `ssh://git@github.com/${scp[1]}`;
  try {
    const url = new URL(origin);
    if (url.hostname !== 'github.com' || url.search || url.hash || url.password) return null;
    if (url.protocol === 'https:') {
      if (url.username || (url.port && url.port !== '443')) return null;
    } else if (url.protocol === 'ssh:') {
      if (url.username !== 'git' || (url.port && url.port !== '22')) return null;
    } else return null;
    const repository = url.pathname
      .replace(/^\//, '')
      .replace(/\/$/, '')
      .replace(/\.git$/, '');
    return /^BCSDLab\/[A-Za-z0-9_.-]+$/.test(repository) ? repository : null;
  } catch {
    return null;
  }
}

async function git(checkout, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: checkout, shell: false, windowsHide: true });
    const chunks = [];
    let bytes = 0;
    let failure;
    const timer = setTimeout(() => {
      failure = new Error(`Git check timed out: ${args[0]}`);
      child.kill('SIGKILL');
    }, 30_000);
    const capture = (chunk) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        failure = new Error(`Git check output exceeded limit: ${args[0]}`);
        child.kill('SIGKILL');
      } else chunks.push(chunk);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.once('error', (error) => {
      failure = error;
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else resolve({ code, text: Buffer.concat(chunks).toString('utf8').trim() });
    });
  });
}

async function verifyCheckout(checkout, repository, baseSha, sha) {
  requireValue(typeof checkout === 'string' && path.isAbsolute(checkout), 'checkout must be an absolute local path');
  const directory = await realpath(checkout);
  requireValue((await stat(directory)).isDirectory(), 'checkout must be a directory');
  const root = await git(directory, ['rev-parse', '--show-toplevel']);
  requireValue(
    root.code === 0 && (await realpath(root.text)) === directory,
    'checkout must be the exact Git root, not a child directory',
  );
  const origin = await git(directory, ['remote', 'get-url', 'origin']);
  requireValue(
    origin.code === 0 && normalizedOrigin(origin.text) === repository,
    'checkout origin does not match the target repository',
  );
  for (const commit of new Set([baseSha, sha])) {
    const exists = await git(directory, ['cat-file', '-e', `${commit}^{commit}`]);
    requireValue(exists.code === 0, `Commit is unavailable locally: ${commit}`);
  }
  const ancestor = await git(directory, ['merge-base', '--is-ancestor', baseSha, sha]);
  requireValue(ancestor.code === 0, 'baseSha must be an ancestor of the requested sha');
  const head = await git(directory, ['rev-parse', '--verify', 'HEAD']);
  requireValue(
    head.code === 0 && head.text.toLowerCase() === sha.toLowerCase(),
    'checkout HEAD does not match the requested sha',
  );
  const status = await git(directory, ['status', '--porcelain=v1', '--untracked-files=all']);
  requireValue(status.code === 0 && status.text === '', 'checkout must be clean, including untracked files');
  return directory;
}

async function runCommand({ command, cwd, outputDir, prefix, timeoutMs, expectedExitCode, ...metadata }) {
  const stdout = `${prefix}.stdout.log`;
  const stderr = `${prefix}.stderr.log`;
  const result = {
    ...metadata,
    command: [...command],
    expectedExitCode,
    stdout,
    stderr,
    startedAt: new Date().toISOString(),
    exitCode: null,
    signal: null,
    timedOut: false,
    passed: false,
  };
  const out = await open(path.join(outputDir, stdout), 'wx');
  let err;
  try {
    err = await open(path.join(outputDir, stderr), 'wx');
    await new Promise((resolve) => {
      const child = spawn(command[0], command.slice(1), {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', out.fd, err.fd],
      });
      const timer = setTimeout(() => {
        result.timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.once('error', (error) => {
        result.error = error.message;
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        result.exitCode = code;
        result.signal = signal;
        result.passed = !result.error && !result.timedOut && code === expectedExitCode;
        resolve();
      });
    });
  } finally {
    await out.close();
    if (err) await err.close();
  }
  result.completedAt = new Date().toISOString();
  return result;
}

async function collectArtifact(checkout, outputDir, source, index) {
  requireValue(typeof source === 'string' && source.length > 0, 'Artifact paths must be nonempty strings');
  const segments = source.split(/[\\/]/);
  requireValue(
    !path.isAbsolute(source) &&
      !source.includes(':') &&
      ![...source].some((char) => char.charCodeAt(0) < 0x20) &&
      segments.every((part) => part && part !== '.' && part !== '..'),
    'Artifact paths must be bounded relative checkout paths',
  );
  const filename = await realpath(path.resolve(checkout, ...segments));
  requireValue(within(checkout, filename), 'Artifact symlink escapes the checkout');
  requireValue((await stat(filename)).isFile(), 'Artifact must be an existing file');
  const basename = segments
    .at(-1)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 100);
  const relative = `artifacts/${String(index).padStart(3, '0')}-${basename}`;
  await copyFile(filename, path.join(outputDir, relative), 1);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path.join(outputDir, relative))) hash.update(chunk);
  return {
    source,
    path: relative,
    sha256: hash.digest('hex'),
    bytes: (await stat(path.join(outputDir, relative))).size,
  };
}

/** Runs only operator-owned argv commands; task text is never executable input. */
export async function runProfile({ task, platform, profile, sha, outputDir }) {
  const target = task?.targets?.[platform];
  const report = {
    platform,
    repository: target?.repository ?? null,
    baseSha: target?.baseSha ?? null,
    sha: sha ?? null,
    passed: false,
    status: 'blocked',
    startedAt: new Date().toISOString(),
    scenarios: (Array.isArray(task?.scenarios) ? task.scenarios : []).map(({ id }) => ({ id, passed: false })),
    steps: [],
    artifacts: [],
    errors: [],
    evidence: 'Operator-owned local commands; scenario success is not independent UI verification.',
  };
  let executed = false;
  try {
    requireValue(['web', 'android', 'ios'].includes(platform) && target, 'Task does not select this platform');
    requireValue(platform !== 'ios' || process.platform === 'darwin', 'iOS execution requires a macOS host');
    requireValue(
      typeof target.repository === 'string' && /^BCSDLab\/[A-Za-z0-9_.-]+$/.test(target.repository),
      'Invalid target repository',
    );
    requireValue(
      typeof target.baseSha === 'string' && SHA.test(target.baseSha),
      'baseSha must be a full 40-character commit hash',
    );
    requireValue(typeof sha === 'string' && SHA.test(sha), 'sha must be a full 40-character commit hash');
    requireValue(profile && profile.repository === target.repository, 'Profile repository must match the task target');
    requireValue(Array.isArray(profile.steps) && profile.steps.length > 0, 'Profile must define executable steps');
    const timeoutMs = profile.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    requireValue(
      Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS,
      'timeoutMs must be between 1 and 3600000',
    );
    const scenarioIds = new Set(report.scenarios.map(({ id }) => id));
    requireValue(
      report.scenarios.length > 0 &&
        scenarioIds.size === report.scenarios.length &&
        [...scenarioIds].every((id) => typeof id === 'string' && id.length > 0),
      'Task scenarios must have distinct nonempty IDs',
    );
    const stepIds = new Set();
    for (const step of profile.steps) {
      requireValue(
        step && typeof step.id === 'string' && step.id.length > 0 && !stepIds.has(step.id),
        'Profile steps require distinct nonempty IDs',
      );
      stepIds.add(step.id);
      requireValue(
        ['build', 'scenario', 'reproduction'].includes(step.kind) && commandValue(step.command),
        'Step kind or argv command is invalid',
      );
      requireValue(
        step.kind !== 'scenario' || scenarioIds.has(step.scenarioId),
        'Scenario steps must reference a task scenario ID',
      );
    }
    requireValue(
      profile.artifacts === undefined || Array.isArray(profile.artifacts),
      'Profile artifacts must be an array',
    );
    const candidate = await verifyCheckout(profile.checkout, target.repository, target.baseSha, sha);
    let baseline;
    if (task.kind === 'error') {
      requireValue(
        commandValue(profile.reproduction?.command) &&
          Number.isInteger(profile.reproduction?.expectedExitCode) &&
          profile.reproduction.expectedExitCode > 0 &&
          profile.reproduction.expectedExitCode <= 255,
        'Error tasks require reproduction argv with an expected nonzero exit code',
      );
      baseline = await verifyCheckout(profile.baselineCheckout, target.repository, target.baseSha, target.baseSha);
      requireValue(baseline !== candidate, 'Baseline checkout must differ from the candidate checkout');
    }
    requireValue(typeof outputDir === 'string' && outputDir.length > 0, 'An evidence output directory is required');
    const destination = path.resolve(outputDir);
    await mkdir(destination, { recursive: true });
    const output = await realpath(destination);
    requireValue(
      !within(candidate, output) && (!baseline || !within(baseline, output)),
      'Evidence output must be outside candidate and baseline checkouts',
    );
    await mkdir(path.join(output, 'artifacts'), { recursive: true });
    requireValue(
      (await realpath(path.join(output, 'artifacts'))) === path.join(output, 'artifacts'),
      'Artifact output directory must not be a symlink',
    );
    if (baseline) {
      executed = true;
      const step = await runCommand({
        command: profile.reproduction.command,
        cwd: baseline,
        outputDir: output,
        prefix: `${platform}-000-baseline-reproduction`,
        timeoutMs,
        expectedExitCode: profile.reproduction.expectedExitCode,
        id: 'baseline-reproduction',
        kind: 'reproduction',
        phase: 'baseline',
      });
      report.steps.push(step);
      await verifyCheckout(baseline, target.repository, target.baseSha, target.baseSha);
      requireValue(step.passed, 'Baseline reproduction did not fail with the expected exit code');
      await verifyCheckout(candidate, target.repository, target.baseSha, sha);
    }
    for (const [index, step] of profile.steps.entries()) {
      executed = true;
      const safeId = step.id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
      const result = await runCommand({
        command: step.command,
        cwd: candidate,
        outputDir: output,
        prefix: `${platform}-${String(index + 1).padStart(3, '0')}-${safeId}`,
        timeoutMs,
        expectedExitCode: 0,
        id: step.id,
        kind: step.kind,
        ...(step.kind === 'scenario' ? { scenarioId: step.scenarioId } : {}),
        phase: 'candidate',
      });
      report.steps.push(result);
    }
    await verifyCheckout(candidate, target.repository, target.baseSha, sha);
    for (const [index, source] of (profile.artifacts ?? []).entries()) {
      report.artifacts.push(await collectArtifact(candidate, output, source, index));
    }
    for (const scenario of report.scenarios) {
      scenario.passed = report.steps.some(
        (step) =>
          step.phase === 'candidate' && step.kind === 'scenario' && step.scenarioId === scenario.id && step.passed,
      );
    }
    if (!report.steps.some((step) => step.phase === 'candidate' && step.kind === 'build' && step.passed)) {
      report.errors.push('At least one successful build step is required');
    }
    if (report.scenarios.some((scenario) => !scenario.passed))
      report.errors.push('Every task scenario requires successful matching command evidence');
    if (report.steps.some((step) => !step.passed))
      report.errors.push('One or more commands failed, timed out, or could not start');
    report.passed = report.errors.length === 0;
    report.status = report.passed ? 'passed' : 'failed';
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
    report.status = executed ? 'failed' : 'blocked';
  }
  report.completedAt = new Date().toISOString();
  return report;
}
