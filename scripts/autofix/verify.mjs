import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, realpathSync, rmSync } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { applyManifest, assertSnapshotMatchesTree, exportTree, validateManifest } from './patch.mjs';
import {
  ERROR_CHECKS,
  PR_CHECKS,
  SHA,
  isSourcePath,
  jsonFile,
  pullRequestPolicy,
  relatedDirectories,
  runtimeProfiles,
  validateChangedFiles,
} from './common.mjs';

const offlineSmoke = process.argv[2] === '--offline-smoke';
if (process.argv.length > (offlineSmoke ? 3 : 2)) throw new Error('Unknown verifier argument');
const rawContext = offlineSmoke
  ? { app: 'web', route: '/', baseSha: 'offline-local' }
  : await jsonFile('error-input/context.json');
// Pull-request verification is an explicit mode; everything else is the
// unchanged error-repair path (an error context never carries `mode`).
const prMode = !offlineSmoke && rawContext?.mode === 'pull-request';
if (!offlineSmoke && rawContext?.mode !== undefined && !prMode) throw new Error('Unknown verifier context mode');
const context = prMode ? pullRequestContext(rawContext) : rawContext;
const policy = prMode ? pullRequestPolicy(context.changedFiles) : undefined;
const manifest = offlineSmoke
  ? { version: 1, files: [] }
  : validateManifest(await jsonFile('error-patch/patch.json'), policy);
if (!offlineSmoke && !prMode) {
  if (!manifest.files.length) throw new Error('NO_CHANGES: agent produced no fix; no PR will be created');
  if (!manifest.files.some((file) => isSourcePath(file.path))) throw new Error('No source fix was produced');
}
const tests = prMode ? [] : manifest.files.filter((file) => file.path.startsWith('tests/autofix/'));
if (!offlineSmoke && !prMode && (!tests.length || tests.some((file) => file.before !== null || file.content === null)))
  throw new Error('A new executable regression test is required; existing tests cannot be weakened');
if (!prMode) {
  if (
    !['web', 'api'].includes(context.app) ||
    manifest.files.some((file) => isSourcePath(file.path) && !file.path.startsWith(`apps/${context.app}/src/`))
  )
    throw new Error('A candidate must target only its allowlisted application');
  if (context.app === 'api' && context.requestMethod !== 'GET')
    throw new Error(
      'API smoke requires an observed safe GET request; mutating or unknown methods need manual reproduction',
    );
  if (!context.route) throw new Error('No safe canonical event URL maps to a route; manual reproduction is required');
}

function pullRequestContext(value) {
  if (
    Object.keys(value).sort().join(',') !== 'baseSha,changedFiles,headSha,headTree,mode,pullNumber' ||
    !Number.isSafeInteger(value.pullNumber) ||
    value.pullNumber < 1 ||
    !SHA.test(value.headSha) ||
    !SHA.test(value.headTree) ||
    !SHA.test(value.baseSha) ||
    value.headSha === value.baseSha
  )
    throw new Error('Invalid pull-request verification context');
  validateChangedFiles(value.changedFiles);
  return value;
}
const profiles = prMode ? runtimeProfiles(context.changedFiles) : new Set([context.app]);
const related = prMode ? relatedDirectories(context.changedFiles) : new Set();
const releaseSha = prMode ? context.headSha : context.baseSha;

// The trusted root is canonical so later candidate scratch/symlink escape checks
// compare against the real snapshot path (macOS tmpdir /var is itself a symlink).
const root = await realpath(await mkdtemp(resolve(process.env.RUNNER_TEMP ?? tmpdir(), 'error-verification-')));
let dependencyMounts = [];
process.once('exit', () => {
  try {
    cleanupSnapshot();
  } catch (error) {
    process.stderr.write(
      `Verifier snapshot cleanup failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
});
/** Pinned tree entries of the verified snapshot (`null` for the offline worktree copy). */
let snapshot = null;
if (offlineSmoke) {
  // Snapshot only git-tracked paths from the current worktree. No .env, PEM,
  // untracked secrets, host node_modules or user Docker mounts enter the image.
  const tracked = execFileSync('git', ['ls-files', '-z'], { maxBuffer: 20_000_000 }).toString().split('\0');
  for (const relative of tracked) {
    if (!relative) continue;
    const parts = relative.split('/');
    const basename = parts.at(-1);
    if (
      parts.includes('.secret') ||
      /\.(?:pem|p12|key)$/i.test(basename) ||
      (/^(?:\.env(?:\..*)?|\.dev\.vars(?:\..*)?|webhook-secret\.txt|google-auth-secret\.txt)$/.test(basename) &&
        !basename.endsWith('.example'))
    )
      throw new Error(`Private file cannot enter the offline snapshot: ${relative}`);
    const source = resolve(relative);
    const destination = resolve(root, relative);
    let stat;
    try {
      stat = await lstat(source);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Unsupported tracked path: ${relative}`);
    await mkdir(dirname(destination), { recursive: true });
    if (stat.isSymbolicLink()) await symlink(await readlink(source), destination);
    else await copyFile(source, destination);
  }
} else {
  if (prMode) pinPullRequestHead();
  // Built from the object database, not `git archive`: a PR head's
  // `.gitattributes` must not be able to drop or rewrite pinned files.
  snapshot = await exportTree(releaseSha, root);
}
/** Dependency directories are the only snapshot paths lifecycle scripts may populate. */
const dependencyDirectory = (relative) => relative.split('/').at(-1) === 'node_modules';

/**
 * `pr-head-pinned`: the worktree HEAD, the archived commit and its tree are the
 * exact GitHub-reported head, and the target develop commit is present AND an
 * ancestor of the head (the parent integrates develop before pinning, so the
 * verified state is the merged state, never an older integration), before
 * anything from the PR is read.
 */
function pinPullRequestHead() {
  const git = (args) => execFileSync('git', args, { maxBuffer: 1_000_000 }).toString().trim();
  if (git(['rev-parse', 'HEAD']) !== context.headSha) throw new Error('Verifier worktree is not at the pinned PR head');
  if (git(['rev-parse', '--verify', `${context.headSha}^{commit}`]) !== context.headSha)
    throw new Error('Pinned PR head is not a commit object');
  if (git(['rev-parse', `${context.headSha}^{tree}`]) !== context.headTree)
    throw new Error('Pinned PR head tree does not match the canonical GitHub tree');
  if (git(['rev-parse', '--verify', `${context.baseSha}^{commit}`]) !== context.baseSha)
    throw new Error('Target develop commit is not pinned in the verifier');
  const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', context.baseSha, context.headSha], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (ancestry.error || ancestry.status !== 0)
    throw new Error('Target develop commit is not an ancestor of the PR head; integrate develop and re-pin');
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=no']).toString().trim())
    throw new Error('Verifier worktree has unexpected modifications');
}

// Error-mode regression tests live here; the PR head is never a target of host
// writes, so its (possibly symlinked) `tests` entry is left untouched.
if (!prMode) await mkdir(`${root}/tests/autofix`, { recursive: true });
const automation = resolve('scripts/autofix');
const input = offlineSmoke ? `${root}/offline-input` : resolve('error-input');
const patchDirectory = offlineSmoke ? `${root}/offline-patch` : resolve('error-patch');
if (offlineSmoke) {
  await mkdir(input);
  await mkdir(patchDirectory);
  await writeFile(`${input}/context.json`, JSON.stringify(context));
  await writeFile(`${patchDirectory}/patch.json`, JSON.stringify(manifest));
}
async function directoryExists(relative) {
  try {
    return (await lstat(`${root}/${relative}`)).isDirectory();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
const crawlerPresent = prMode && (await directoryExists('apps/b-bot-crawler'));
const bbotRuntimeScratch = profiles.has('b-bot')
  ? [
      'apps/b-bot/.wrangler',
      'apps/b-bot/node_modules/.vite-temp',
      'apps/b-bot/node_modules/.vite',
      ...(crawlerPresent ? ['apps/b-bot-crawler/node_modules/.vite', 'apps/b-bot-crawler/data'] : []),
    ]
  : [];
const bbotBuildScratch = profiles.has('b-bot') ? ['apps/b-bot/.nitro', 'apps/b-bot/.output', 'apps/b-bot/dist'] : [];
const runtimeScratch = [
  'apps/web/.wrangler',
  'apps/web/node_modules/.vite-temp',
  'apps/web/node_modules/.vite',
  'apps/api/.wrangler',
  ...bbotRuntimeScratch,
];
const scratch = [...runtimeScratch, 'apps/web/dist', 'apps/web/.tanstack', 'apps/api/dist', ...bbotBuildScratch];
const insideDependency = (directory) =>
  dependencyMounts.some((dependency) => directory === dependency || directory.startsWith(`${dependency}/`));
function cleanupSnapshot() {
  if (process.getuid() === 0) {
    const scoped = [];
    for (const directory of [...scratch.filter((directory) => !insideDependency(directory)), ...dependencyMounts]) {
      const source = `${root}/${directory}`;
      let stat;
      try {
        stat = lstatSync(source);
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(source) !== resolve(root, directory))
        throw new Error(`Unsafe scratch cleanup path: ${directory}`);
      scoped.push(source);
    }
    if (scoped.length) {
      const mounts = scoped.flatMap((source, index) => ['-v', `${source}:/scratch/${index}`]);
      const program =
        'const fs=require("node:fs");for(const dir of process.argv.slice(1))for(const entry of fs.readdirSync(dir))fs.rmSync(dir+"/"+entry,{recursive:true,force:true});';
      const cleaned = spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '--network',
          'none',
          '--read-only',
          '--cap-drop=ALL',
          '--security-opt=no-new-privileges',
          '--pids-limit=32',
          '--memory=128m',
          '--cpus=.25',
          '--user',
          '1000:1000',
          ...mounts,
          'koin-error-verifier',
          'node',
          '-e',
          program,
          ...scoped.map((_, index) => `/scratch/${index}`),
        ],
        { encoding: 'utf8', timeout: 30_000, maxBuffer: 100_000 },
      );
      requireSuccess(cleaned, 'Unprivileged scratch cleanup');
    }
  }
  rmSync(root, { recursive: true, force: true });
}
const limits = ['--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=512', '--memory=3g', '--cpus=2'];
const user = process.getuid() === 0 ? '1000:1000' : `${process.getuid()}:${process.getgid()}`;
// A PR head's lockfile and approved lifecycle scripts are untrusted, so PR mode
// never runs the installer as container root: only dependency directories belong
// to the candidate UID. The error path keeps its existing installer identity.
const installerUser = prMode ? user : `${process.getuid()}:${process.getgid()}`;
const executorRun = process.env.AUTOFIX_EXECUTOR_RUN_ID;
if (executorRun && !/^autofix-[a-f0-9]{64}$/.test(executorRun))
  throw new Error('Invalid isolated executor run identifier');
const labels = executorRun
  ? ['--label', 'koin.autofix.executor=koin-rocky-umpc', '--label', `koin.autofix.run=${executorRun}`]
  : [];
const environment = [
  '-e',
  'CI=true',
  '-e',
  'HUSKY=0',
  '-e',
  'HOME=/tmp',
  '-e',
  'NEXT_PUBLIC_API_PATH=/api',
  '-e',
  'WORKERS_CI_BRANCH=main',
  '-e',
  'KOIN_MAIN_BRANCH=main',
  '-e',
  'CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false',
  '-e',
  'NEXT_PUBLIC_SENTRY_ENVIRONMENT=automation',
  '-e',
  `NEXT_PUBLIC_SENTRY_RELEASE=${releaseSha}`,
  '-e',
  'SENTRY_RELEASE=' + releaseSha,
  '-e',
  'WRANGLER_SEND_METRICS=false',
];
const LIFECYCLE_ENVIRONMENT = [
  '-e',
  'PNPM_CONFIG_CACHE_DIR=/work/node_modules/.cache/pnpm',
  '-e',
  'PNPM_CONFIG_CHILD_CONCURRENCY=1',
  '-e',
  'RAYON_NUM_THREADS=2',
  '-e',
  'UV_THREADPOOL_SIZE=2',
];
function docker(
  command,
  {
    network = false,
    sourceReadonly = true,
    writable = [],
    timeout = 600_000,
    offlineWeb = false,
    offlineStandalone = false,
    workdir = null,
    env = [],
  } = {},
) {
  const name = `koin-error-verifier-${randomUUID()}`;
  const mounts = [
    '-v',
    `${root}:/work${sourceReadonly ? ':ro' : ''}`,
    ...(executorRun ? [] : ['-v', `${automation}:/automation:ro`]),
    '-v',
    `${input}:/input:ro`,
    '-v',
    `${patchDirectory}:/patch:ro`,
  ];
  for (const directory of writable) mounts.push('-v', `${root}/${directory}:/work/${directory}`);
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--init',
      '--name',
      name,
      ...labels,
      '--user',
      user,
      ...limits,
      '--network',
      network ? 'bridge' : 'none',
      ...environment,
      ...(offlineWeb ? ['-e', 'AUTOFIX_OFFLINE_SMOKE=1'] : []),
      ...(offlineStandalone ? ['-e', 'AUTOFIX_OFFLINE_STANDALONE=1'] : []),
      ...env,
      ...(workdir ? ['-w', workdir] : []),
      ...mounts,
      'koin-error-verifier',
      ...command,
    ],
    { encoding: 'utf8', timeout, maxBuffer: 8_000_000 },
  );
  if (result.error) {
    const cleanup = spawnSync('docker', ['rm', '--force', name], {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 100000,
    });
    if (cleanup.error) throw new Error(`Unable to clean up verifier container ${name}`);
  }
  return result;
}
function requireSuccess(result, label) {
  if (result.error || result.status !== 0) {
    process.stderr.write((result.stdout ?? '').slice(-12000) + (result.stderr ?? '').slice(-12000));
    throw new Error(`${label} failed; see this job's log (no PR published)`);
  }
}
/** Trusted CHOWN-only helper: hands exactly the mounted directories to the candidate UID. */
function chownToCandidate(directories, label) {
  const mounts = directories.flatMap((directory, index) => ['-v', `${resolve(root, directory)}:/scratch/${index}`]);
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      'none',
      '--read-only',
      '--cap-drop=ALL',
      '--cap-add=CHOWN',
      '--security-opt=no-new-privileges',
      '--pids-limit=32',
      '--memory=128m',
      '--cpus=.25',
      ...labels,
      '--user',
      '0:0',
      ...mounts,
      'koin-error-verifier',
      'chown',
      '--no-dereference',
      '-R',
      '1000:1000',
      ...directories.map((_, index) => `/scratch/${index}`),
    ],
    { encoding: 'utf8', timeout: 120_000, maxBuffer: 100_000 },
  );
  requireSuccess(result, label);
}
/**
 * Frozen, script-free acquisition. pnpm itself is trusted; the lockfile is not,
 * so lifecycle scripts never run here and the only network access is this step.
 */
function installDependencies() {
  const name = `koin-error-install-${randomUUID()}`;
  const mounts = [
    '-v',
    `${root}:/work${prMode ? ':ro' : ''}`,
    ...dependencyMounts.flatMap((directory) => ['-v', `${resolve(root, directory)}:/work/${directory}`]),
    ...(executorRun ? [] : ['-v', `${automation}:/automation:ro`]),
    '-v',
    `${input}:/input:ro`,
    '-v',
    `${patchDirectory}:/patch:ro`,
  ];
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--init',
      '--name',
      name,
      ...labels,
      '--user',
      installerUser,
      ...limits,
      '--network',
      'bridge',
      ...environment,
      ...LIFECYCLE_ENVIRONMENT,
      '-w',
      '/work',
      ...mounts,
      'koin-error-verifier',
      'pnpm',
      'install',
      '--frozen-lockfile',
      '--ignore-scripts',
      ...(prMode ? ['--ignore-pnpmfile'] : []),
    ],
    { encoding: 'utf8', timeout: 600_000, maxBuffer: 8_000_000 },
  );
  if (result.error) {
    const cleanup = spawnSync('docker', ['rm', '--force', name], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 100_000,
    });
    if (cleanup.error || cleanup.status !== 0) throw new Error(`Unable to remove trusted installer container ${name}`);
  }
  requireSuccess(result, 'Frozen dependency acquisition');
}
/**
 * Real `node_modules` directories the installer populated. Tracked paths and
 * symlinks are never handed to lifecycle scripts as writable mounts.
 */
async function dependencyDirectories() {
  const found = [];
  const pending = ['.'];
  while (pending.length) {
    const directory = pending.pop();
    for (const dirent of await readdir(resolve(root, directory), { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const relative = directory === '.' ? dirent.name : `${directory}/${dirent.name}`;
      if (!dependencyDirectory(relative)) {
        pending.push(relative);
        continue;
      }
      if ((await realpath(resolve(root, relative))) !== resolve(root, relative))
        throw new Error(`Dependency directory escaped the trusted snapshot: ${relative}`);
      if (snapshot?.some((entry) => entry.path === relative || entry.path.startsWith(`${relative}/`)))
        throw new Error(`Dependency directory is part of the pinned tree: ${relative}`);
      found.push(relative);
    }
  }
  return found;
}
await chmod(root, 0o755);
if (prMode) {
  const workspaces = ['.'];
  for (const scope of ['apps', 'packages']) {
    if (!(await directoryExists(scope))) continue;
    for (const entry of await readdir(resolve(root, scope), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const workspace = `${scope}/${entry.name}`;
      try {
        if ((await lstat(resolve(root, workspace, 'package.json'))).isFile()) workspaces.push(workspace);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
  for (const workspace of workspaces) {
    const directory = workspace === '.' ? 'node_modules' : `${workspace}/node_modules`;
    if (snapshot.some((entry) => entry.path === directory || entry.path.startsWith(`${directory}/`)))
      throw new Error(`Dependency directory is part of the pinned tree: ${directory}`);
    await mkdir(resolve(root, directory));
    dependencyMounts.push(directory);
  }
  if (process.getuid() === 0) chownToCandidate(dependencyMounts, 'Installer dependency directory ownership');
}
installDependencies();
if (!offlineSmoke) {
  await chmod(input, 0o755);
  await chmod(patchDirectory, 0o755);
  await chmod(`${input}/context.json`, 0o644);
  await chmod(`${patchDirectory}/patch.json`, 0o644);
}
// Approved lifecycle scripts come from the (untrusted) snapshot, so they run
// offline as the candidate UID with every source, config and test path
// read-only; only the dependency directories themselves are writable.
const dependencies = await dependencyDirectories();
dependencyMounts = dependencies;
if (dependencies.length && process.getuid() === 0) chownToCandidate(dependencies, 'Dependency directory ownership');
requireSuccess(
  docker(['pnpm', 'rebuild', '--pending'], { writable: dependencies, timeout: 180_000, env: LIFECYCLE_ENVIRONMENT }),
  'Approved offline dependency lifecycle builds',
);
// `pr-head-pinned` also means the tree the checks see is still the pinned one
// after acquisition and lifecycle builds: no pinned byte changed, nothing was
// added outside dependency directories.
if (prMode) await assertSnapshotMatchesTree(snapshot, root, dependencyDirectory);
const dependencyScratch = scratch.filter(insideDependency);
if (dependencyScratch.length) {
  requireSuccess(
    docker(['node', '/automation/patch.mjs', 'prepare-scratch', '/work', ...dependencyScratch], {
      writable: dependencies,
    }),
    'Candidate-owned dependency scratch preparation',
  );
}
for (const directory of scratch) {
  if (insideDependency(directory)) continue;
  const parts = directory.split('/');
  let relative = '';
  for (const part of parts) {
    relative = relative ? `${relative}/${part}` : part;
    try {
      const stat = await lstat(`${root}/${relative}`);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe scratch path: ${relative}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  await mkdir(`${root}/${directory}`, { recursive: true });
  if ((await realpath(`${root}/${directory}`)) !== resolve(root, directory))
    throw new Error(`Scratch path escaped the trusted snapshot: ${directory}`);
}
if (process.getuid() === 0)
  chownToCandidate(
    scratch.filter((directory) => !insideDependency(directory)),
    'Scoped scratch ownership',
  );
const identity = docker(['id', '-u']);
requireSuccess(identity, 'Non-root candidate identity');
if (identity.stdout.trim() !== user.split(':')[0] || identity.stdout.trim() === '0')
  throw new Error('Candidate checks must run under an observed unprivileged UID');
async function readablePatch(files) {
  for (const file of files) {
    if (file.content === null) continue;
    let directory = dirname(file.path);
    while (directory !== '.') {
      const path = `${root}/${directory}`;
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe patch directory: ${directory}`);
      await chmod(path, 0o755);
      directory = dirname(directory);
    }
    await chmod(`${root}/${file.path}`, 0o644);
  }
}
if (prMode) {
  // Corrections are applied on top of the pinned head after the trusted install;
  // every `before` hash must match the head bytes. An empty manifest is a plain
  // head verification.
  await applyManifest(manifest, root, false, true, policy);
  await readablePatch(manifest.files);
} else if (!offlineSmoke) {
  await applyManifest({ version: 1, files: tests }, root);
  await readablePatch(tests);
  const before = docker(['node', '--test', ...tests.map((file) => file.path)]);
  if (before.error || before.status !== 1 || !`${before.stdout}${before.stderr}`.includes('ERR_ASSERTION'))
    throw new Error('Regression must fail with an assertion against the untouched base, not a loader/setup failure');
  await applyManifest({ version: 1, files: manifest.files.filter((file) => isSourcePath(file.path)) }, root);
  await readablePatch(manifest.files.filter((file) => isSourcePath(file.path)));
}
const testCommand = ['node', '--test', ...tests.map((file) => file.path)];
if (profiles.has('web'))
  requireSuccess(
    docker(['node', '/automation/local-api.mjs', '--prepare-web'], { writable: runtimeScratch }),
    'Offline auxiliary API preparation',
  );

/** Workspace package names come from the snapshot but are only ever pnpm filter arguments. */
async function packageName(directory) {
  const name = JSON.parse(await readFile(`${root}/${directory}/package.json`, 'utf8')).name;
  if (!/^@koin\/[a-z0-9-]+$/.test(name)) throw new Error(`Unexpected workspace package name in ${directory}`);
  return name;
}
const packageFilters = [];
if (prMode) {
  const names = new Set();
  if (profiles.has('web') || profiles.has('api')) names.add('@koin/api');
  if (profiles.has('web')) names.add('@koin/web');
  if (profiles.has('b-bot')) {
    names.add('@koin/b-bot');
    if (crawlerPresent) names.add(await packageName('apps/b-bot-crawler'));
  }
  for (const directory of related)
    if (
      !['apps/web', 'apps/api', 'apps/b-bot', 'apps/b-bot-crawler'].includes(directory) &&
      (await directoryExists(directory))
    )
      names.add(await packageName(directory));
  packageFilters.push(...[...names].flatMap((name) => ['--filter', `${name}...`]));
} else packageFilters.push('--filter', '@koin/api...', ...(context.app === 'web' ? ['--filter', '@koin/web...'] : []));
const workspaceCommand = (script) =>
  script === 'typecheck'
    ? [
        'pnpm',
        '-r',
        '--workspace-concurrency=1',
        ...packageFilters,
        'exec',
        'node',
        '/automation/workspace-typecheck.mjs',
      ]
    : ['pnpm', '-r', '--workspace-concurrency=1', ...packageFilters, '--if-present', script];
const lintDirectories = prMode
  ? ['apps/api', 'packages/telemetry', 'scripts/autofix', ...(profiles.has('web') ? ['apps/web'] : []), ...related]
  : ['apps/api', 'packages/telemetry', 'scripts/autofix', ...(context.app === 'web' ? ['apps/web'] : [])];
const existingLintDirectories = [];
for (const directory of new Set(lintDirectories))
  if (await directoryExists(directory)) existingLintDirectories.push(directory);
const smokeProfiles = prMode ? [...profiles] : [];
const checks = offlineSmoke
  ? [
      ['Production build', workspaceCommand('build')],
      ['Runtime route smoke', ['node', '/automation/smoke.mjs']],
    ]
  : prMode
    ? [
        ['Typecheck', workspaceCommand('typecheck')],
        ['Native fixture tests', workspaceCommand('test')],
        ['Autofix security tests', ['node', '--test', '/automation/security.test.mjs']],
        ['Lint', ['pnpm', 'exec', 'oxlint', ...existingLintDirectories, '--deny-warnings']],
        ...(profiles.has('web') ? [['Web ESLint/Stylelint', ['pnpm', '--filter', '@koin/web', 'lint']]] : []),
        ['Production build', workspaceCommand('build')],
        ...(profiles.has('b-bot')
          ? [
              [
                'B-BOT deploy dry run',
                ['pnpm', '--filter', '@koin/b-bot', 'exec', 'wrangler', 'deploy', '--dry-run', '--outdir', 'dist'],
              ],
            ]
          : []),
        ['Runtime route smoke', null],
      ]
    : [
        ['Regression tests', testCommand],
        ['Native fixture tests', workspaceCommand('test')],
        ['Autofix security tests', ['node', '--test', '/automation/security.test.mjs']],
        ['Typecheck', workspaceCommand('typecheck')],
        ['Lint', ['pnpm', 'exec', 'oxlint', ...existingLintDirectories, '--deny-warnings']],
        ...(context.app === 'web' ? [['Web ESLint/Stylelint', ['pnpm', '--filter', '@koin/web', 'lint']]] : []),
        ['Production build', workspaceCommand('build')],
        [
          'Runtime route smoke',
          ['node', context.app === 'web' ? '/automation/smoke.mjs' : '/automation/api-smoke.mjs'],
        ],
      ];
const WEB_PROOF = 'Real local API/D1 smoke passed: SSR /, browser /, gateway /api/shops/categories';
const MOBILE_PROOF = 'Mobile local API/D1 smoke passed: / at 390px, gateway /api/shops/categories';
const API_PROOF = 'Real local API/D1 smoke passed: GET /shops/categories';
const BBOT_PROOF = 'Real local B-BOT Worker smoke passed: GET /health ok, unknown route 404';
const CRAWLER_PROOF =
  'Real local B-BOT crawler daemon smoke passed: GET /health ok, unauthenticated 401, idempotent replay/conflict, Notion job failed closed without credentials';
/** Runs one trusted smoke script with a fixed context and requires its explicit proof line. */
async function smoke(label, script, smokeContext, proofs, options) {
  await writeFile(`${input}/context.json`, JSON.stringify(smokeContext));
  await chmod(`${input}/context.json`, 0o644);
  let result;
  try {
    result = docker(['node', `/automation/${script}`], {
      writable: runtimeScratch,
      offlineStandalone: true,
      ...options,
    });
  } finally {
    await writeFile(`${input}/context.json`, JSON.stringify(context));
    await chmod(`${input}/context.json`, 0o644);
  }
  requireSuccess(result, label);
  for (const proof of proofs) {
    if (!result.stdout?.includes(proof)) throw new Error(`${label} proof is unavailable: ${proof}`);
    process.stdout.write(`${proof}\n`);
  }
}
for (const [label, command] of checks) {
  if (offlineSmoke && label === 'Runtime route smoke') {
    await smoke(
      'Runtime API smoke',
      'api-smoke.mjs',
      { app: 'api', route: '/shops/categories', requestMethod: 'GET' },
      [API_PROOF],
    );
  }
  if (prMode && label === 'Runtime route smoke') {
    // Allowlisted per-profile runtime proofs on the pinned head; nothing here is
    // read from the PR, and skipped live providers are never counted as exercised.
    if (smokeProfiles.includes('api') || smokeProfiles.includes('web'))
      await smoke(
        'Runtime API smoke',
        'api-smoke.mjs',
        { app: 'api', route: '/shops/categories', requestMethod: 'GET' },
        [API_PROOF],
      );
    if (smokeProfiles.includes('web'))
      await smoke(
        'Runtime web smoke',
        'smoke.mjs',
        { app: 'web', route: '/', requestMethod: 'GET' },
        [WEB_PROOF, MOBILE_PROOF],
        {
          offlineWeb: true,
        },
      );
    if (smokeProfiles.includes('b-bot')) {
      await smoke('Runtime B-BOT smoke', 'bbot-smoke.mjs', context, [BBOT_PROOF]);
      if (crawlerPresent)
        await smoke('Runtime B-BOT crawler smoke', 'crawler-smoke.mjs', context, [CRAWLER_PROOF], {
          workdir: '/work/apps/b-bot-crawler',
        });
    }
    continue;
  }
  const result = docker(command, {
    writable:
      label === 'Production build' || label === 'B-BOT deploy dry run'
        ? scratch
        : label === 'Runtime route smoke'
          ? runtimeScratch
          : label === 'Typecheck' || label === 'Native fixture tests'
            ? [...bbotBuildScratch, ...bbotRuntimeScratch]
            : [],
    offlineWeb: profiles.has('web') && ['Production build', 'Runtime route smoke'].includes(label),
    offlineStandalone: offlineSmoke && label === 'Runtime route smoke',
  });
  requireSuccess(result, label);
  if (offlineSmoke && label === 'Runtime route smoke') {
    if (!result.stdout?.includes(WEB_PROOF)) throw new Error('Runtime SSR/browser/gateway proof is unavailable');
    process.stdout.write(`${WEB_PROOF}\n`);
    if (!result.stdout?.includes(MOBILE_PROOF)) throw new Error('Runtime mobile homepage proof is unavailable');
    process.stdout.write(`${MOBILE_PROOF}\n`);
  }
}
if (offlineSmoke) {
  cleanupSnapshot();
  process.stdout.write(
    'Offline local API/D1 + SSR + Chromium smoke passed; isolated containers and snapshot removed\n',
  );
  process.exit(0);
}
for (const file of manifest.files) {
  if (file.content !== null && (await readFile(`${root}/${file.path}`, 'utf8')) !== file.content)
    throw new Error('Verification modified source/test content');
}
await mkdir('error-verified', { recursive: true });
const patch = await readFile('error-patch/patch.json');
await writeFile('error-verified/patch.json', patch);
await writeFile(
  'error-verified/verification.json',
  JSON.stringify(
    prMode
      ? {
          headSha: context.headSha,
          baseSha: context.baseSha,
          sha256: createHash('sha256').update(patch).digest('hex'),
          checks: PR_CHECKS,
          pullNumber: context.pullNumber,
          profiles: smokeProfiles,
          runId: process.env.GITHUB_RUN_ID,
        }
      : {
          baseSha: context.baseSha,
          sha256: createHash('sha256').update(patch).digest('hex'),
          checks: ERROR_CHECKS,
          app: context.app,
          route: context.route,
          runId: process.env.GITHUB_RUN_ID,
        },
    null,
    2,
  ),
);
cleanupSnapshot();
