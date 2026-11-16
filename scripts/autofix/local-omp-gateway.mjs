#!/usr/bin/env node
/**
 * Rocky의 고정 모델 요청을 로컬 omp 자격 증명으로 전달하는 루프백 브리지.
 * `POST /v1/messages`는 모델 토큰으로, 선택적 `GET /healthz`는 별도 모니터 토큰으로 인증한다.
 * 상태 조회는 로컬 커널과 systemd 정보만 읽으며 omp, 브로커, 모델을 호출하지 않는다.
 *
 *   OMP_GATEWAY_TOKEN_FILE          현재 사용자 소유의 0600 모델 토큰 파일
 *   OMP_GATEWAY_MONITOR_TOKEN_FILE  선택 사항: 소유자 전용 0700 디렉터리 내의 별도 0600 토큰 파일
 *   OMP_GATEWAY_PORT                루프백 포트(기본값 43129)
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants, lstat, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export const MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5'];
export const PROVIDER = 'anthropic';
export const DEFAULT_PORT = 43129;
export const MAX_INPUT_BYTES = 1024 * 1024;
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 180_000;
const PATH = '/v1/messages';
const HEALTH_PATH = '/healthz';
const HEALTH_TIMEOUT_MS = 2_000;
const CPU_SAMPLE_MS = 200;
const SYSTEMCTL_OUTPUT_BYTES = 4096;
const UNITS = ['koin-autofix-executor.service', 'homebutler-auth-broker.service'];
const TOKEN = /^[A-Za-z0-9_-]{32,512}$/;
const ERROR_TYPE = /^[a-z_]{1,64}$/;
const MAX_TOKENS = 8192;
const REQUEST_KEYS = new Set([
  'model',
  'max_tokens',
  'system',
  'messages',
  'tools',
  'tool_choice',
  'temperature',
  'top_p',
  'top_k',
  'stop_sequences',
  'metadata',
  'thinking',
]);
const CHILD_EXIT_GRACE_MS = 2_000;

function error(status, type, message, headers = {}) {
  return { status, headers, body: { type: 'error', error: { type, message } } };
}

/** The bearer file must be a regular, non-symlink, exactly-0600 file owned by this uid. */
export async function loadToken(path) {
  if (typeof path !== 'string' || !path) throw new Error('OMP_GATEWAY_TOKEN_FILE is required');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Token file must be a regular file');
    if ((stat.mode & 0o777) !== 0o600) throw new Error('Token file mode must be 0600');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid())
      throw new Error('Token file must be owned by the current user');
    if (stat.size > 1024) throw new Error('Token file is too large');
    const token = (await handle.readFile('utf8')).trim();
    if (!TOKEN.test(token)) throw new Error('Token must be 32-512 URL-safe characters');
    return token;
  } finally {
    await handle.close();
  }
}

/** Constant-time bearer comparison independent of the presented length. */
export function authorized(header, token) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(token).digest();
  return timingSafeEqual(a, b);
}

/** 모니터 토큰은 파일뿐 아니라 부모 디렉터리도 현재 사용자 소유의 비심볼릭 링크 0700이어야 한다. */
export async function loadMonitorToken(path) {
  if (typeof path !== 'string' || !path) throw new Error('OMP_GATEWAY_MONITOR_TOKEN_FILE is required');
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Monitor token parent must be a directory');
  if ((parent.mode & 0o777) !== 0o700) throw new Error('Monitor token parent mode must be 0700');
  if (typeof process.getuid === 'function' && parent.uid !== process.getuid())
    throw new Error('Monitor token parent must be owned by the current user');
  return loadToken(path);
}

/** 길이나 접두사에 따른 조기 반환 없이 두 토큰을 비교한다. */
export function distinctTokens(modelToken, monitorToken) {
  const modelHash = createHash('sha256').update(modelToken).digest();
  const monitorHash = createHash('sha256').update(monitorToken).digest();
  return !timingSafeEqual(modelHash, monitorHash);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Accepts only the fixed Messages request the Worker builds: one of the two
 * exact bare models, bounded `max_tokens`, non-streaming, custom tools only
 * (no provider-executed tool types), known keys only. Returns the model the
 * Worker asked for and the provider-qualified outbound body.
 */
export function validateRequest(body) {
  if (!isRecord(body)) throw new Error('Request body must be a JSON object');
  for (const key of Object.keys(body)) if (!REQUEST_KEYS.has(key)) throw new Error('Unsupported request field');
  const model = body.model;
  if (!MODELS.includes(model)) throw new Error('Unsupported model');
  if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > MAX_TOKENS)
    throw new Error('max_tokens out of range');
  if (!Array.isArray(body.messages) || !body.messages.length) throw new Error('messages must be a non-empty array');
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > 16) throw new Error('tools must be a short array');
    for (const tool of body.tools) {
      if (
        !isRecord(tool) ||
        typeof tool.name !== 'string' ||
        !isRecord(tool.input_schema) ||
        (tool.type !== undefined && tool.type !== 'custom')
      )
        throw new Error('Only custom client tools are accepted');
    }
  }
  return { model, outbound: { ...body, model: `${PROVIDER}/${model}` } };
}

/**
 * Maps one stdio reply to the response the Worker receives. A success must be
 * a `message` envelope from exactly the requested model (provider-qualified or
 * bare); it is canonicalized to the bare id. Upstream failure text is never
 * forwarded: omp's error messages embed local paths and account details.
 */
export function canonicalizeResponse(model, status, body) {
  if (status === 200) {
    if (
      !isRecord(body) ||
      body.type !== 'message' ||
      (body.model !== `${PROVIDER}/${model}` && body.model !== model) ||
      !Array.isArray(body.content) ||
      typeof body.stop_reason !== 'string'
    )
      return error(502, 'upstream_error', 'Local model gateway returned an unexpected envelope');
    return { status: 200, headers: {}, body: { ...body, model } };
  }
  const type = isRecord(body) && isRecord(body.error) && typeof body.error.type === 'string' ? body.error.type : '';
  if (status === 429)
    return error(429, ERROR_TYPE.test(type) ? type : 'rate_limit_error', 'Local model gateway is rate limited');
  return error(502, 'upstream_error', 'Local model gateway declined the request');
}

const CHILD_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'TMPDIR',
  'LANG',
  'TZ',
  'TERM',
  'PI_CONFIG_DIR',
  'PI_PROXY',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
]);
const CHILD_ENV_PREFIXES = ['LC_', 'XDG_', 'OMP_AUTH_BROKER_'];

/**
 * The omp child only sees what it needs to find its config, its stored login
 * (or configured broker) and the network. Provider keys, OAuth tokens, base-URL
 * reroutes and Claude Code toggles in the bridge's own environment
 * (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_*`, `*_API_KEY`, …)
 * are dropped so the request cannot be re-routed or re-keyed from the outside.
 * omp's stored credential ladder (models.yml key, stored OAuth, stored key) is
 * still its own; the bridge cannot force OAuth-only outside broker mode.
 */
export function childEnv(source = process.env, overlayPath = overlay) {
  if (!overlayPath) throw new Error('Retry overlay is not installed');
  const env = { PI_CONFIG_FILES: overlayPath };
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (CHILD_ENV_KEYS.has(key) || CHILD_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) env[key] = value;
  }
  return env;
}

/**
 * Process-scoped omp settings overlay (`PI_CONFIG_FILES`, the highest config
 * layer below env-declared settings) so the child never retries the same
 * model, never walks a fallback chain and never waits for a usage reset: every
 * provider call the Worker budgets is exactly one provider attempt. The user's
 * global `config.yml` is untouched. Credential rotation between sibling
 * accounts of one provider is not a setting; see README for that limitation.
 */
export const RETRY_OVERLAY = {
  retry: {
    enabled: false,
    maxRetries: 0,
    modelFallback: false,
    usageAwareFallback: false,
    waitForUsageReset: false,
    rateLimitWalksChain: false,
    fallbackChains: Object.fromEntries(MODELS.map((model) => [`${PROVIDER}/${model}`, []])),
  },
};

let overlay = null;
let overlayDir = null;

/** Writes the overlay into a private 0700 temp dir (file 0600) and arms `spawnOmp`. */
export async function installOverlay() {
  if (overlay) return overlay;
  overlayDir = await mkdtemp(join(tmpdir(), 'local-omp-gateway-'));
  const file = join(overlayDir, 'config.json');
  await writeFile(file, JSON.stringify(RETRY_OVERLAY), { mode: 0o600 });
  overlay = file;
  return file;
}

export async function removeOverlay() {
  const dir = overlayDir;
  overlay = null;
  overlayDir = null;
  if (dir) await rm(dir, { recursive: true, force: true });
}

/** Spawns `omp auth-gateway stdio` without a shell; stderr is discarded, never logged. */
export function spawnOmp() {
  return spawn('omp', ['auth-gateway', 'stdio'], {
    stdio: ['pipe', 'pipe', 'ignore'],
    shell: false,
    windowsHide: true,
    env: childEnv(),
  });
}

/**
 * Startup gate: omp must list both exact provider-qualified models through its
 * own credential selection (`GET /v1/models` consumes no quota). This proves a
 * usable Anthropic login/broker credential exists; it does not choose which
 * stored credential omp will use for a request.
 */
export async function checkReadiness({ spawnChild = spawnOmp, timeoutMs = 30_000 } = {}) {
  const reply = await runStdioRequest({ path: '/v1/models', signal: AbortSignal.timeout(timeoutMs), spawnChild });
  if (reply.status !== 200 || !isRecord(reply.body) || !Array.isArray(reply.body.data))
    throw new Error(`omp could not list models (status ${reply.status})`);
  const served = new Set(reply.body.data.map((row) => (isRecord(row) ? row.id : undefined)));
  const missing = MODELS.filter((model) => !served.has(`${PROVIDER}/${model}`));
  if (missing.length)
    throw new Error(`omp has no credentialed route for ${missing.map((m) => `${PROVIDER}/${m}`).join(', ')}`);
  return MODELS;
}

/**
 * Runs exactly one stdio request in a fresh omp child and resolves with the
 * reply `{status, body}`. Stdout is bounded; an abort, the bound or a child
 * that exits early kills the child and rejects.
 */
export function runStdioRequest({ path, body, signal, spawnChild = spawnOmp }) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const id = randomBytes(16).toString('hex');
    const child = spawnChild();
    let buffer = Buffer.alloc(0);
    let received = 0;
    let ready = false;
    let settled = false;
    const alive = () => child.exitCode === null && child.signalCode === null;
    const kill = () => {
      if (alive()) child.kill('SIGKILL');
    };
    const settle = () => {
      if (settled) return false;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      child.stdout.removeAllListeners('data');
      child.stdout.resume();
      return true;
    };
    const fail = (message) => {
      if (!settle()) return;
      kill();
      reject(new Error(message));
    };
    function onAbort() {
      fail('Gateway request aborted');
    }
    const handleLine = (line) => {
      if (!line.trim()) return;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return fail('omp auth-gateway stdio produced a malformed line');
      }
      if (!ready) {
        if (!isRecord(parsed) || parsed.ready !== true) return fail('omp auth-gateway stdio did not become ready');
        ready = true;
        return;
      }
      if (!isRecord(parsed) || parsed.id !== id) return;
      if (!Number.isInteger(parsed.status)) return fail('omp auth-gateway stdio returned no status');
      if (!settle()) return;
      // Keep stdin open until the complete reply arrives; early EOF can truncate omp's stdout.
      child.stdin.end();
      const grace = setTimeout(kill, CHILD_EXIT_GRACE_MS);
      child.once('exit', () => clearTimeout(grace));
      if (!alive()) clearTimeout(grace);
      resolve({ status: parsed.status, body: parsed.body });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', () => fail('Could not start omp auth-gateway stdio'));
    // `exit` can precede the final stdout data; wait until the pipe is drained.
    child.on('close', () => fail('omp auth-gateway stdio exited before answering'));
    child.stdout.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_OUTPUT_BYTES) return fail('omp auth-gateway stdio exceeded the output bound');
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      let newline;
      while (!settled && (newline = buffer.indexOf(0x0a)) !== -1) {
        const line = buffer.subarray(0, newline).toString('utf8');
        buffer = buffer.subarray(newline + 1);
        handleLine(line);
      }
    });
    child.stdin.on('error', () => fail('Could not write to omp auth-gateway stdio'));
    child.stdin.write(`${JSON.stringify({ id, path, body })}\n`);
  });
}

/**
 * Collects at most `max` bytes. On overflow or abort it stops retaining data
 * and settles immediately; the caller answers (413/504) and then closes the
 * connection, so the rest of an oversized body is dropped, never buffered.
 */
function readBody(req, max, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      signal.removeEventListener('abort', onAbort);
      chunks.length = 0;
    };
    const settle = (fn, value) => {
      cleanup();
      fn(value);
    };
    function onData(chunk) {
      length += chunk.length;
      if (length > max) return settle(reject, Object.assign(new Error('Request body too large'), { status: 413 }));
      chunks.push(chunk);
    }
    function onEnd() {
      settle(resolve, Buffer.concat(chunks));
    }
    function onError(cause) {
      settle(reject, cause);
    }
    function onAbort() {
      settle(reject, signal.reason);
    }
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    // A dropped stream may still error (reset while draining); never let that go unhandled.
    req.on('error', () => {});
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

function cpuCounters(text) {
  const line = text.match(/^cpu\s+([^\n]+)/m)?.[1];
  if (!line) return null;
  const fields = line.trim().split(/\s+/);
  if (fields.length < 8 || fields.slice(0, 8).some((field) => !/^\d+$/.test(field))) return null;
  const counters = fields.slice(0, 8).map(Number);
  if (counters.some((value) => !Number.isSafeInteger(value))) return null;
  return { counters, total: counters.reduce((sum, value) => sum + value, 0), idle: counters[3] + counters[4] };
}

/** Linux /proc/stat 집계값에서 guest 시간은 이미 user/nice에 포함되므로 중복 합산하지 않는다. */
export function cpuDelta(first, second, sampleStart, sampleEnd) {
  if (
    !Number.isSafeInteger(sampleStart) ||
    sampleStart < 0 ||
    !Number.isSafeInteger(sampleEnd) ||
    sampleEnd <= sampleStart ||
    sampleEnd - sampleStart > 10_000
  )
    return null;
  const start = cpuCounters(first);
  const end = cpuCounters(second);
  if (
    !start ||
    !end ||
    !Number.isSafeInteger(start.total) ||
    !Number.isSafeInteger(end.total) ||
    end.counters.some((value, index) => value < start.counters[index])
  )
    return null;
  const total = end.total - start.total;
  const idle = end.idle - start.idle;
  if (total <= 0 || idle < 0 || idle > total) return null;
  return { usagePercent: ((total - idle) / total) * 100, sampleStart, sampleEnd };
}

/** 회수 가능한 캐시를 반영하는 MemAvailable을 사용하며, 읽지 못한 메모리는 null로 둔다. */
export function memoryReading(text, checkedAt) {
  const values = new Map();
  for (const line of text.split('\n')) {
    const match = /^(MemTotal|MemAvailable):\s+(\d+)\s+kB\s*$/.exec(line);
    if (match) values.set(match[1], Number(match[2]) * 1024);
  }
  const totalBytes = values.get('MemTotal');
  const availableBytes = values.get('MemAvailable');
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes <= 0 ||
    !Number.isSafeInteger(availableBytes) ||
    availableBytes < 0 ||
    availableBytes > totalBytes
  )
    return null;
  return { totalBytes, availableBytes, usedBytes: totalBytes - availableBytes, checkedAt };
}

function unknownUnit() {
  return { configured: null, state: 'unknown', process: 'unknown', checkedAt: null };
}

/** systemctl show의 메타데이터만 읽는다. ActiveState만으로 프로세스 실행을 단정하지 않는다. */
export function unitReading(text, checkedAt) {
  const values = new Map();
  for (const line of text.split('\n')) {
    const match = /^(LoadState|ActiveState|SubState|MainPID)=(.*)$/.exec(line);
    if (match && !values.has(match[1])) values.set(match[1], match[2]);
  }
  if (['LoadState', 'ActiveState', 'SubState', 'MainPID'].some((key) => !values.has(key))) return unknownUnit();
  const configured =
    values.get('LoadState') === 'loaded' ? true : values.get('LoadState') === 'not-found' ? false : null;
  const rawState = values.get('ActiveState');
  const state = ['active', 'inactive', 'failed', 'activating', 'deactivating'].includes(rawState)
    ? rawState
    : 'unknown';
  const pid = values.get('MainPID');
  const substate = values.get('SubState');
  let processState = 'unknown';
  if (/^\d+$/.test(pid) && Number.isSafeInteger(Number(pid))) {
    if (Number(pid) > 0 && substate === 'running') processState = 'running';
    else if (Number(pid) === 0 && ['dead', 'exited', 'failed'].includes(substate)) processState = 'stopped';
    else if (Number(pid) === 0 && state === 'inactive') processState = 'stopped';
  }
  return { configured, state, process: processState, checkedAt };
}

/** 고정 인수와 출력 상한을 사용하고, 중단 시 프로브를 종료한 뒤 close를 기다린다. */
function showUnit(unit, { signal }) {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn(
      'systemctl',
      ['show', '--no-pager', '--property=LoadState,ActiveState,SubState,MainPID', unit],
      {
        shell: false,
        stdio: ['ignore', 'pipe', 'ignore'],
        signal,
      },
    );
    const onAbort = () => child.kill('SIGKILL');
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    let output = '';
    let length = 0;
    let failed = false;
    child.stdout.on('data', (chunk) => {
      length += chunk.length;
      if (length > SYSTEMCTL_OUTPUT_BYTES) {
        failed = true;
        child.kill('SIGKILL');
      } else if (!failed) output += chunk.toString('utf8');
    });
    child.once('error', () => {
      failed = true;
    });
    child.once('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      if (failed || code !== 0) reject(new Error('Unit probe unavailable'));
      else resolve(output);
    });
  });
}

/** 각 프로브는 읽기 전용이며 중단 가능하다. 실패한 항목만 독립적으로 미확인 처리한다. */
export async function collectRockyHealth({
  signal,
  now = Date.now,
  readProc = readFile,
  runSystemctl = showUnit,
  sampleMs = CPU_SAMPLE_MS,
  platform = process.platform,
} = {}) {
  if (!signal) throw new Error('Health collection needs an abort signal');
  signal.throwIfAborted();
  const cpu = async () => {
    const sampleStart = now();
    const first = await readProc('/proc/stat', { encoding: 'utf8', signal });
    await sleep(sampleMs, undefined, { signal });
    const second = await readProc('/proc/stat', { encoding: 'utf8', signal });
    return cpuDelta(first, second, sampleStart, now());
  };
  const memory = async () => memoryReading(await readProc('/proc/meminfo', { encoding: 'utf8', signal }), now());
  const unit = async (name) => unitReading(await runSystemctl(name, { signal }), now());
  const results =
    platform === 'linux' ? await Promise.allSettled([cpu(), memory(), unit(UNITS[0]), unit(UNITS[1])]) : [];
  signal.throwIfAborted();
  const value = (index, fallback) => (results[index]?.status === 'fulfilled' ? results[index].value : fallback);
  return {
    version: 1,
    scope: 'rocky-read-only',
    checkedAt: now(),
    gateway: 'responding',
    cpu: value(0, null),
    memory: value(1, null),
    executor: value(2, unknownUnit()),
    broker: value(3, unknownUnit()),
    brokerResponse: 'not_probed',
    model: 'not_probed',
  };
}

function send(res, { status, headers, body }) {
  if (res.destroyed || res.headersSent) return;
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': bytes.length,
    'Cache-Control': 'no-store',
    Connection: 'close',
    ...headers,
  });
  res.end(bytes);
}

/**
 * 모델 요청은 기존 단일 자식 프로세스 슬롯을 사용한다. 인증된 상태 조회는
 * 별도의 짧은 제한 시간 내에 실행하며 모델 슬롯을 점유하지 않는다.
 */
export function createGateway({
  token,
  monitorToken = null,
  runRequest = runStdioRequest,
  collectHealth = collectRockyHealth,
  timeoutMs = REQUEST_TIMEOUT_MS,
  healthTimeoutMs = HEALTH_TIMEOUT_MS,
  log = console.error,
}) {
  if (monitorToken !== null && !distinctTokens(token, monitorToken))
    throw new Error('Monitor and model bearer tokens must differ');
  let busy = false;
  const server = createServer(async (req, res) => {
    const startedAt = Date.now();
    const modelRoute = req.url === PATH;
    const healthRoute = req.url === HEALTH_PATH;
    const report = (status) =>
      log('[local-omp-gateway]', {
        route: modelRoute ? PATH : healthRoute ? HEALTH_PATH : 'other',
        status,
        ms: Date.now() - startedAt,
      });
    // A request whose body was not consumed closes once the answer is flushed, so
    // the remainder of an oversized or stalled body is dropped rather than drained.
    const done = (reply) => {
      send(res, reply);
      if (!req.complete) {
        if (res.writableFinished || res.destroyed) req.destroy();
        else res.once('finish', () => req.destroy());
      }
      report(reply.status);
    };
    const dropped = () => {
      req.destroy();
      report('disconnected');
    };
    if (!modelRoute && !healthRoute) return done(error(404, 'not_found_error', 'Not found'));
    if (healthRoute) {
      if (req.method !== 'GET') return done(error(405, 'not_found_error', 'Method not allowed', { Allow: 'GET' }));
      if (!monitorToken) return done(error(503, 'api_error', 'Health monitoring unavailable'));
      if (!authorized(req.headers.authorization, monitorToken))
        return done(error(401, 'authentication_error', 'Invalid bearer token', { 'WWW-Authenticate': 'Bearer' }));
      const controller = new AbortController();
      const deadline = Promise.withResolvers();
      const abort = (reason) => {
        controller.abort(reason);
        deadline.reject(reason);
      };
      const timer = setTimeout(() => abort(new Error('timeout')), healthTimeoutMs);
      const onClose = () => {
        if (!res.writableFinished) abort(new Error('client disconnected'));
      };
      res.on('close', onClose);
      try {
        // 수집기는 중단 신호를 따르지만, 따르지 않는 구현에도 제한 시간을 강제한다.
        const body = await Promise.race([collectHealth({ signal: controller.signal }), deadline.promise]);
        if (controller.signal.aborted) {
          if (controller.signal.reason?.message === 'timeout')
            return done(error(504, 'api_error', 'Health probe timed out'));
          return dropped();
        }
        return done({ status: 200, body });
      } catch {
        if (controller.signal.reason?.message === 'timeout')
          return done(error(504, 'api_error', 'Health probe timed out'));
        if (controller.signal.aborted) return dropped();
        return done(error(503, 'api_error', 'Health probe unavailable'));
      } finally {
        clearTimeout(timer);
        res.off('close', onClose);
      }
    }
    if (req.method !== 'POST') return done(error(405, 'not_found_error', 'Method not allowed', { Allow: 'POST' }));
    if (!authorized(req.headers.authorization, token))
      return done(error(401, 'authentication_error', 'Invalid bearer token', { 'WWW-Authenticate': 'Bearer' }));
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_INPUT_BYTES)
      return done(error(413, 'request_too_large', 'Request body exceeds 1 MiB'));
    if (busy) return done(error(503, 'overloaded_error', 'Another request is in flight', { 'Retry-After': '5' }));
    busy = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    const timedOut = () => controller.signal.aborted && controller.signal.reason?.message === 'timeout';
    res.on('close', () => {
      if (!res.writableFinished) controller.abort(new Error('client disconnected'));
    });
    try {
      let parsed;
      try {
        const bytes = await readBody(req, MAX_INPUT_BYTES, controller.signal);
        parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch (cause) {
        if (timedOut()) return done(error(504, 'api_error', 'Request body did not arrive in time'));
        if (controller.signal.aborted) return dropped();
        if (cause?.status === 413) return done(error(413, 'request_too_large', 'Request body exceeds 1 MiB'));
        return done(error(400, 'invalid_request_error', 'Body must be valid JSON'));
      }
      let request;
      try {
        request = validateRequest(parsed);
      } catch (cause) {
        return done(error(400, 'invalid_request_error', cause.message));
      }
      let reply;
      try {
        reply = await runRequest({ path: PATH, body: request.outbound, signal: controller.signal });
      } catch {
        if (timedOut()) return done(error(504, 'api_error', 'Local model gateway timed out'));
        if (controller.signal.aborted) return dropped();
        return done(error(502, 'upstream_error', 'Local model gateway failed'));
      }
      done(canonicalizeResponse(request.model, reply.status, reply.body));
    } finally {
      clearTimeout(timer);
      busy = false;
    }
  });
  server.requestTimeout = timeoutMs + 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 64;
  return server;
}

async function main() {
  const token = await loadToken(process.env.OMP_GATEWAY_TOKEN_FILE);
  const monitorToken = process.env.OMP_GATEWAY_MONITOR_TOKEN_FILE
    ? await loadMonitorToken(process.env.OMP_GATEWAY_MONITOR_TOKEN_FILE)
    : null;
  if (monitorToken !== null && !distinctTokens(token, monitorToken))
    throw new Error('Monitor and model bearer tokens must differ');
  const port = process.env.OMP_GATEWAY_PORT === undefined ? DEFAULT_PORT : Number(process.env.OMP_GATEWAY_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('OMP_GATEWAY_PORT must be a TCP port');
  await installOverlay();
  await checkReadiness();
  const server = createGateway({ token, monitorToken });
  // Closing live connections aborts the in-flight request, which kills its omp child.
  const stop = () => {
    server.close(() => removeOverlay().finally(() => process.exit(0)));
    server.closeAllConnections();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
  });
  console.error('[local-omp-gateway] listening', { host: '127.0.0.1', port, models: MODELS });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (cause) => {
    console.error('[local-omp-gateway] fatal', cause instanceof Error ? cause.message : 'startup failed');
    await removeOverlay().catch(() => {});
    process.exit(1);
  });
}
