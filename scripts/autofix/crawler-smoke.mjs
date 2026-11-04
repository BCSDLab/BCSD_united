import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { delay, startProcess, stopProcess } from './local-api.mjs';

// Safe B-BOT crawler daemon smoke (cwd apps/b-bot-crawler, network none). The
// real `src/main.ts` starts on loopback with a throwaway bearer token and a
// scratch SQLite store. Preflight only checks that database/Cloudflare settings
// exist, so placeholder localhost/offline strings satisfy it without reaching
// anything; NOTION_TOKEN is deliberately absent so an enqueued Notion job must
// fail closed inside the runner before any provider, database or AI call.
// This proves daemon health/auth/idempotency/fail-closed behaviour only, never
// an actual external index run.
const PORT = 8813;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const authToken = randomBytes(32).toString('hex');
const daemon = startProcess('pnpm', ['exec', 'tsx', '--tsconfig', 'tsconfig.json', 'src/main.ts'], {
  ...process.env,
  CRAWLER_AUTH_TOKEN: authToken,
  CRAWLER_STATE_PATH: resolve('data/autofix-smoke.sqlite'),
  CRAWLER_PORT: String(PORT),
  DB_HOST: '127.0.0.1',
  DB_PORT: '1',
  DB_USER: 'offline-placeholder',
  DB_PASSWORD: 'offline-placeholder',
  DB_NAME: 'offline_placeholder_test',
  CLOUDFLARE_ACCOUNT_ID: 'offline-placeholder',
  CLOUDFLARE_API_TOKEN: 'offline-placeholder',
  NOTION_TOKEN: '',
  GOOGLE_REFRESH_TOKEN: '',
});
const authorized = { Authorization: `Bearer ${authToken}` };
async function request(path, init = {}) {
  const response = await fetch(`${ORIGIN}${path}`, { signal: AbortSignal.timeout(5000), redirect: 'error', ...init });
  const body = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
  if (body === null) await response.body?.cancel();
  return { status: response.status, body };
}
try {
  let health;
  for (let attempt = 0; attempt < 120 && !health; attempt += 1) {
    daemon.assertRunning();
    try {
      const probe = await request('/health', { headers: authorized });
      if (probe.status === 200) health = probe.body;
    } catch {}
    if (!health) await delay(500);
  }
  if (!health) throw new Error('Crawler daemon /health did not become ready');
  if (health.ok !== true || health.service !== 'b-bot-crawler')
    throw new Error(`Crawler /health returned an unexpected body: ${JSON.stringify(health)}`);
  if ((await request('/health')).status !== 401) throw new Error('Crawler /health without a token was not 401');
  if ((await request('/health', { headers: { Authorization: `Bearer ${'0'.repeat(64)}` } })).status !== 401)
    throw new Error('Crawler /health with a wrong token was not 401');
  if ((await request(`/jobs/${randomUUID()}`, { headers: authorized })).status !== 404)
    throw new Error('Crawler unknown job was not 404');
  const key = `autofix-smoke-${randomUUID()}`;
  const post = (payload) =>
    request('/jobs', {
      method: 'POST',
      headers: { ...authorized, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  const created = await post({ connector: 'notion', idempotencyKey: key });
  if (created.status !== 202 || typeof created.body?.id !== 'string' || created.body.connector !== 'notion')
    throw new Error(`Crawler job enqueue returned ${created.status}: ${JSON.stringify(created.body)}`);
  const replay = await post({ connector: 'notion', idempotencyKey: key });
  if (replay.status !== 200 || replay.body?.id !== created.body.id)
    throw new Error(`Crawler idempotent replay returned ${replay.status}: ${JSON.stringify(replay.body)}`);
  const conflict = await post({ connector: 'notion', idempotencyKey: key, full: true });
  if (conflict.status !== 409 || conflict.body?.error !== 'IDEMPOTENCY_CONFLICT')
    throw new Error(`Crawler idempotency conflict returned ${conflict.status}: ${JSON.stringify(conflict.body)}`);
  if ((await post({ connector: 'github', idempotencyKey: 'bad key!' })).status !== 400)
    throw new Error('Crawler accepted an invalid job request');
  let job;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    daemon.assertRunning();
    job = (await request(`/jobs/${created.body.id}`, { headers: authorized })).body;
    if (job?.status === 'failed' || job?.status === 'succeeded') break;
    await delay(500);
  }
  if (job?.status !== 'failed')
    throw new Error(`Notion job without NOTION_TOKEN did not fail closed: ${JSON.stringify(job)}`);
  const record = JSON.stringify(job);
  if (record.includes('offline-placeholder') || record.includes(authToken))
    throw new Error('Crawler job record leaked configuration values');
  daemon.assertRunning();
  if (/uncaught|unhandled rejection|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(daemon.log))
    throw new Error(`Crawler daemon attempted external IO or crashed\n${daemon.log.slice(-8000)}`);
  process.stdout.write(
    'Real local B-BOT crawler daemon smoke passed: GET /health ok, unauthenticated 401, idempotent replay/conflict, Notion job failed closed without credentials\n',
  );
} catch (error) {
  process.stderr.write(daemon.log.slice(-16000));
  throw error;
} finally {
  await stopProcess(daemon.child);
}
