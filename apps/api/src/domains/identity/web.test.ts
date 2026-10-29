import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, describe, it } from 'node:test';
import { URL } from 'node:url';
import { Hono } from 'hono';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import {
  authenticate,
  createCsrf,
  requireCsrf,
  requirePrincipal,
  sha256,
  signJwt,
  verifyJwt,
  webConfiguration,
  type WebSession,
} from '@api/auth';
import { createDatabase, type Database } from '@api/db/client';
import { usesCookieAuthentication } from '@api/domains/identity/auth-policy';
import { encodePassword, passwordChangeStatements } from '@api/domains/identity/shared';
import { refreshCasStatement, registerWebAuth } from '@api/domains/identity/web';
import { ApiError, errorResponse } from '@api/errors';
import type { ApiEnv, Bindings } from '@api/runtime';

const migration = readFileSync(new URL('../../../drizzle/0000_source_and_native.sql', import.meta.url), 'utf8');
const openDatabases: DatabaseSync[] = [];
const dialect = new SQLiteSyncDialect();
const origin = 'https://web.example.test';
const signing = {
  JWT_SECRET: 'test-signing-key-that-remains-identical-to-java',
  WEB_CSRF_SECRET: 'test-csrf-key-at-least-thirty-two-bytes',
  NATIVE_ACCESS_TTL_SECONDS: '6000',
  AUTH_ALLOWED_ORIGINS: JSON.stringify([origin]),
  WEB_COOKIE_SECURE: 'true',
  WEB_COOKIE_DOMAIN: 'example.test',
};

function fixtureBinding(database: DatabaseSync): D1Database {
  function prepared(query: string, parameters: SQLInputValue[] = []) {
    const execute = () => {
      const statement = database.prepare(query);
      const rows = statement.all(...parameters);
      const changes = Number(database.prepare('SELECT changes() AS count').get()!.count);
      return {
        results: rows,
        success: true,
        meta: {
          changes,
          duration: 0,
          last_row_id: 0,
          changed_db: changes > 0,
          size_after: 0,
          rows_read: rows.length,
          rows_written: changes,
        },
      };
    };
    return {
      bind: (...values: SQLInputValue[]) => prepared(query, values),
      all: async () => execute(),
      run: async () => execute(),
      first: async (column?: string) => {
        const row = execute().results[0];
        return row ? (column ? row[column] : row) : null;
      },
      raw: async () => execute().results.map((row) => Object.values(row)),
      execute,
    };
  }
  const binding = {
    prepare: prepared,
    batch: async (queries: { execute: () => unknown }[]) => {
      database.exec('BEGIN');
      try {
        const results = queries.map((query) => query.execute());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    withSession: () => binding,
  };
  return binding as unknown as D1Database;
}

async function fixture() {
  const database = new DatabaseSync(':memory:');
  openDatabases.push(database);
  database.exec('PRAGMA foreign_keys=ON');
  database.exec(migration);
  const password = await encodePassword('password');
  database
    .prepare(
      "INSERT INTO users (id,user_id,password,user_type,is_authed,is_deleted,anonymous_nickname) VALUES (1,'member',?,'STUDENT',1,0,'test-anonymous')",
    )
    .run(password);
  const env = { ...signing, DB: fixtureBinding(database) } as Bindings;
  const app = new Hono<ApiEnv>();
  app.use('*', async (c, next) => {
    c.set('db', createDatabase(c.env.DB));
    c.set('principal', await authenticate(c));
    await next();
  });
  app.onError((error) =>
    errorResponse(error instanceof ApiError ? error : new ApiError(500, 'INTERNAL_SERVER_ERROR', String(error))),
  );
  registerWebAuth(app);
  app.get('/user/auth', (c) => c.json(requirePrincipal(c, ['STUDENT'])));
  app.post('/users/password', (c) => c.json(requirePrincipal(c, ['STUDENT'])));
  app.post('/v2/users/register', (c) => c.json({ public: true }));
  const request = (path: string, init: RequestInit = {}) => app.request(`https://api.example.test${path}`, init, env);
  const login = async (autoLogin = true) => {
    const response = await request('/v2/web/auth/login', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ login_id: 'member', login_pw: 'password', auto_login: autoLogin }),
    });
    assert.equal(response.status, 201);
    const cookies = response.headers.getSetCookie();
    return {
      response,
      cookies,
      cookie: cookies.map((value) => value.split(';')[0]).join('; '),
      body: (await response.json()) as { user_type: string; csrf_token: string },
    };
  };
  return { database, env, request, login };
}

afterEach(() => {
  for (const database of openDatabases.splice(0)) database.close();
});

describe('Java-compatible authentication cryptography', () => {
  it('signs using Base64 text bytes, not decoded or raw secret bytes', async () => {
    const env = signing as Bindings;
    const token = await signJwt(env, 42, undefined, Date.now() + 60000);
    const [header, payload, signature] = token.split('.');
    const algorithm = JSON.parse(Buffer.from(header!, 'base64url').toString()).alg as string;
    const key = Buffer.from(Buffer.from(signing.JWT_SECRET).toString('base64'));
    const expected = createHmac(`sha${algorithm.slice(2)}`, key)
      .update(`${header}.${payload}`)
      .digest('base64url');
    assert.equal(signature, expected);
    assert.equal((await verifyJwt(env, token)).id, 42);
  });
  it('does not allow a web JWT in Authorization or a native JWT as a web cookie', async () => {
    const env = signing as Bindings;
    const web = await signJwt(env, 1, 'web-session', Date.now() + 60000);
    const native = await signJwt(env, 1, undefined, Date.now() + 60000);
    await assert.rejects(verifyJwt(env, web), { code: 'UNAUTHORIZED_USER' });
    await assert.rejects(verifyJwt(env, native, true), { code: 'UNAUTHORIZED_USER' });
  });
  it('binds signed CSRF proof to the exact session and stored nonce', async () => {
    const env = signing as Bindings;
    const csrf = await createCsrf(env, 'session-a');
    const session = { id: 'session-a', csrf_token: csrf } as WebSession;
    await requireCsrf(env, session, csrf);
    const nonce = csrf.slice(0, 43);
    assert.equal(
      csrf.slice(44),
      createHmac('sha256', signing.WEB_CSRF_SECRET)
        .update(`koin-web-csrf:v1!9!session-a!43!${nonce}`)
        .digest('base64url'),
    );
    await assert.rejects(requireCsrf(env, { ...session, id: 'session-b' }, csrf), { code: 'INVALID_CSRF_TOKEN' });
    await assert.rejects(requireCsrf(env, session, await createCsrf(env, session.id)), { code: 'INVALID_CSRF_TOKEN' });
  });
});

describe('web session HTTP state transitions', () => {
  it('shares access and CSRF domain but keeps refresh HttpOnly and API-host scoped', async () => {
    const { login } = await fixture();
    const { cookies, body } = await login();
    assert.deepEqual(Object.keys(body).sort(), ['csrf_token', 'user_type']);
    assert.match(
      cookies[0]!,
      /__Secure-koin-web-access=.*; Path=\/; HttpOnly; Secure; SameSite=Lax; Domain=example.test; Max-Age=/,
    );
    assert.match(
      cookies[1]!,
      /__Secure-koin-web-refresh=.*; Path=\/v2\/web\/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=/,
    );
    assert.doesNotMatch(cookies[1]!, /Domain=/);
    assert.doesNotMatch(cookies[2]!, /HttpOnly/);
    assert.ok((await login(false)).cookies.every((value) => !value.includes('Max-Age=')));
  });
  it('requires origin for reads, CSRF for writes, and never falls back from Authorization', async () => {
    const { login, request } = await fixture();
    const session = await login();
    assert.equal((await request('/user/auth', { headers: { Cookie: session.cookie } })).status, 403);
    assert.equal((await request('/user/auth', { headers: { Origin: origin, Cookie: session.cookie } })).status, 200);
    assert.equal(
      (await request('/users/password', { method: 'POST', headers: { Origin: origin, Cookie: session.cookie } }))
        .status,
      403,
    );
    assert.equal(
      (
        await request('/users/password', {
          method: 'POST',
          headers: { Origin: origin, Cookie: session.cookie, 'X-CSRF-Token': session.body.csrf_token },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await request('/user/auth', {
          headers: { Origin: origin, Cookie: session.cookie, Authorization: 'Bearer invalid' },
        })
      ).status,
      401,
    );
    assert.equal(
      (await request('/v2/users/register', { method: 'POST', headers: { Cookie: session.cookie } })).status,
      200,
    );
  });
  it('rotates refresh once without extending expiry or replacing the CSRF token', async () => {
    const { login, request, database } = await fixture();
    const session = await login();
    const before = database.prepare('SELECT * FROM identity_web_sessions').get()!;
    const refresh = await request('/v2/web/auth/refresh', {
      method: 'POST',
      headers: { Origin: origin, Cookie: session.cookie, 'X-CSRF-Token': session.body.csrf_token },
    });
    assert.equal(refresh.status, 201);
    const after = database.prepare('SELECT * FROM identity_web_sessions').get()!;
    assert.equal(after.expires_at, before.expires_at);
    assert.equal(after.csrf_token, before.csrf_token);
    assert.notEqual(after.refresh_token_hash, before.refresh_token_hash);
    const replay = await request('/v2/web/auth/refresh', {
      method: 'POST',
      headers: { Origin: origin, Cookie: session.cookie, 'X-CSRF-Token': session.body.csrf_token },
    });
    assert.equal(replay.status, 401);
    assert.equal(replay.headers.getSetCookie().length, 0);
  });
  it('does not clear a rotated refresh cookie when another tab has no access cookie', async () => {
    const { login, request } = await fixture();
    const session = await login();
    await request('/v2/web/auth/refresh', {
      method: 'POST',
      headers: { Origin: origin, Cookie: session.cookie, 'X-CSRF-Token': session.body.csrf_token },
    });
    const response = await request('/v2/web/auth/session', {
      headers: { Origin: origin, Cookie: session.cookies[1]!.split(';')[0]! },
    });
    assert.deepEqual(await response.json(), { authenticated: false, user_type: null, csrf_token: null });
    assert.equal(response.headers.getSetCookie().length, 0);
  });
  it('enforces expiry without waiting for cron and rejects duplicate cookie names', async () => {
    const { login, request, database, env } = await fixture();
    const session = await login();
    const name = webConfiguration(env).accessName;
    assert.equal(
      (await request('/user/auth', { headers: { Origin: origin, Cookie: `${session.cookie}; ${name}=duplicate` } }))
        .status,
      401,
    );
    database.prepare('UPDATE identity_web_sessions SET expires_at=?').run(Date.now() - 1);
    assert.equal((await request('/user/auth', { headers: { Origin: origin, Cookie: session.cookie } })).status, 401);
    const response = await request('/v2/web/auth/session', { headers: { Origin: origin, Cookie: session.cookie } });
    assert.equal(((await response.json()) as { authenticated: boolean }).authenticated, false);
    assert.equal(response.headers.getSetCookie().length, 3);
  });
  it('CAS permits only one refresh and cannot resurrect a password-invalidated session', async () => {
    const { login, database } = await fixture();
    await login();
    const row = database.prepare('SELECT * FROM identity_web_sessions').get()!;
    const session = { ...row, auto_login: Boolean(row.auto_login) } as WebSession;
    const password = String(database.prepare('SELECT password FROM users WHERE id=1').get()!.password);
    const query = dialect.sqlToQuery(refreshCasStatement(session, await sha256('next-refresh'), password, Date.now()));
    assert.equal(database.prepare(query.sql).run(...(query.params as SQLInputValue[])).changes, 1);
    assert.equal(database.prepare(query.sql).run(...(query.params as SQLInputValue[])).changes, 0);
    database.exec('BEGIN');
    for (const statement of passwordChangeStatements({} as Database, 1, 'changed')) {
      const compiled = dialect.sqlToQuery(statement);
      database.prepare(compiled.sql).run(...(compiled.params as SQLInputValue[]));
    }
    database.exec('COMMIT');
    assert.equal(database.prepare(query.sql).run(...(query.params as SQLInputValue[])).changes, 0);
    assert.equal(database.prepare('SELECT count(*) AS count FROM identity_web_sessions').get()!.count, 0);
  });
});

it('public source routes do not acquire cookie auth merely because stale credentials exist', () => {
  assert.equal(usesCookieAuthentication('GET', '/shops/12'), false);
  assert.equal(usesCookieAuthentication('GET', '/dinings'), true);
  assert.equal(usesCookieAuthentication('GET', '/articles/lost-item'), true);
  assert.equal(usesCookieAuthentication('POST', '/owners/password/reset/sms'), true);
  assert.equal(usesCookieAuthentication('PUT', '/owners/password/reset/sms'), false);
  assert.equal(usesCookieAuthentication('GET', '/v3/lectures'), false);
});
