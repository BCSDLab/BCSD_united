import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

export const API_ORIGIN = 'http://127.0.0.1:4174';
export const delay = (ms) => new Promise((done) => setTimeout(done, ms));

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

export async function startLocalApi() {
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
    await writeFile(
      entry,
      `
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
`,
    );
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
      ],
      env,
    );
    for (let attempt = 0; attempt < 120; attempt += 1) {
      runtime.assertRunning();
      try {
        const response = await fetch(`${API_ORIGIN}/health`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
        const health = response.ok ? await response.json() : null;
        if (health?.status === 'ok' && health.service === 'koin-api') {
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
              if (/\[ERROR\]|uncaught|unhandled rejection|AUTOFIX_API_REQUEST \S+ \S+ [45]\d{2}\b/i.test(runtime.log))
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
