import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';

export interface DatabaseEnvironment {
  HYPERDRIVE?: { connectionString: string };
  DATABASE_URL?: string;
  DB_HOST?: string;
  DB_PORT?: string | number;
  DB_USER?: string;
  DB_PASSWORD?: string;
  DB_NAME?: string;
}

export interface DatabaseScope {
  run<T>(callback: () => T): T;
  close(): Promise<void>;
}

interface ScopeState {
  env: DatabaseEnvironment;
  pool?: pg.Pool;
  closed: boolean;
  closing?: Promise<void>;
}

const storage = new AsyncLocalStorage<ScopeState>();

function poolConfig(env: DatabaseEnvironment): pg.PoolConfig {
  const connectionString = env.HYPERDRIVE?.connectionString || env.DATABASE_URL;
  const connection = connectionString
    ? { connectionString }
    : {
        host: env.DB_HOST,
        port: env.DB_PORT === undefined ? 5432 : Number(env.DB_PORT),
        user: env.DB_USER,
        password: env.DB_PASSWORD,
        database: env.DB_NAME,
      };
  if (!connectionString && !env.DB_HOST) {
    throw new Error(
      'Database connection is missing: bind HYPERDRIVE, set DATABASE_URL, or configure DB_HOST/DB_USER/DB_PASSWORD/DB_NAME.',
    );
  }
  return {
    ...connection,
    max: 5,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
  };
}

function currentScope(): ScopeState {
  const state = storage.getStore();
  if (!state) {
    throw new Error('Database access requires createDatabaseScope(env).run(callback).');
  }
  return state;
}

function close(state: ScopeState): Promise<void> {
  if (state.closing) return state.closing;
  state.closed = true;
  state.closing = state.pool ? state.pool.end() : Promise.resolve();
  return state.closing;
}

/** Owns one invocation's connections; close only after its asynchronous work settles. */
export function createDatabaseScope(env: DatabaseEnvironment): DatabaseScope {
  const state: ScopeState = { env, closed: false };
  return {
    run<T>(callback: () => T): T {
      if (state.closed) throw new Error('Cannot run work in a closed database scope.');
      return storage.run(state, callback);
    },
    close: () => close(state),
  };
}

/** Lazily creates the pool in the current request, scheduled event, or queue invocation. */
export function getPool(): pg.Pool {
  const state = currentScope();
  if (state.closed) throw new Error('Cannot use the database after its invocation scope has closed.');
  if (!state.pool) {
    state.pool = new pg.Pool(poolConfig(state.env));
    state.pool.on('error', (error: Error) => {
      console.error('[database] Idle PostgreSQL connection failed:', error);
    });
  }
  return state.pool;
}
