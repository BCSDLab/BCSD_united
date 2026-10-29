import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { applyManifest, validateManifest } from './patch.mjs';
import { isSourcePath, jsonFile } from './common.mjs';

const manifest = validateManifest(await jsonFile('error-patch/patch.json'));
if (!manifest.files.length) throw new Error('NO_CHANGES: agent produced no fix; no PR will be created');
if (!manifest.files.some((file) => isSourcePath(file.path))) throw new Error('No source fix was produced');
const tests = manifest.files.filter((file) => file.path.startsWith('tests/autofix/'));
if (!tests.length || tests.some((file) => file.before !== null || file.content === null))
  throw new Error('A new executable regression test is required; existing tests cannot be weakened');
const context = await jsonFile('error-input/context.json');
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
const archive = execFileSync('git', ['archive', context.baseSha], { maxBuffer: 100_000_000 });
await writeFile(`${root}/base.tar`, archive);
execFileSync('tar', ['-xf', `${root}/base.tar`, '-C', root]);
await mkdir(`${root}/tests/autofix`, { recursive: true });
const automation = resolve('scripts/autofix');
const input = resolve('error-input');
const patchDirectory = resolve('error-patch');
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
function docker(command, { network = false, sourceReadonly = true, writable = [], timeout = 600_000 } = {}) {
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
await applyManifest({ version: 1, files: tests }, root);
const testCommand = ['node', '--test', ...tests.map((file) => file.path)];
const before = docker(testCommand);
if (before.error || before.status !== 1 || !`${before.stdout}${before.stderr}`.includes('ERR_ASSERTION'))
  throw new Error('Regression must fail with an assertion against the untouched base, not a loader/setup failure');
await applyManifest({ version: 1, files: manifest.files.filter((file) => isSourcePath(file.path)) }, root);
const workspaceCommand = (script) => [
  'pnpm',
  '-r',
  '--filter',
  '@koin/api...',
  ...(context.app === 'web' ? ['--filter', '@koin/web...'] : []),
  '--if-present',
  script,
];
for (const [label, command] of [
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
])
  requireSuccess(
    docker(command, {
      writable: label === 'Production build' ? scratch : label === 'Runtime route smoke' ? runtimeScratch : [],
    }),
    label,
  );
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
