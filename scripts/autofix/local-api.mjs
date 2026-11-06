import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

export const API_ORIGIN = 'http://127.0.0.1:4174';
export const delay = (ms) => new Promise((done) => setTimeout(done, ms));

// A head may ship the legacy Worker API gated off by default
// (`"API_ENABLED": "false"` in wrangler.jsonc). Only the isolated local
// Miniflare copies opt in, so the existing business routes stay verifiable;
// configs without the gate are left untouched. Remote config never changes.
const apiEnabledDisabled = '"API_ENABLED": "false"';
const apiEnabledForced = '"API_ENABLED": "true"';

/** Whether the checked-out API config declares the disabled-by-default gate. */
export function declaresApiGate(configuration) {
  const count = configuration.split(apiEnabledDisabled).length - 1;
  if (configuration.includes(apiEnabledForced) || ![0, 2].includes(count))
    throw new Error('API_ENABLED gate configuration changed; offline verification needs review');
  return count === 2;
}
const instrumentedApi = `
import worker from '../../src/index.ts';
export * from '../../src/index.ts';
export default {
  ...worker,
  async fetch(request, env, ctx) {
    let status = 500;
    try {
      const response = await worker.fetch(request, env, ctx);
      status = response.status;
      return response;
    } finally {
      console.warn('AUTOFIX_API_REQUEST', request.method, new URL(request.url).pathname, status);
    }
  },
};
`;

// A build-only auxiliary Worker lives under the API scratch mount. The Vite
// preview then loads both Workers in one Miniflare instance; Wrangler's
// separate dev registry is not consulted by that preview runtime.
export async function prepareWebApi() {
  const directory = resolve('apps/api/.wrangler/autofix-api');
  await mkdir(directory, { recursive: true });
  const original = await readFile(resolve('apps/api/wrangler.jsonc'), 'utf8');
  const main = '"main": "src/index.ts"';
  const migrations = '"migrations_dir": "drizzle"';
  // 최상위 vars와 previews.vars 양쪽이 "false"인 배포 설정만 허용하고, 보조 Worker 사본에서만 "true"로 바꾼다.
  if (
    original.split(main).length !== 2 ||
    original.split(migrations).length !== 3 ||
    original.split(apiEnabledDisabled).length !== 3 ||
    original.includes(apiEnabledForced)
  )
    throw new Error('API configuration changed; offline auxiliary Worker needs review');
  const gated = declaresApiGate(original);
  await writeFile(join(directory, 'index.mjs'), instrumentedApi);
  await writeFile(
    join(directory, 'wrangler.jsonc'),
    original
      .replace(main, '"main": "index.mjs"')
      .replaceAll(migrations, '"migrations_dir": "../../drizzle"')
      .replaceAll(apiEnabledDisabled, gated ? apiEnabledForced : apiEnabledDisabled),
  );
}

export async function migrateWebApi() {
  // Wrangler appends /v3 to --persist-to, whereas Cloudflare Vite's
  // resourcePersistencePath already points at <web root>/.wrangler/state/v3.
  const persistence = resolve('apps/web/.wrangler/state');
  const migration = startProcess('pnpm', ['--filter', '@koin/api', 'db:migrate:local', '--persist-to', persistence], {
    ...process.env,
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
    WRANGLER_SEND_METRICS: 'false',
  });
  let timer;
  try {
    const result = await Promise.race([
      migration.finished,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Local database migration timed out')), 180000);
      }),
    ]);
    if (result.error || result.code !== 0) throw new Error('Local-only API database migration failed');
  } catch (error) {
    process.stderr.write(migration.log.slice(-16000));
    throw error;
  } finally {
    clearTimeout(timer);
    await stopProcess(migration.child);
  }
}

export async function stopProcess(child) {
  if (!child?.pid) return;
  const signal = (name) => {
    try {
      process.kill(-child.pid, name);
    } catch {}
  };
  signal('SIGTERM');
  await delay(1000);
  signal('SIGKILL');
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((done) => {
      const timer = setTimeout(done, 5000);
      child.once('close', () => {
        clearTimeout(timer);
        done();
      });
    });
  }
}

export function startProcess(command, args, env = process.env) {
  const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = '';
  let failure;
  const finished = new Promise((done) => {
    child.once('error', (error) => done({ error }));
    child.once('close', (code) => done({ code }));
  });
  child.on('error', (error) => {
    failure = error;
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      log = (log + chunk.toString()).slice(-1000000);
    });
  return {
    child,
    finished,
    get log() {
      return stripVTControlCharacters(log);
    },
    assertRunning() {
      if (failure || child.exitCode !== null || child.signalCode !== null)
        throw new Error(`Local process exited: ${command}; ${failure?.message ?? ''}\n${log.slice(-8000)}`);
    },
  };
}

export async function readJsonResponse(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json'))
    throw new Error(
      `Local API ${new URL(url).pathname} returned ${response.status}, not successful JSON; authentication, providers or missing fixtures require manual reproduction`,
    );
  return response.json();
}

/**
 * Starts the isolated local API Worker. With `gate: 'enabled'` (default) the
 * local process is always opted in via `--var API_ENABLED:true` (a no-op for a
 * config without the gate, the only way a gated head serves business routes)
 * and readiness means the real `/health` ok body; with `gate: 'disabled'` a
 * gated config is left at its default so readiness means the gate's own 503
 * `API_DISABLED` answer, proving the disabled flag path without business IO.
 */
export async function startLocalApi({ gate = 'enabled' } = {}) {
  const gated = declaresApiGate(await readFile(resolve('apps/api/wrangler.jsonc'), 'utf8'));
  if (gate === 'disabled' && !gated) throw new Error('API config declares no API_ENABLED gate to exercise');
  const registry = await mkdtemp(join(tmpdir(), 'autofix-worker-registry-'));
  const env = {
    ...process.env,
    WRANGLER_REGISTRY_PATH: registry,
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
    WRANGLER_SEND_METRICS: 'false',
  };
  let runtime;
  let entryDirectory;
  try {
    await mkdir(resolve('apps/api/.wrangler'), { recursive: true });
    entryDirectory = await mkdtemp(resolve('apps/api/.wrangler/autofix-runtime-'));
    const persistence = join(entryDirectory, 'state');
    const migration = startProcess(
      'pnpm',
      ['--filter', '@koin/api', 'db:migrate:local', '--persist-to', persistence],
      env,
    );
    let migrationTimer;
    try {
      const result = await Promise.race([
        migration.finished,
        new Promise((_, reject) => {
          migrationTimer = setTimeout(() => reject(new Error('Local database migration timed out')), 180000);
        }),
      ]);
      if (result.error || result.code !== 0) throw new Error('Local-only API database migration failed');
    } catch (error) {
      process.stderr.write(migration.log.slice(-16000));
      throw error;
    } finally {
      clearTimeout(migrationTimer);
      await stopProcess(migration.child);
    }
    const entry = join(entryDirectory, 'index.mjs');
    await writeFile(entry, instrumentedApi);
    // `--var`는 이 로컬 wrangler dev 프로세스의 env에만 적용된다(DO·Queue 핸들러 포함).
    runtime = startProcess(
      'pnpm',
      [
        '--filter',
        '@koin/api',
        'dev',
        entry,
        '--local',
        '--name',
        'koin-api',
        '--ip',
        '127.0.0.1',
        '--port',
        '4174',
        '--inspector-port',
        '9230',
        '--persist-to',
        persistence,
        ...(gate === 'enabled' ? ['--var', 'API_ENABLED:true'] : []),
      ],
      env,
    );
    for (let attempt = 0; attempt < 120; attempt += 1) {
      runtime.assertRunning();
      try {
        const response = await fetch(`${API_ORIGIN}/health`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
        const json = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
        const ready =
          gate === 'disabled'
            ? response.status === 503 && json?.code === 'API_DISABLED' && response.headers.get('retry-after')
            : response.ok && json?.status === 'ok' && json.service === 'koin-api';
        if (ready) {
          return {
            ...runtime,
            env,
            requestCount: (path) =>
              [
                ...runtime.log.matchAll(
                  /AUTOFIX_API_REQUEST (?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\/\S*) \d{3}\b/g,
                ),
              ].filter((match) => (path ? match[1] === path : match[1] !== '/health')).length,
            assertHealthy: () => {
              runtime.assertRunning();
              const httpErrors =
                gate === 'disabled'
                  ? /AUTOFIX_API_REQUEST \S+ \S+ (?!503\b)[45]\d{2}\b/i
                  : /AUTOFIX_API_REQUEST \S+ \S+ [45]\d{2}\b/i;
              if (/\[ERROR\]|uncaught|unhandled rejection/i.test(runtime.log) || httpErrors.test(runtime.log))
                throw new Error(`Local API emitted runtime or HTTP errors\n${runtime.log.slice(-8000)}`);
            },
            cleanup: async () => {
              await stopProcess(runtime.child);
              await rm(entryDirectory, { recursive: true, force: true });
              await rm(registry, { recursive: true, force: true });
            },
          };
        }
      } catch {}
      await delay(500);
    }
    throw new Error('Local API /health did not become ready');
  } catch (error) {
    await stopProcess(runtime?.child);
    if (entryDirectory) await rm(entryDirectory, { recursive: true, force: true });
    await rm(registry, { recursive: true, force: true });
    if (runtime) process.stderr.write(runtime.log.slice(-16000));
    throw error;
  }
}

if (process.argv[1]?.endsWith('/local-api.mjs') && process.argv[2] === '--prepare-web') {
  await prepareWebApi();
}
