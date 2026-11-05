import assert from 'node:assert/strict';
import { test } from 'node:test';
import { API_DISABLED_QUEUE_RETRY_DELAY_SECONDS, API_DISABLED_RETRY_AFTER_SECONDS, isApiEnabled } from '@api/api-gate';
import app from '@api/app';
import { CommunityChatDurableObject } from '@api/domains/community/stomp';
import type { Job } from '@api/jobs';
import type { Bindings } from '@api/runtime';
import worker from '@api/worker';

/** 업무 바인딩에 손대는 순간 실패하는 env. 비활성 경로가 D1/R2/Queue/DO를 전혀 건드리지 않음을 증명한다. */
function sealedEnv(apiEnabled: string | undefined, touched: string[] = []): Bindings {
  const env: Record<string, unknown> = { ENVIRONMENT: 'production' };
  if (apiEnabled !== undefined) env.API_ENABLED = apiEnabled;
  for (const name of ['DB', 'FILES', 'JOBS', 'COORDINATOR', 'COMMUNITY_CHAT']) {
    Object.defineProperty(env, name, {
      enumerable: true,
      get() {
        touched.push(name);
        throw new Error(`Unexpected binding access: ${name}`);
      },
    });
  }
  return env as unknown as Bindings;
}

function fakeBatch(bodies: Job[]) {
  const calls: string[] = [];
  const messages = bodies.map((body, index) => ({
    id: `message-${index}`,
    timestamp: new Date(0),
    body,
    attempts: 1,
    ack: () => {
      calls.push(`ack:${index}`);
    },
    retry: (options?: { delaySeconds?: number }) => {
      calls.push(`retry:${index}:${options?.delaySeconds ?? ''}`);
    },
  }));
  const batch = {
    queue: 'koin-api-jobs',
    messages,
    ackAll: () => {
      calls.push('ackAll');
    },
    retryAll: (options?: { delaySeconds?: number }) => {
      calls.push(`retryAll:${options?.delaySeconds ?? ''}`);
    },
  } as unknown as MessageBatch<Job>;
  return { batch, calls };
}

const context = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

test('API_ENABLED is active only for the exact string true', () => {
  assert.equal(isApiEnabled({ API_ENABLED: 'true' }), true);
  for (const value of [undefined, '', 'false', 'TRUE', 'True', ' true', 'true ', '1', 'yes', 'on'])
    assert.equal(isApiEnabled({ API_ENABLED: value }), false, `expected ${JSON.stringify(value)} to be disabled`);
});

test('disabled app answers every route with an uncached 503 and never opens a binding', async () => {
  const touched: string[] = [];
  const env = sealedEnv('false', touched);
  for (const [method, path] of [
    ['GET', '/health'],
    ['GET', '/openapi.json'],
    ['POST', '/internal/source-sync'],
    ['GET', '/ws-stomp'],
    ['POST', '/timetables'],
    ['GET', '/does-not-exist'],
  ] as const) {
    const response = await app.request(
      `https://koin-api.example${path}`,
      { method, headers: { Origin: 'https://koreatech.in' } },
      env,
      context,
    );
    assert.equal(response.status, 503, `${method} ${path}`);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Retry-After'), String(API_DISABLED_RETRY_AFTER_SECONDS));
    const body = (await response.json()) as { code: string; errorTraceId: string };
    assert.equal(body.code, 'API_DISABLED');
    assert.ok(body.errorTraceId);
  }
  assert.deepEqual(touched, []);
});

test('missing API_ENABLED is disabled by default while the exact value true serves traffic', async () => {
  const defaulted = await app.request('/health', {}, sealedEnv(undefined));
  assert.equal(defaulted.status, 503);
  const enabled = await app.request('/health', {}, sealedEnv('true'));
  assert.equal(enabled.status, 200);
  const health = (await enabled.json()) as { status: string };
  assert.equal(health.status, 'ok');
});

test('disabled queue consumer retries the whole batch with maximum delay without ack, drop or binding access', async () => {
  const touched: string[] = [];
  const env = sealedEnv('false', touched);
  const { batch, calls } = fakeBatch([
    { kind: 'identity.outbox', key: '1', payload: {} },
    { kind: 'dining.outbox', key: '2', payload: {} },
  ]);
  await worker.queue!(batch, env, context);
  assert.deepEqual(calls, [`retryAll:${API_DISABLED_QUEUE_RETRY_DELAY_SECONDS}`]);
  assert.deepEqual(touched, []);
  // Queues의 메시지 지연 상한은 12시간(43,200초)이며 기존 도메인 코드도 같은 값으로 clamp한다.
  assert.equal(API_DISABLED_QUEUE_RETRY_DELAY_SECONDS, 43_200);
});

test('enabled queue consumer keeps per-message handling instead of the disabled batch retry', async () => {
  const env = sealedEnv('true');
  const { batch, calls } = fakeBatch([{ kind: 'unknown.kind', key: '1', payload: {} }]);
  await worker.queue!(batch, env, context);
  assert.deepEqual(calls, ['retry:0:30']);
});

test('disabled scheduled handler finishes without running any cron work', async () => {
  const touched: string[] = [];
  const env = sealedEnv('false', touched);
  const event = {
    scheduledTime: Date.parse('2026-10-28T00:00:00Z'),
    cron: '0 * * * *',
    noRetry: () => undefined,
  } as unknown as ScheduledController;
  await worker.scheduled!(event, env, context);
  assert.deepEqual(touched, []);
});

function sealedState(touched: string[]) {
  const state: Record<string, unknown> = {
    waitUntil: () => {
      touched.push('waitUntil');
    },
    acceptWebSocket: () => {
      touched.push('acceptWebSocket');
    },
    getWebSockets: () => [],
  };
  Object.defineProperty(state, 'storage', {
    get() {
      touched.push('storage');
      throw new Error('Unexpected Durable Object storage access');
    },
  });
  return state as unknown as DurableObjectState;
}

test('disabled chat Durable Object rejects new sockets and dispatches without touching storage or bindings', async () => {
  const touched: string[] = [];
  const durable = new CommunityChatDurableObject(sealedState(touched), sealedEnv('false', touched));
  const upgrade = await durable.fetch(
    new Request('https://koin-api.example/ws-stomp', { headers: { Upgrade: 'websocket' } }),
  );
  assert.equal(upgrade.status, 503);
  const dispatch = await durable.fetch(
    new Request('https://koin-api.example/articles/lost-item/1/chatroom/2/messages', { method: 'POST' }),
  );
  assert.equal(dispatch.status, 503);
  assert.deepEqual(touched, []);
});

test('disabled chat Durable Object closes a woken socket with a STOMP error and no business IO', async () => {
  const touched: string[] = [];
  const durable = new CommunityChatDurableObject(sealedState(touched), sealedEnv('false', touched));
  const sent: string[] = [];
  const closed: [number, string][] = [];
  let attachment: Record<string, unknown> = {
    id: 'session',
    principal: { id: 1, userType: 'STUDENT' },
    version: '1.2',
    subscriptions: { sub: '/topic/chat/1/2' },
    status: 'ACTIVE_CHAT_ROOM',
    expiresAt: Date.now() + 60_000,
  };
  const socket = {
    deserializeAttachment: () => attachment,
    serializeAttachment: (value: Record<string, unknown>) => {
      attachment = value;
    },
    send: (frame: string | ArrayBuffer) => {
      sent.push(typeof frame === 'string' ? frame : new TextDecoder().decode(frame));
    },
    close: (code: number, reason: string) => {
      closed.push([code, reason]);
    },
  } as unknown as WebSocket;
  await durable.webSocketMessage(socket, 'SEND\ndestination:/app/chat/1/2\n\n{"content":"hi"}\u0000');
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /^ERROR\n/);
  assert.match(sent[0]!, /API_DISABLED/);
  assert.deepEqual(closed, [[1013, 'API_DISABLED']]);
  assert.equal(attachment.status, 'INACTIVE');
  assert.deepEqual(attachment.subscriptions, {});
  assert.deepEqual(touched, []);
});
