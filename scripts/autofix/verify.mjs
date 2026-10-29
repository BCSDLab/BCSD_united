import { execFileSync, spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { applyManifest, validateManifest } from './patch.mjs';
import { isSourcePath, jsonFile } from './common.mjs';

const offlineSmoke = process.argv[2] === '--offline-smoke';
if (process.argv.length > (offlineSmoke ? 3 : 2)) throw new Error('Unknown verifier argument');
const manifest = offlineSmoke ? { version: 1, files: [] } : validateManifest(await jsonFile('error-patch/patch.json'));
if (!offlineSmoke) {
  if (!manifest.files.length) throw new Error('NO_CHANGES: agent produced no fix; no PR will be created');
  if (!manifest.files.some((file) => isSourcePath(file.path))) throw new Error('No source fix was produced');
}
const tests = manifest.files.filter((file) => file.path.startsWith('tests/autofix/'));
if (!offlineSmoke && (!tests.length || tests.some((file) => file.before !== null || file.content === null)))
  throw new Error('A new executable regression test is required; existing tests cannot be weakened');
const context = offlineSmoke
  ? { app: 'web', route: '/', baseSha: 'offline-local' }
  : await jsonFile('error-input/context.json');
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
const root = await mkdtemp(resolve(process.env.RUNNER_TEMP ?? tmpdir(), 'error-verification-'));
process.once('exit', () => rmSync(root, { recursive: true, force: true }));
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
  const archive = execFileSync('git', ['archive', context.baseSha], { maxBuffer: 100_000_000 });
  await writeFile(`${root}/base.tar`, archive);
  execFileSync('tar', ['-xf', `${root}/base.tar`, '-C', root]);
}
await mkdir(`${root}/tests/autofix`, { recursive: true });
const automation = resolve('scripts/autofix');
const input = offlineSmoke ? `${root}/offline-input` : resolve('error-input');
const patchDirectory = offlineSmoke ? `${root}/offline-patch` : resolve('error-patch');
if (offlineSmoke) {
  await mkdir(input);
  await mkdir(patchDirectory);
  await writeFile(`${input}/context.json`, JSON.stringify(context));
  await writeFile(`${patchDirectory}/patch.json`, JSON.stringify(manifest));
}
const runtimeScratch = [
  'apps/web/.wrangler',
  'apps/web/node_modules/.vite-temp',
  'apps/web/node_modules/.vite',
  'apps/api/.wrangler',
];
const scratch = [...runtimeScratch, 'apps/web/dist', 'apps/web/.tanstack', 'apps/api/dist'];
const limits = ['--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=512', '--memory=6g', '--cpus=2'];
const user = `${process.getuid()}:${process.getgid()}`;
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
  `NEXT_PUBLIC_SENTRY_RELEASE=${context.baseSha}`,
  '-e',
  'SENTRY_RELEASE=' + context.baseSha,
  '-e',
  'WRANGLER_SEND_METRICS=false',
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
  } = {},
) {
  const name = `koin-error-verifier-${randomUUID()}`;
  const mounts = [
    '-v',
    `${root}:/work${sourceReadonly ? ':ro' : ''}`,
    '-v',
    `${automation}:/automation:ro`,
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
      '--user',
      user,
      ...limits,
      '--network',
      network ? 'bridge' : 'none',
      ...environment,
      ...(offlineWeb ? ['-e', 'AUTOFIX_OFFLINE_SMOKE=1'] : []),
      ...(offlineStandalone ? ['-e', 'AUTOFIX_OFFLINE_STANDALONE=1'] : []),
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
requireSuccess(
  docker(['pnpm', 'install', '--frozen-lockfile'], { network: true, sourceReadonly: false }),
  'Frozen dependency installation',
);
for (const directory of scratch) await mkdir(`${root}/${directory}`, { recursive: true });
if (!offlineSmoke) {
  await applyManifest({ version: 1, files: tests }, root);
  const before = docker(['node', '--test', ...tests.map((file) => file.path)]);
  if (before.error || before.status !== 1 || !`${before.stdout}${before.stderr}`.includes('ERR_ASSERTION'))
    throw new Error('Regression must fail with an assertion against the untouched base, not a loader/setup failure');
  await applyManifest({ version: 1, files: manifest.files.filter((file) => isSourcePath(file.path)) }, root);
}
const testCommand = ['node', '--test', ...tests.map((file) => file.path)];
if (context.app === 'web')
  requireSuccess(
    docker(['node', '/automation/local-api.mjs', '--prepare-web'], { writable: runtimeScratch }),
    'Offline auxiliary API preparation',
  );
const workspaceCommand = (script) => [
  'pnpm',
  '-r',
  '--filter',
  '@koin/api...',
  ...(context.app === 'web' ? ['--filter', '@koin/web...'] : []),
  '--if-present',
  script,
];
const checks = offlineSmoke
  ? [
      ['Production build', workspaceCommand('build')],
      ['Runtime route smoke', ['node', '/automation/smoke.mjs']],
    ]
  : [
      ['Regression tests', testCommand],
      ['Native fixture tests', workspaceCommand('test')],
      ['Autofix security tests', ['node', '--test', '/automation/security.test.mjs']],
      ['Typecheck', workspaceCommand('typecheck')],
      [
        'Lint',
        [
          'pnpm',
          'exec',
          'oxlint',
          'apps/api',
          'packages/telemetry',
          'scripts/autofix',
          ...(context.app === 'web' ? ['apps/web'] : []),
          '--deny-warnings',
        ],
      ],
      ...(context.app === 'web' ? [['Web ESLint/Stylelint', ['pnpm', '--filter', '@koin/web', 'lint']]] : []),
      ['Production build', workspaceCommand('build')],
      ['Runtime route smoke', ['node', context.app === 'web' ? '/automation/smoke.mjs' : '/automation/api-smoke.mjs']],
    ];
for (const [label, command] of checks) {
  if (offlineSmoke && label === 'Runtime route smoke') {
    await writeFile(
      `${input}/context.json`,
      JSON.stringify({ app: 'api', route: '/shops/categories', requestMethod: 'GET' }),
    );
    const apiResult = docker(['node', '/automation/api-smoke.mjs'], {
      writable: runtimeScratch,
      offlineStandalone: true,
    });
    requireSuccess(apiResult, 'Runtime API smoke');
    const apiProof = 'Real local API/D1 smoke passed: GET /shops/categories';
    if (!apiResult.stdout?.includes(apiProof)) throw new Error('Runtime API proof is unavailable');
    process.stdout.write(`${apiProof}\n`);
    await writeFile(`${input}/context.json`, JSON.stringify(context));
  }
  const result = docker(command, {
    writable: label === 'Production build' ? scratch : label === 'Runtime route smoke' ? runtimeScratch : [],
    offlineWeb: context.app === 'web' && ['Production build', 'Runtime route smoke'].includes(label),
    offlineStandalone: offlineSmoke && label === 'Runtime route smoke',
  });
  requireSuccess(result, label);
  if (offlineSmoke && label === 'Runtime route smoke') {
    const webProof = 'Real local API/D1 smoke passed: SSR /, browser /, gateway /api/shops/categories';
    if (!result.stdout?.includes(webProof)) throw new Error('Runtime SSR/browser/gateway proof is unavailable');
    process.stdout.write(`${webProof}\n`);
    const mobileProof = 'Mobile local API/D1 smoke passed: / at 390px, gateway /api/shops/categories';
    if (!result.stdout?.includes(mobileProof)) throw new Error('Runtime mobile homepage proof is unavailable');
    process.stdout.write(`${mobileProof}\n`);
  }
}
if (offlineSmoke) {
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
    {
      baseSha: context.baseSha,
      sha256: createHash('sha256').update(patch).digest('hex'),
      checks: [
        'regression-fails-on-base',
        'regression-passes-on-fix',
        'native-fixture-tests',
        'typecheck',
        'autofix-security-tests',
        'lint',
        'build',
        'runtime-route-smoke',
      ],
      app: context.app,
      route: context.route,
      runId: process.env.GITHUB_RUN_ID,
    },
    null,
    2,
  ),
);
