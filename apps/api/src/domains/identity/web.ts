import { and, eq, gt, sql } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { constantTimeEqual, createCsrf, parseRefresh, randomSecret, readAuthCookie, requireCsrf, requireTrustedOrigin, sessionFromAccess, sha256, signJwt, webConfiguration, type WebSession } from '@api/auth';
import { executeAtomic } from '@api/db/client';
import { schema } from '@api/db/schema';
import { fail } from '@api/domains/identity/errors';
import { atomicGuard, loginUser, now, parseBody, type User } from '@api/domains/identity/shared';
import { ApiError } from '@api/errors';
import type { ApiEnv } from '@api/runtime';

interface WebTokens {
  access: string;
  accessExpiresAt: number;
  refresh: string;
  session: WebSession;
  response: { user_type: string; csrf_token: string };
}

export function writeWebCookie(c: Context<ApiEnv>, name: string, value: string, path: string, httpOnly: boolean, expiresAt: number, persistent: boolean): void {
  const config = webConfiguration(c.env);
  const attributes = [`${name}=${value}`, `Path=${path}`, ...(httpOnly ? ['HttpOnly'] : []), ...(config.secure ? ['Secure'] : []), `SameSite=${config.sameSite}`];
  if (path !== '/v2/web/auth' && config.domain) attributes.push(`Domain=${config.domain}`);
  if (persistent) attributes.push(`Max-Age=${Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))}`);
  c.header('Set-Cookie', attributes.join('; '), { append: true });
}

export function clearWebCookies(c: Context<ApiEnv>): void {
  const config = webConfiguration(c.env);
  writeWebCookie(c, config.accessName, '', '/', true, 0, true);
  writeWebCookie(c, config.refreshName, '', '/v2/web/auth', true, 0, true);
  writeWebCookie(c, config.csrfName, '', '/', false, 0, true);
}

async function prepareTokens(c: Context<ApiEnv>, user: User, session: WebSession, refresh: string): Promise<WebTokens> {
  const accessExpiresAt = Math.min(Math.floor((Date.now() + webConfiguration(c.env).accessTtl * 1000) / 1000) * 1000, session.expires_at);
  return { access: await signJwt(c.env, user.id, session.id, accessExpiresAt), accessExpiresAt, refresh, session, response: { user_type: user.user_type, csrf_token: session.csrf_token } };
}

function writeTokens(c: Context<ApiEnv>, tokens: WebTokens): void {
  const config = webConfiguration(c.env);
  writeWebCookie(c, config.accessName, tokens.access, '/', true, tokens.accessExpiresAt, tokens.session.auto_login);
  writeWebCookie(c, config.refreshName, tokens.refresh, '/v2/web/auth', true, tokens.session.expires_at, tokens.session.auto_login);
  writeWebCookie(c, config.csrfName, tokens.session.csrf_token, '/', false, tokens.session.expires_at, tokens.session.auto_login);
}

export function refreshCasStatement(session: WebSession, hash: string, password: string, timestamp: number) {
  return sql`UPDATE identity_web_sessions SET refresh_token_hash = ${hash} WHERE id = ${session.id} AND refresh_token_hash = ${session.refresh_token_hash} AND csrf_token = ${session.csrf_token} AND credential_hash = ${session.credential_hash} AND expires_at = ${session.expires_at} AND expires_at > ${timestamp} AND EXISTS(SELECT 1 FROM users WHERE id = ${session.user_id} AND password = ${password} AND is_deleted = 0)`;
}

export function registerWebAuth(app: Hono<ApiEnv>): void {
  app.use('/v2/web/auth/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    requireTrustedOrigin(c);
    await next();
  });

  app.post('/v2/web/auth/login', async c => {
    const request = await parseBody(c, z.object({ login_id: z.string().min(1).refine(value => value.trim().length > 0 && !/\p{Extended_Pictographic}/u.test(value)), login_pw: z.string().min(1), auto_login: z.boolean().default(false) }));
    const user = await loginUser(c, request.login_id, request.login_pw);
    const id = crypto.randomUUID();
    const refresh = `${id}.${randomSecret()}`;
    const session: WebSession = { id, user_id: user.id, refresh_token_hash: await sha256(refresh), csrf_token: await createCsrf(c.env, id), credential_hash: await sha256(user.password), expires_at: Math.floor((Date.now() + webConfiguration(c.env).refreshTtl * 1000) / 1000) * 1000, auto_login: request.auto_login };
    const tokens = await prepareTokens(c, user, session, refresh);
    await executeAtomic(c.get('db'), [
      ...atomicGuard(sql`EXISTS(SELECT 1 FROM users WHERE id = ${user.id} AND password = ${user.password} AND is_deleted = 0)`),
      sql`INSERT INTO identity_web_sessions (id,user_id,refresh_token_hash,csrf_token,credential_hash,expires_at,auto_login) VALUES (${id},${user.id},${session.refresh_token_hash},${session.csrf_token},${session.credential_hash},${session.expires_at},${session.auto_login ? 1 : 0})`,
      sql`UPDATE users SET last_logged_at = ${now()} WHERE id = ${user.id}`,
    ]);
    writeTokens(c, tokens);
    c.header('Location', '/');
    return c.json(tokens.response, 201);
  });

  app.post('/v2/web/auth/refresh', async c => {
    const refresh = parseRefresh(readAuthCookie(c, webConfiguration(c.env).refreshName));
    const db = c.get('db');
    const [session] = await db.select().from(schema.identity_web_sessions).where(and(eq(schema.identity_web_sessions.id, refresh.id), gt(schema.identity_web_sessions.expires_at, Date.now()))).limit(1);
    if (!session || !constantTimeEqual(session.refresh_token_hash, await sha256(refresh.value))) fail('UNAUTHORIZED_USER');
    await requireCsrf(c.env, session, c.req.header('X-CSRF-Token'));
    const [user] = await db.select().from(schema.users).where(and(eq(schema.users.id, session.user_id), eq(schema.users.is_deleted, false))).limit(1);
    if (!user) fail('UNAUTHORIZED_USER');
    if (!constantTimeEqual(session.credential_hash, await sha256(user.password))) {
      await db.delete(schema.identity_web_sessions).where(and(eq(schema.identity_web_sessions.id, session.id), eq(schema.identity_web_sessions.refresh_token_hash, session.refresh_token_hash)));
      fail('UNAUTHORIZED_USER');
    }
    const next = `${session.id}.${randomSecret()}`;
    const nextHash = await sha256(next);
    const tokens = await prepareTokens(c, user, session, next);
    const [result] = await executeAtomic(db, [refreshCasStatement(session, nextHash, user.password, Date.now())]);
    if (result?.meta.changes !== 1) fail('WEB_AUTH_SESSION_CONFLICT');
    writeTokens(c, tokens);
    c.header('Location', '/');
    return c.json(tokens.response, 201);
  });

  app.post('/v2/web/auth/logout', async c => {
    const value = readAuthCookie(c, webConfiguration(c.env).refreshName);
    if (value?.trim()) {
      const refresh = parseRefresh(value);
      const [session] = await c.get('db').select().from(schema.identity_web_sessions).where(and(eq(schema.identity_web_sessions.id, refresh.id), gt(schema.identity_web_sessions.expires_at, Date.now()))).limit(1);
      if (session) {
        if (!constantTimeEqual(session.refresh_token_hash, await sha256(value))) fail('UNAUTHORIZED_USER');
        await requireCsrf(c.env, session, c.req.header('X-CSRF-Token'));
        const deleted = await c.get('db').delete(schema.identity_web_sessions).where(and(eq(schema.identity_web_sessions.id, session.id), eq(schema.identity_web_sessions.refresh_token_hash, session.refresh_token_hash), eq(schema.identity_web_sessions.csrf_token, session.csrf_token))).returning({ id: schema.identity_web_sessions.id });
        if (deleted.length !== 1) fail('WEB_AUTH_SESSION_CONFLICT');
      }
    }
    clearWebCookies(c);
    return c.body(null, 204);
  });

  app.get('/v2/web/auth/session', async c => {
    const config = webConfiguration(c.env);
    const refreshValue = readAuthCookie(c, config.refreshName);
    const accessValue = readAuthCookie(c, config.accessName);
    let session: WebSession | undefined;
    let rotated = false;
    if (refreshValue?.trim()) {
      try {
        const refresh = parseRefresh(refreshValue);
        const [found] = await c.get('db').select().from(schema.identity_web_sessions).where(and(eq(schema.identity_web_sessions.id, refresh.id), gt(schema.identity_web_sessions.expires_at, Date.now()))).limit(1);
        if (found) {
          if (constantTimeEqual(found.refresh_token_hash, await sha256(refreshValue))) session = found;
          else rotated = true;
        }
      } catch (error) {
        // 형식이 깨진 쿠키는 비로그인으로 취급한다.
        if (!(error instanceof ApiError) || error.status !== 401) throw error;
      }
    }
    if (!session && accessValue?.trim()) {
      try {
        session = await sessionFromAccess(c, accessValue);
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) throw error;
      }
    }
    if (session) {
      const [user] = await c.get('db').select().from(schema.users).where(and(eq(schema.users.id, session.user_id), eq(schema.users.is_deleted, false))).limit(1);
      if (user) {
        writeWebCookie(c, config.csrfName, session.csrf_token, '/', false, session.expires_at, session.auto_login);
        return c.json({ authenticated: true, user_type: user.user_type, csrf_token: session.csrf_token });
      }
      clearWebCookies(c);
    } else if ((refreshValue?.trim() || accessValue?.trim()) && !rotated) clearWebCookies(c);
    return c.json({ authenticated: false, user_type: null, csrf_token: null });
  });
}
