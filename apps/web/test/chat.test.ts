import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

import {
  createChatMessageCache,
  fetchChatMessageCache,
  mergeChatMessageCache,
  mergeChatMessages,
  type ChatMessageCache,
} from '../src/api/chat/cache';
import type { ChatMessageResponse } from '../src/api/chat/entity';

const message = (id: number | string, unreadCount = 1): ChatMessageResponse => ({
  message_id: String(id),
  user_id: 7,
  user_nickname: '코인',
  content: String(id),
  timestamp: '2026-11-15T12:00:00',
  is_image: false,
  unread_count: unreadCount,
  is_left_user: false,
});

const range = (first: number, last: number) =>
  Array.from({ length: last - first + 1 }, (_, index) => message(first + index));

const cacheWith = (messages: ChatMessageResponse[], cursor?: string): ChatMessageCache => ({
  ...createChatMessageCache(),
  initialized: true,
  messages,
  lastFetchedMessageId: cursor,
});

test('문자열 int64 ID를 손실 없이 정렬하고 중복 메시지의 상태를 갱신한다', () => {
  const merged = mergeChatMessages(
    [message('9007199254740993'), message('10'), message('9'), message('9007199254740992')],
    [message('10', 0)],
  );
  assert.deepEqual(
    merged.map((item) => item.message_id),
    ['9', '10', '9007199254740992', '9007199254740993'],
  );
  assert.equal(merged[1].unread_count, 0);
});

test('처음 방문한 방은 최신 페이지와 REST 조회 기준을 저장한다', async () => {
  const requests: unknown[] = [];
  const cache = await fetchChatMessageCache(undefined, (params) => {
    requests.push(params);

    return Promise.resolve(range(51, 150));
  });
  assert.deepEqual(requests, [{ limit: 100 }]);
  assert.equal(cache.lastFetchedMessageId, '150');
  assert.equal(cache.hasPreviousMessages, true);
});

test('전송 응답 105를 먼저 받아도 REST 기준 100 다음의 101~104를 조회한다', async () => {
  const previous = cacheWith([message(100), message(105)], '100');
  const requests: unknown[] = [];
  const cache = await fetchChatMessageCache(previous, (params) => {
    requests.push(params);

    return Promise.resolve(params.after_message_id ? range(101, 105) : range(100, 105));
  });
  assert.deepEqual(requests[0], { after_message_id: '100', limit: 100 });
  assert.deepEqual(
    cache.messages.map((item) => item.message_id),
    ['100', '101', '102', '103', '104', '105'],
  );
  assert.equal(cache.lastFetchedMessageId, '105');
});

test('빈 방에서 150개가 생기면 이전 페이지까지 복구하고 복구 중 도착한 메시지도 조회한다', async () => {
  const previous = cacheWith([]);
  const requests: unknown[] = [];
  const cache = await fetchChatMessageCache(previous, (params) => {
    requests.push(params);
    if (params.before_message_id) return Promise.resolve(range(1, 50));
    if (params.after_message_id) return Promise.resolve([message(151)]);

    return Promise.resolve(range(51, 150));
  });
  assert.deepEqual(requests.slice(0, 3), [
    { limit: 100 },
    { before_message_id: '51', limit: 100 },
    { after_message_id: '150', limit: 100 },
  ]);
  assert.equal(cache.messages.length, 151);
  assert.equal(cache.messages[0].message_id, '1');
  assert.equal(cache.lastFetchedMessageId, '151');
  assert.equal(cache.hasPreviousMessages, false);
  assert.equal(previous.lastFetchedMessageId, undefined);
});

test('빈 방 복구 중 실패하면 조회 기준을 확정하지 않고 다음 조회에서 복구를 재시도한다', async () => {
  const previous = cacheWith([message(150)]);
  await assert.rejects(
    fetchChatMessageCache(previous, (params) =>
      params.before_message_id ? Promise.reject(new Error('offline')) : Promise.resolve(range(51, 150)),
    ),
    /offline/,
  );
  assert.equal(previous.lastFetchedMessageId, undefined);
  const recovered = await fetchChatMessageCache(previous, (params) => {
    if (params.before_message_id) return Promise.resolve(range(1, 50));
    if (params.after_message_id) return Promise.resolve([]);

    return Promise.resolve(range(51, 150));
  });
  assert.equal(recovered.messages.length, 150);
  assert.equal(recovered.lastFetchedMessageId, '150');
});

test('조회 결과가 100개면 다음 페이지를 끝까지 가져오고 기존 대화를 보존한다', async () => {
  const afterIds: string[] = [];
  const cache = await fetchChatMessageCache(cacheWith([message(1)], '1'), (params) => {
    if (params.after_message_id) {
      afterIds.push(params.after_message_id);

      return Promise.resolve(params.after_message_id === '1' ? range(2, 101) : range(102, 130));
    }
    if (params.before_message_id) return Promise.resolve(range(1, 30));

    return Promise.resolve(range(31, 130));
  });
  assert.deepEqual(afterIds, ['1', '101']);
  assert.equal(cache.messages.length, 130);
  assert.equal(cache.lastFetchedMessageId, '130');
});

test('상태 갱신 응답으로 뒤늦게 본 새 ID는 다음 증분 조회 기준으로 건너뛰지 않는다', async () => {
  const cache = await fetchChatMessageCache(cacheWith([message(100)], '100'), (params) =>
    Promise.resolve(params.after_message_id ? [] : [message(100, 0), message(105)]),
  );
  assert.equal(cache.lastFetchedMessageId, '100');
  assert.equal(cache.messages[0].unread_count, 0);
  assert.equal(cache.messages[1].message_id, '105');
});

test('늦은 폴링 결과는 먼저 완료된 이전 페이지와 읽음 위치를 덮어쓰지 않는다', () => {
  const previous = { ...cacheWith(range(1, 105), '105'), lastReadMessageId: '105', hasPreviousMessages: false };
  const late = { ...cacheWith(range(51, 100), '100'), lastReadMessageId: '99', hasPreviousMessages: true };
  const merged = mergeChatMessageCache(previous, late);
  assert.equal(merged.messages.length, 105);
  assert.equal(merged.lastFetchedMessageId, '105');
  assert.equal(merged.lastReadMessageId, '105');
  assert.equal(merged.hasPreviousMessages, false);
});

test('진행하지 않는 페이지 응답은 무한 반복하지 않는다', async () => {
  await assert.rejects(
    fetchChatMessageCache(cacheWith([message(1)], '1'), () => Promise.resolve([message(1)])),
    /진행되지/,
  );
});

test('공통 쿼리와 mutation은 실제 APIClient HTTP 경로에서 캐시와 취소를 처리한다', async (t) => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'https://example.test' } },
  });
  const browserDocument = { cookie: '', visibilityState: 'visible' };
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: browserDocument,
  });
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'cloudflare:workers') {
        return {
          url: 'data:text/javascript,export const env = {KOIN_ENVIRONMENT:"preview",KOIN_API_ORIGIN:"https://api.stage.koreatech.in"}',
          shortCircuit: true,
        };
      }

      return nextResolve(specifier, context);
    },
  });
  t.after(() => {
    hooks.deregister();
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'document');
  });
  const { QueryClient } = await import('@tanstack/react-query');
  const { chatQueries, chatQueryKeys } = await import('../src/api/chat/queries');
  const { chatMutations } = await import('../src/api/chat/mutations');
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } },
  });
  t.after(() => client.clear());
  const roomId = 'server-room-id';

  await t.test('사용자와 방별로 캐시가 분리되고 전송이 REST 기준을 변경하지 않는다', async (subtest) => {
    const key = chatQueryKeys.messages(7, roomId);
    client.setQueryDefaults(key, {
      structuralSharing: chatQueries.messages(client, 7, roomId).structuralSharing,
      gcTime: Infinity,
    });
    client.setQueryData(key, cacheWith([message(100)], '100'));
    client.setQueryData(chatQueryKeys.messages(8, roomId), cacheWith([message(9)], '9'));
    const requests: Request[] = [];
    subtest.mock.method(globalThis, 'fetch', (request: Request) => {
      requests.push(request);

      return Promise.resolve(Response.json(message(105)));
    });
    await client
      .getMutationCache()
      .build(client, chatMutations.sendMessage(client, 7, roomId))
      .execute({ content: '안녕하세요', is_image: false });
    assert.equal(requests[0].method, 'POST');
    assert.equal(new URL(requests[0].url).pathname, `/chatrooms/${roomId}/messages`);
    assert.deepEqual(await requests[0].json(), { content: '안녕하세요', is_image: false });
    assert.equal(client.getQueryData<ChatMessageCache>(key)?.lastFetchedMessageId, '100');
    assert.equal(client.getQueryData<ChatMessageCache>(key)?.messages.at(-1)?.message_id, '105');
    assert.equal(client.getQueryData<ChatMessageCache>(chatQueryKeys.messages(8, roomId))?.lastFetchedMessageId, '9');
    const updated = await client
      .getMutationCache()
      .build(client, chatMutations.markRead(client, 7, roomId))
      .execute('105');
    assert.equal(updated, false);
    assert.equal(requests.length, 1);
  });

  await t.test('전송 중 로그아웃하면 늦은 응답이 이전 계정 캐시를 만들지 않는다', async (subtest) => {
    const key = chatQueryKeys.messages(7, roomId);
    let finish!: (response: Response) => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    subtest.mock.method(globalThis, 'fetch', () => {
      started();

      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    });
    const sending = client
      .getMutationCache()
      .build(client, chatMutations.sendMessage(client, 7, roomId))
      .execute({ content: '안녕하세요', is_image: false });
    await pending;
    client.clear();
    finish(Response.json(message(106)));
    await sending;
    assert.equal(client.getQueryData(key), undefined);
  });

  await t.test('확인한 메시지만 204 읽음 처리하고 같은 위치와 이전 위치는 다시 보내지 않는다', async (subtest) => {
    const key = chatQueryKeys.messages(7, roomId);
    client.setQueryDefaults(key, {
      structuralSharing: chatQueries.messages(client, 7, roomId).structuralSharing,
      gcTime: Infinity,
    });
    client.setQueryData(key, cacheWith([message(100), message(101)], '101'));
    const requests: Request[] = [];
    subtest.mock.method(globalThis, 'fetch', (request: Request) => {
      requests.push(request);

      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const read = () => client.getMutationCache().build(client, chatMutations.markRead(client, 7, roomId));
    assert.equal(await read().execute('999'), false);
    assert.equal(await read().execute('101'), true);
    assert.equal(await read().execute('101'), false);
    assert.equal(await read().execute('100'), false);
    assert.equal(requests.length, 1);
    assert.deepEqual(await requests[0].json(), { message_id: '101' });
    assert.equal(client.getQueryData<ChatMessageCache>(key)?.lastReadMessageId, '101');
  });

  await t.test('백그라운드에서는 아직 읽지 않은 메시지도 읽음 요청을 보내지 않는다', async (subtest) => {
    const key = chatQueryKeys.messages(7, roomId);
    client.setQueryData<ChatMessageCache>(key, (previous) => previous && { ...previous, messages: [message(102)] });
    const fetch = subtest.mock.method(globalThis, 'fetch', () => Promise.reject(new Error('Unexpected HTTP request')));
    browserDocument.visibilityState = 'hidden';
    subtest.after(() => {
      browserDocument.visibilityState = 'visible';
    });
    const updated = await client
      .getMutationCache()
      .build(client, chatMutations.markRead(client, 7, roomId))
      .execute('102');
    assert.equal(updated, false);
    assert.equal(fetch.mock.callCount(), 0);
  });

  await t.test('이전 대화가 없는 페이지를 조회하면 재시도를 멈추고 기존 대화를 유지한다', async (subtest) => {
    client.clear();
    const key = chatQueryKeys.messages(7, roomId);
    client.setQueryDefaults(key, {
      structuralSharing: chatQueries.messages(client, 7, roomId).structuralSharing,
      gcTime: Infinity,
    });
    client.setQueryData(key, { ...cacheWith([message(100)], '100'), hasPreviousMessages: true });
    subtest.mock.method(globalThis, 'fetch', () => Promise.resolve(Response.json([])));
    await client
      .getMutationCache()
      .build(client, chatMutations.loadPreviousMessages(client, 7, roomId))
      .execute(undefined);
    assert.equal(client.getQueryData<ChatMessageCache>(key)?.hasPreviousMessages, false);
    assert.equal(client.getQueryData<ChatMessageCache>(key)?.messages.length, 1);
  });

  await t.test('폴링 중 전송과 이전 대화 조회가 끝나도 늦은 응답이 캐시를 덮어쓰지 않는다', async (subtest) => {
    const key = chatQueryKeys.messages(7, roomId);
    let finish!: (response: Response) => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    subtest.mock.method(globalThis, 'fetch', (request: Request) => {
      if (new URL(request.url).searchParams.has('after_message_id')) {
        started();

        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      }

      return Promise.resolve(Response.json(range(100, 105)));
    });
    const fetching = client.fetchQuery(chatQueries.messages(client, 7, roomId));
    await pending;
    client.setQueryData(key, { ...cacheWith([...range(1, 100), message(105)], '100'), hasPreviousMessages: false });
    finish(Response.json(range(101, 105)));
    await fetching;
    const cache = client.getQueryData<ChatMessageCache>(key);
    assert.equal(cache?.messages.length, 105);
    assert.equal(cache?.messages[0].message_id, '1');
    assert.equal(cache?.lastFetchedMessageId, '105');
    assert.equal(cache?.hasPreviousMessages, false);
  });

  await t.test('방 요청 취소가 진행 중 HTTP 요청까지 전달되고 기존 캐시는 유지된다', async (subtest) => {
    client.clear();
    const key = chatQueryKeys.messages(7, roomId);
    client.setQueryDefaults(key, {
      structuralSharing: chatQueries.messages(client, 7, roomId).structuralSharing,
      gcTime: Infinity,
    });
    client.setQueryData(key, cacheWith([message(100)], '100'));
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      started = resolve;
    });
    let requestSignal: AbortSignal | undefined;
    subtest.mock.method(globalThis, 'fetch', (request: Request) => {
      requestSignal = request.signal;
      started();

      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
          once: true,
        });
      });
    });
    const fetching = client.fetchQuery(chatQueries.messages(client, 7, roomId));
    await pending;
    await client.cancelQueries({ queryKey: chatQueryKeys.roomRoot(7, roomId) });
    const restored = await fetching;
    assert.equal(requestSignal?.aborted, true);
    assert.equal(restored.lastFetchedMessageId, '100');
    assert.equal(client.getQueryData<ChatMessageCache>(key)?.lastFetchedMessageId, '100');
  });

  await t.test('SSR에서는 공통 훅이 폴링이나 읽음 요청을 시작하지 않는다', async (subtest) => {
    const { createElement } = await import('react');
    const { renderToString } = await import('react-dom/server');
    const { QueryClientProvider } = await import('@tanstack/react-query');
    const { default: useChat } = await import('../src/utils/hooks/chat/useChat');
    let active = true;
    const fetch = subtest.mock.method(globalThis, 'fetch', () => Promise.reject(new Error('Unexpected HTTP request')));

    function Probe() {
      const chat = useChat({ userId: 7, roomId });
      active = chat.isActive;

      return null;
    }

    renderToString(createElement(QueryClientProvider, { client }, createElement(Probe)));
    assert.equal(active, false);
    assert.equal(fetch.mock.callCount(), 0);
  });
});
