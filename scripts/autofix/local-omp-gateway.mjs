#!/usr/bin/env node
/**
 * Loopback bridge that lets the error-automation Worker reach this machine's
 * omp credentials for the fixed model request only. It accepts exactly
 * `POST /v1/messages` with the dedicated bearer, forwards the body as one
 * `omp auth-gateway stdio` request (official credential path, nothing exported)
 * and returns the Anthropic Messages envelope back. The bridge never executes
 * tools, never logs bodies, upstream errors or the child's stderr, serves one
 * request at a time, and kills its own omp child when the client disconnects or
 * the deadline passes.
 *
 *   OMP_GATEWAY_TOKEN_FILE  regular 0600 file owned by this uid holding the bearer
 *   OMP_GATEWAY_PORT        loopback port (default 43129)
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5'];
export const PROVIDER = 'anthropic';
export const DEFAULT_PORT = 43129;
export const MAX_INPUT_BYTES = 1024 * 1024;
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const REQUEST_TIMEOUT_MS = 180_000;
const PATH = '/v1/messages';
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
 * Builds the loopback server. `runRequest` is the stdio runner and `timeoutMs`
 * the per-request deadline; tests inject a fake child and a short deadline.
 * Logging is limited to path class, status and timing.
 */
export function createGateway({
  token,
  runRequest = runStdioRequest,
  timeoutMs = REQUEST_TIMEOUT_MS,
  log = console.error,
}) {
  let busy = false;
  const server = createServer(async (req, res) => {
    const startedAt = Date.now();
    const route = req.url === PATH;
    const report = (status) =>
      log('[local-omp-gateway]', { route: route ? PATH : 'other', status, ms: Date.now() - startedAt });
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
    if (!route) return done(error(404, 'not_found_error', 'Not found'));
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
  const port = process.env.OMP_GATEWAY_PORT === undefined ? DEFAULT_PORT : Number(process.env.OMP_GATEWAY_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('OMP_GATEWAY_PORT must be a TCP port');
  await installOverlay();
  await checkReadiness();
  const server = createGateway({ token });
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
