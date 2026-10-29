import { and, eq, isNull, lte, sql, type SQL } from 'drizzle-orm';
import { createDatabase } from '@api/db/client';
import { schema } from '@api/db/schema';
import { handleAdminIdentityJob } from '@api/domains/identity/admins';
import { handleOwnerIdentityJob } from '@api/domains/identity/owners';
import { handleStudentJob } from '@api/domains/identity/students';
import { ApiError } from '@api/errors';
import { sendEmail, sendSlack, sendSms } from '@api/integrations';
import { userVerificationEmail } from '@api/integrations/templates';
import type { Job } from '@api/jobs';
import type { Bindings } from '@api/runtime';

export function identityEvent(kind: string, payload: Record<string, unknown>): { id: string; statement: SQL } {
  const id = crypto.randomUUID();
  return {
    id,
    statement: sql`INSERT INTO identity_outbox (id,kind,payload,created_at,attempts,next_attempt_at) VALUES (${id},${kind},${JSON.stringify(payload)},${Date.now()},0,0)`,
  };
}

export async function signalIdentityEvents(env: Bindings, ids: string[]): Promise<void> {
  if (ids.length)
    await env.JOBS.sendBatch(ids.map((id) => ({ body: { kind: 'identity.outbox', key: id, payload: {} } })));
}

async function deliver(env: Bindings, job: Job): Promise<void> {
  if (job.kind === 'identity.verification.delivery') {
    const { target, code, channel } = job.payload;
    if (typeof target !== 'string' || typeof code !== 'string') throw new Error('Invalid stored verification delivery');
    if (channel === 'SMS') await sendSms(env, { to: target, content: `[KOIN]본인확인 인증번호는 [${code}]입니다.` });
    else if (channel === 'EMAIL') await sendEmail(env, { to: target, ...userVerificationEmail(code) });
    else throw new Error('Invalid stored verification channel');
    return;
  }
  if (job.kind === 'identity.slack') {
    if (!env.SLACK_KOIN_EVENT_NOTIFY_URL)
      throw new ApiError(503, 'INTEGRATION_CONFIGURATION_ERROR', '회원 이벤트 Slack 주소가 설정되지 않았습니다.');
    await sendSlack(env, { webhook: env.SLACK_KOIN_EVENT_NOTIFY_URL, message: String(job.payload.message) });
    return;
  }
  if (
    (await handleStudentJob(env, job)) ||
    (await handleOwnerIdentityJob(env, job)) ||
    (await handleAdminIdentityJob(env, job))
  )
    return;
  throw new Error(`Unsupported identity event: ${job.kind}`);
}

export async function handleIdentityJob(env: Bindings, job: Job): Promise<boolean> {
  if (job.kind !== 'identity.outbox') return false;
  const db = createDatabase(env.DB);
  const current = Date.now();
  const [event] = await db
    .update(schema.identity_outbox)
    .set({ next_attempt_at: current + 60000, attempts: sql`${schema.identity_outbox.attempts} + 1` })
    .where(
      and(
        eq(schema.identity_outbox.id, job.key),
        isNull(schema.identity_outbox.delivered_at),
        lte(schema.identity_outbox.next_attempt_at, current),
      ),
    )
    .returning();
  if (!event) return true;
  try {
    await deliver(env, {
      kind: event.kind,
      key: event.id,
      payload: JSON.parse(event.payload) as Record<string, unknown>,
    });
    await db
      .update(schema.identity_outbox)
      .set({ delivered_at: Date.now() })
      .where(and(eq(schema.identity_outbox.id, event.id), eq(schema.identity_outbox.next_attempt_at, current + 60000)));
  } catch (error) {
    await db
      .update(schema.identity_outbox)
      .set({ next_attempt_at: Date.now() + Math.min(3600000, 1000 * 2 ** Math.min(event.attempts, 12)) })
      .where(and(eq(schema.identity_outbox.id, event.id), eq(schema.identity_outbox.next_attempt_at, current + 60000)));
    throw error;
  }
  return true;
}

export async function runIdentityCron(env: Bindings, scheduledTime: number): Promise<void> {
  if (Math.floor(scheduledTime / 60000) % 5 !== 0) return;
  const db = createDatabase(env.DB);
  if (Math.floor(scheduledTime / 60000) % 60 === 0) {
    await db.batch([
      db.delete(schema.identity_web_sessions).where(lte(schema.identity_web_sessions.expires_at, scheduledTime)),
      db.delete(schema.identity_native_sessions).where(lte(schema.identity_native_sessions.expires_at, scheduledTime)),
      db.delete(schema.identity_verifications).where(lte(schema.identity_verifications.expires_at, scheduledTime)),
      db
        .delete(schema.identity_verification_limits)
        .where(lte(schema.identity_verification_limits.expires_at, scheduledTime)),
      db.delete(schema.identity_tokens).where(lte(schema.identity_tokens.expires_at, scheduledTime)),
    ]);
  }
  const events = await db
    .select({ id: schema.identity_outbox.id })
    .from(schema.identity_outbox)
    .where(and(isNull(schema.identity_outbox.delivered_at), lte(schema.identity_outbox.next_attempt_at, scheduledTime)))
    .orderBy(schema.identity_outbox.created_at)
    .limit(100);
  await signalIdentityEvents(
    env,
    events.map((event) => event.id),
  );
}
