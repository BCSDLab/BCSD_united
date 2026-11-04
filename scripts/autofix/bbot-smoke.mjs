import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { delay, startProcess, stopProcess } from './local-api.mjs';

// Safe B-BOT health smoke: the built Nitro Worker runs in a local Miniflare with
// local KV/queues only. GET /health calls no database, AI, Slack or Google API,
// so a 200 proves the HTTP runtime boots, nothing more. No paid or remote
// bindings are reachable inside the network-less container.
const ORIGIN = 'http://127.0.0.1:8793';

/** Minimal JSONC reader for wrangler.jsonc: strips comments outside strings and trailing commas. */
export function parseJsonc(text) {
  let output = '';
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      output += text.slice(i, j + 1);
      i = j + 1;
    } else if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) throw new Error('Unterminated comment in JSONC');
      i = end + 2;
    } else {
      output += char;
      i += 1;
    }
  }
  return JSON.parse(output.replace(/,(\s*[}\]])/g, '$1'));
}

/**
 * Smoke-only Worker configuration: same code, assets, flags and local KV/queue
 * bindings as the deployable config, but no Workers AI binding (always a paid
 * remote call; /health never touches it), no build hook (the trusted build step
 * already produced .output) and no account identity.
 */
export function smokeConfiguration(deployable) {
  if (
    deployable.name !== 'b-bot-workers' ||
    deployable.main !== 'worker.ts' ||
    deployable.assets?.directory !== '.output/public' ||
    deployable.assets.binding !== 'ASSETS' ||
    !Array.isArray(deployable.compatibility_flags) ||
    typeof deployable.compatibility_date !== 'string' ||
    !Array.isArray(deployable.kv_namespaces) ||
    deployable.kv_namespaces.some((binding) => typeof binding.binding !== 'string' || binding.remote === true)
  )
    throw new Error('B-BOT Wrangler configuration changed; the offline health smoke needs review');
  const forbidden = Object.keys(deployable).filter(
    (key) =>
      ![
        '$schema',
        'name',
        'account_id',
        'main',
        'compatibility_date',
        'compatibility_flags',
        'workers_dev',
        'build',
        'assets',
        'kv_namespaces',
        'ai',
        'queues',
        'triggers',
        'observability',
        'vars',
        'hyperdrive',
      ].includes(key),
  );
  if (forbidden.length) throw new Error(`Unreviewed B-BOT Wrangler keys: ${forbidden.join(', ')}`);
  const queues = deployable.queues ?? {};
  for (const entry of [...(queues.producers ?? []), ...(queues.consumers ?? [])])
    if (entry.remote === true) throw new Error('Remote queue bindings are forbidden in offline verification');
  if (Array.isArray(deployable.hyperdrive) && deployable.hyperdrive.length)
    throw new Error('Hyperdrive bindings need a reviewed offline substitute');
  return {
    name: deployable.name,
    main: '../../worker.ts',
    compatibility_date: deployable.compatibility_date,
    compatibility_flags: deployable.compatibility_flags,
    assets: { directory: '../../.output/public', binding: 'ASSETS' },
    kv_namespaces: deployable.kv_namespaces.map((binding) => ({ binding: binding.binding, id: binding.id })),
    ...(deployable.queues ? { queues: deployable.queues } : {}),
    ...(deployable.vars ? { vars: deployable.vars } : {}),
    triggers: { crons: [] },
  };
}

if (process.argv[1]?.endsWith('/bbot-smoke.mjs')) {
  const root = resolve('apps/b-bot');
  const deployable = parseJsonc(await readFile(join(root, 'wrangler.jsonc'), 'utf8'));
  const configuration = smokeConfiguration(deployable);
  const directory = join(root, '.wrangler/autofix-smoke');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'wrangler.json'), JSON.stringify(configuration, null, 2));
  const registry = await mkdtemp(join(tmpdir(), 'autofix-bbot-registry-'));
  const persistence = join(directory, 'state');
  const runtime = startProcess(
    'pnpm',
    [
      '--filter',
      '@koin/b-bot',
      'exec',
      'wrangler',
      'dev',
      '--config',
      '.wrangler/autofix-smoke/wrangler.json',
      '--local',
      '--ip',
      '127.0.0.1',
      '--port',
      '8793',
      '--inspector-port',
      '9232',
      '--persist-to',
      persistence,
    ],
    {
      ...process.env,
      WRANGLER_REGISTRY_PATH: registry,
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
      WRANGLER_SEND_METRICS: 'false',
    },
  );
  try {
    let health;
    for (let attempt = 0; attempt < 180 && !health; attempt += 1) {
      runtime.assertRunning();
      try {
        const response = await fetch(`${ORIGIN}/health`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
        if (response.ok && response.headers.get('content-type')?.includes('application/json'))
          health = await response.json();
        else await response.body?.cancel();
      } catch {}
      if (!health) await delay(500);
    }
    if (!health) throw new Error('B-BOT local Worker /health did not become ready');
    if (health.ok !== true || health.service !== 'b-bot') throw new Error('B-BOT /health returned an unexpected body');
    const missing = await fetch(`${ORIGIN}/autofix-missing-route`, {
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    await missing.body?.cancel();
    if (missing.status !== 404) throw new Error(`B-BOT unknown route returned ${missing.status}, not 404`);
    runtime.assertRunning();
    if (/\[ERROR\]|uncaught|unhandled rejection/i.test(runtime.log))
      throw new Error(`B-BOT Worker emitted runtime errors\n${runtime.log.slice(-8000)}`);
    process.stdout.write('Real local B-BOT Worker smoke passed: GET /health ok, unknown route 404\n');
  } catch (error) {
    process.stderr.write(runtime.log.slice(-16000));
    throw error;
  } finally {
    await stopProcess(runtime.child);
    await rm(registry, { recursive: true, force: true });
  }
}
