import { and, eq, gt, sql, type SQL } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { constantTimeEqual } from '@api/auth';
import { executeAtomic, type Database } from '@api/db/client';
import { schema } from '@api/db/schema';
import { identityEvent, signalIdentityEvents } from '@api/domains/identity/events';
import { atomicGuard, fail, parseBody } from '@api/domains/identity/shared';
import { ApiError } from '@api/errors';
import type { ApiEnv } from '@api/runtime';

const phoneSchema = z.string().regex(/^010[0-9]{8}$/, '올바른 전화번호 형식이 아닙니다.');
const emailSchema = z.string().email('올바른 이메일 형식이 아닙니다.');
const codeSchema = z.string().regex(/^\d{1,6}$/, '인증번호는 6자리 숫자여야 합니다.');

export async function requireVerified(db: Database, target: string): Promise<void> {
  const [verification] = await db
    .select()
    .from(schema.identity_verifications)
    .where(
      and(
        eq(schema.identity_verifications.id, target),
        eq(schema.identity_verifications.verified, true),
        gt(schema.identity_verifications.expires_at, Date.now()),
      ),
    )
    .limit(1);
  if (!verification) fail('FORBIDDEN_VERIFICATION');
}

export async function verificationConsumptionStatements(db: Database, target: string): Promise<SQL[]> {
  await requireVerified(db, target);
  const [verification] = await db
    .select()
    .from(schema.identity_verifications)
    .where(eq(schema.identity_verifications.id, target))
    .limit(1);
  if (!verification) fail('FORBIDDEN_VERIFICATION');
  return [
    ...atomicGuard(
      sql`EXISTS(SELECT 1 FROM identity_verifications WHERE id=${target} AND verified=1 AND code=${verification.code} AND expires_at=${verification.expires_at} AND expires_at>${Date.now()})`,
    ),
    sql`DELETE FROM identity_verifications WHERE id=${target}`,
  ];
}

export async function consumeVerification(db: Database, target: string): Promise<void> {
  try {
    await executeAtomic(db, await verificationConsumptionStatements(db, target));
  } catch (error) {
    if (String(error).includes('identity_atomic_guards')) fail('FORBIDDEN_VERIFICATION');
    throw error;
  }
}

function countKey(c: Context<ApiEnv>, target: string): string {
  const ip = c.req.header('CF-Connecting-IP');
  return ip ? `${target}:${ip}` : target;
}

async function sendVerification(c: Context<ApiEnv>, target: string, channel: 'SMS' | 'EMAIL') {
  const db = c.get('db');
  const maximum = Number(c.env.USER_MAX_VERIFICATION_COUNT ?? 5);
  if (!Number.isInteger(maximum) || maximum < 1)
    throw new ApiError(503, 'AUTH_CONFIGURATION_ERROR', '인증 횟수 제한이 올바르지 않습니다.');
  const key = countKey(c, target);
  const timestamp = Date.now();
  const random = new Uint32Array(1);
  do {
    crypto.getRandomValues(random);
  } while (random[0]! >= 4294000000);
  const code = String(random[0]! % 1000000).padStart(6, '0');
  const event = identityEvent('identity.verification.delivery', { target, code, channel });
  const slack = identityEvent('identity.slack', {
    message: `\`${target}(회원)님이 ${channel === 'SMS' ? '문자' : '이메일'} 인증을 요청하셨습니다.\`\n`,
  });
  let results: D1Result[];
  try {
    results = await executeAtomic(db, [
      ...atomicGuard(
        sql`NOT EXISTS(SELECT 1 FROM identity_verification_limits WHERE id=${key} AND expires_at>${timestamp} AND send_count>=${maximum})`,
      ),
      sql`INSERT INTO identity_verification_limits (id,send_count,verify_count,expires_at) VALUES (${key},1,0,${timestamp + 86400000}) ON CONFLICT(id) DO UPDATE SET send_count=CASE WHEN identity_verification_limits.expires_at>${timestamp} THEN identity_verification_limits.send_count+1 ELSE 1 END,expires_at=CASE WHEN identity_verification_limits.expires_at>${timestamp} THEN identity_verification_limits.expires_at ELSE ${timestamp + 86400000} END RETURNING send_count`,
      sql`INSERT INTO identity_verifications (id,target,channel,code,verified,trial_count,expires_at) VALUES (${target},${target},${channel},${code},0,0,${timestamp + (channel === 'SMS' ? 180000 : 300000)}) ON CONFLICT(id) DO UPDATE SET channel=excluded.channel,code=excluded.code,verified=0,trial_count=0,expires_at=excluded.expires_at`,
      event.statement,
      slack.statement,
    ]);
  } catch (error) {
    if (String(error).includes('identity_atomic_guards')) fail('TOO_MANY_REQUESTS_VERIFICATION');
    throw error;
  }
  await signalIdentityEvents(c.env, [event.id, slack.id]);
  const current = Number((results[2]?.results?.[0] as { send_count: number } | undefined)?.send_count);
  return { target: key, total_count: maximum, remaining_count: maximum - current, current_count: current };
}

async function verifyCode(c: Context<ApiEnv>, target: string, code: string): Promise<void> {
  const db = c.get('db');
  const [verification] = await db
    .select()
    .from(schema.identity_verifications)
    .where(and(eq(schema.identity_verifications.id, target), gt(schema.identity_verifications.expires_at, Date.now())))
    .limit(1);
  if (!verification) throw new ApiError(403, '', `권한이 없습니다. verification: ${target}`);
  if (verification.trial_count >= 10) fail('NOT_MATCHED_VERIFICATION_CODE');
  if (!constantTimeEqual(verification.code, code)) {
    await db
      .update(schema.identity_verifications)
      .set({ trial_count: sql`${schema.identity_verifications.trial_count} + 1` })
      .where(
        and(
          eq(schema.identity_verifications.id, target),
          eq(schema.identity_verifications.code, verification.code),
          gt(schema.identity_verifications.expires_at, Date.now()),
        ),
      );
    fail('NOT_MATCHED_VERIFICATION_CODE');
  }
  try {
    await executeAtomic(db, [
      ...atomicGuard(
        sql`EXISTS(SELECT 1 FROM identity_verifications WHERE id=${target} AND code=${code} AND trial_count<10 AND expires_at>${Date.now()})`,
      ),
      sql`UPDATE identity_verifications SET verified=1,expires_at=${Date.now() + 1800000} WHERE id=${target}`,
      sql`DELETE FROM identity_verification_limits WHERE id=${countKey(c, target)}`,
    ]);
  } catch (error) {
    if (String(error).includes('identity_atomic_guards')) fail('NOT_MATCHED_VERIFICATION_CODE');
    throw error;
  }
}

export function registerVerification(app: Hono<ApiEnv>): void {
  app.post('/users/verification/sms/send', async (c) => {
    const request = await parseBody(c, z.object({ phone_number: phoneSchema }));
    return c.json(await sendVerification(c, request.phone_number, 'SMS'));
  });
  app.post('/users/verification/email/send', async (c) => {
    const request = await parseBody(c, z.object({ email: emailSchema }));
    return c.json(await sendVerification(c, request.email, 'EMAIL'));
  });
  app.post('/users/verification/sms/verify', async (c) => {
    const request = await parseBody(c, z.object({ phone_number: phoneSchema, verification_code: codeSchema }));
    await verifyCode(c, request.phone_number, request.verification_code);
    return c.body(null, 200);
  });
  app.post('/users/verification/email/verify', async (c) => {
    const request = await parseBody(c, z.object({ email: emailSchema, verification_code: codeSchema }));
    await verifyCode(c, request.email, request.verification_code);
    return c.body(null, 200);
  });
}
