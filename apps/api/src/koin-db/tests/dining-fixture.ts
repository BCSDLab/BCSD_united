import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { CoopObject } from '@api/koin-db/coop-object';
import { CoopStore } from '@api/koin-db/coop-store';
import type { DiningDurableObject } from '@api/koin-db/dining-object';
import { diningCacheKey, DiningStore, type DiningRow, type LikePair, type OwnedEntry } from '@api/koin-db/dining-store';
import type { Bindings } from '@api/runtime';

type Transaction = <T>(operation: () => T) => T;

/** node:sqlite로 DO SqlStorage.exec·transactionSync를 흉내 낸다. */
function memorySql(): [Pick<SqlStorage, 'exec'>, Transaction] {
  const database = new DatabaseSync(':memory:');
  const sql = {
    exec: (query: string, ...bindings: SQLInputValue[]) => {
      const rows = database.prepare(query).all(...bindings);
      return { toArray: () => rows };
    },
  } as unknown as Pick<SqlStorage, 'exec'>;
  const transaction: Transaction = (operation) => {
    database.exec('BEGIN');
    try {
      const result = operation();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  };
  return [sql, transaction];
}

export function memoryStore(): DiningStore {
  return new DiningStore(...memorySql());
}

export function memoryCoopStore(): CoopStore {
  return new CoopStore(...memorySql());
}

export function memoryKv() {
  const store = new Map<string, string>();
  const puts: string[] = [];
  const kv = {
    get: async (key: string, type?: string) => {
      const value = store.get(key) ?? null;
      return type === 'json' && value !== null ? JSON.parse(value) : value;
    },
    put: async (key: string, value: string) => {
      puts.push(key);
      store.set(key, value);
    },
  } as unknown as KVNamespace;
  return { kv, store, puts };
}

/**
 * DiningDurableObject와 같은 메서드를 가진 인메모리 네임스페이스. 각 메서드는 DO처럼 await 없이
 * 저장소를 바꾸고, KV 스냅샷은 alarm 대신 `flush()`로 쓴다. "coop" 인스턴스는 실제 CoopObject이며
 * 예약한 alarm 시각은 `alarms`에 남고 `coopAlarm()`으로 실행한다.
 */
export function memoryDining(kv?: KVNamespace) {
  const stores = new Map<string, DiningStore>();
  const pending = new Set<string>();
  const alarms: number[] = [];
  let env = {} as Bindings;
  const coopStore = memoryCoopStore();
  const store = (name: string) => {
    let value = stores.get(name);
    if (!value) stores.set(name, (value = memoryStore()));
    return value;
  };
  const object = (name: string) => {
    const state = store(name);
    const later = () => {
      if (state.pendingSnapshot()) pending.add(name);
    };
    return {
      view: async (userId: number | null, republish = false) => {
        if (republish) state.markPublished(null);
        later();
        return state.view(userId);
      },
      sync: async (date: string, rows: DiningRow[], owned: OwnedEntry[] | null = null) => {
        const result = state.sync(date, rows, Date.now());
        state.applyOwned(owned);
        later();
        return result;
      },
      applyOwned: async (entries: OwnedEntry[] | null) => {
        state.applyOwned(entries);
        later();
      },
      diningMeta: async (id: number) => state.diningMeta(id),
      importLikes: async (pairs: LikePair[]) => {
        const result = state.importLikes(pairs);
        later();
        return result;
      },
      like: async (userId: number, diningId: number, liked: boolean) => {
        const result = liked ? state.like(userId, diningId) : state.cancel(userId, diningId);
        if (result === 'OK') later();
        return result;
      },
      remember: async (date: string, ids: number[]) => state.remember(date, ids),
      locate: async (id: number) => state.locate(id),
      locateMany: async (ids: number[]) => state.locateMany(ids),
    };
  };
  const coop = new CoopObject(
    coopStore,
    new Proxy({} as Bindings, { get: (_target, key) => env[key as keyof Bindings] }),
    (date) => object(date),
    async (at) => {
      alarms.push(at);
    },
  );
  const namespace = {
    idFromName: (name: string) => name,
    get: (id: string) => (id === 'coop' ? coop : object(id)),
  } as unknown as DurableObjectNamespace<DiningDurableObject>;
  return {
    namespace,
    stores,
    store,
    coopStore,
    alarms,
    /** CoopObject가 bridge·FCM을 부를 때 쓸 env. */
    bind(value: Bindings) {
      env = value;
    },
    coopAlarm: () => coop.alarm(),
    /** alarm 실행: 대기 중인 날짜 스냅샷을 KV에 쓴다. */
    async flush() {
      for (const name of pending) {
        pending.delete(name);
        const snapshot = stores.get(name)!.pendingSnapshot();
        if (!snapshot || !kv) continue;
        await kv.put(diningCacheKey(snapshot.date), snapshot.value);
        stores.get(name)!.markPublished(snapshot.value);
      }
    },
  };
}

export interface BridgeData {
  dinings?: Map<string, unknown>;
  likes?: Map<string, LikePair[]>;
  users?: Map<number, unknown>;
  session?: (request: Request) => Response | Promise<Response>;
  other?: (request: Request) => Response | Promise<Response>;
}

/** bridge·Java 원본 fetch를 경로별로 응답한다. 모든 요청을 기록한다. */
export function mockUpstream(t: TestContext, data: BridgeData) {
  const requests: Request[] = [];
  t.mock.method(globalThis, 'fetch', async (request: Request) => {
    requests.push(request);
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/internal/edge/dinings':
        return Response.json(data.dinings?.get(url.searchParams.get('date')!) ?? []);
      case '/internal/edge/dining-likes':
        return Response.json(data.likes?.get(url.searchParams.get('date')!) ?? []);
      case '/internal/edge/users': {
        const user = data.users?.get(Number(url.searchParams.get('id')));
        return user ? Response.json(user) : Response.json({ error: 'not_found' }, { status: 404 });
      }
      case '/v2/web/auth/session':
      case '/_koin_api/v2/web/auth/session':
        if (data.session) return data.session(request);
        break;
    }
    if (data.other) return data.other(request);
    throw new Error(`Unexpected upstream ${url.pathname}`);
  });
  return requests;
}

export const JWT_TEST_SECRET = 'test-only-java-jwt-secret-of-44-characters!';

export function diningEnv(overrides: Partial<Bindings> = {}): Bindings {
  return {
    ENVIRONMENT: 'preview',
    KOIN_DB_ENABLED: 'true',
    KOIN_DB_BRIDGE_TOKEN: 'test-only-bridge-token-with-32-characters',
    KOIN_JWT_SECRET: JWT_TEST_SECRET,
    AUTH_ALLOWED_ORIGINS: 'https://stage.koreatech.in',
    ...overrides,
  } as Bindings;
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Java JwtProvider.createToken과 같은 키(ASCII(base64(secret)))로 서명한다. */
export async function signToken(
  claims: Record<string, unknown>,
  { secret = JWT_TEST_SECRET, alg = 'HS384', hash = 'SHA-384' } = {},
): Promise<string> {
  const encoder = new TextEncoder();
  const head = base64Url(encoder.encode(JSON.stringify({ typ: 'JWT', alg })));
  const body = base64Url(encoder.encode(JSON.stringify(claims)));
  const key = await crypto.subtle.importKey('raw', encoder.encode(btoa(secret)), { name: 'HMAC', hash }, false, [
    'sign',
  ]);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${head}.${body}`)));
  return `${head}.${body}.${base64Url(signature)}`;
}
