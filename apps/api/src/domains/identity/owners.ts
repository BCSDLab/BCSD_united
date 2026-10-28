import { and, eq, gt, sql, type SQL } from 'drizzle-orm';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { requirePrincipal, signJwt } from '@api/auth';
import { executeAtomic, type Database } from '@api/db/client';
import { schema } from '@api/db/schema';
import { identityEvent, signalIdentityEvents } from '@api/domains/identity/events';
import {
  anonymousNickname,
  atomicGuard,
  encodePassword,
  fail,
  issueNativeTokens,
  parseBody,
  passwordChangeStatements,
  passwordMatches,
  requireUser,
} from '@api/domains/identity/shared';
import { ApiError } from '@api/errors';
import { sendSlack, sendSms } from '@api/integrations';
import type { Job } from '@api/jobs';
import type { ApiEnv, Bindings } from '@api/runtime';

const nonBlank = z.string().refine((value) => value.trim().length > 0, '필수 입력값입니다.');
const phone = z.string().regex(/^\d{11}$/, '전화번호 형식이 올바르지 않습니다. 11자리 숫자로 입력해 주세요.');
const companyNumber = z.string().regex(/^\d{3}-\d{2}-\d{5}$/, '사업자 등록 번호 형식이 올바르지 않습니다.');
const phoneRequest = z.object({ phone_number: phone });
const verificationRequest = phoneRequest.extend({ certification_code: z.string().regex(/^[+-]?\d{1,6}$/, '인증 코드는 6자리 정수여야 합니다.') });
export const ownerRegistrationSchema = z.object({
  company_number: companyNumber,
  name: nonBlank.refine((value) => value.length <= 50, '이름은 50자 이내여야 합니다.'),
  password: nonBlank,
  phone_number: phone,
  shop_id: z.number().int().nullable().optional(),
  shop_name: nonBlank,
  shop_number: z.string().regex(/^\d{10,11}$/, '가게 전화번호 형식이 올바르지 않습니다. 10~11자리 숫자로 입력해 주세요.'),
  attachment_urls: z.array(z.object({
    file_url: z.string().url().refine((value) => value.startsWith('https:') && /static\.koreatech\.in/.test(value), '코인 파일 저장 형식이 아닙니다.'),
  })).min(1).max(5),
});

type OwnerRegistration = z.infer<typeof ownerRegistrationSchema>;
const SMS_LIFETIME = 180_000;
const DAILY_LIFETIME = 86_400_000;

function duplicatePhone(): never {
  throw new ApiError(409, 'DUPLICATE_PHONE_NUMBER', '이미 존재하는 휴대폰번호입니다.');
}

function duplicateCompany(): never {
  throw new ApiError(409, 'DUPLICATE_COMPANY_NUMBER', '이미 존재하는 사업자 등록번호입니다.');
}

function ownerNotFound(): never {
  throw new ApiError(404, 'NOT_FOUND_OWNER', '존재하지 않는 사장님입니다.');
}

function missingVerification(): never {
  throw new ApiError(404, 'NOT_FOUND_VERIFICATION', '존재하지 않는 인증정보입니다.');
}

function dailyLimit(): never {
  throw new ApiError(400, 'ILLEGAL_ARGUMENT', '하루 인증 최대 횟수 초과');
}

function errorChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    parts.push(current.message);
    current = current.cause;
  }
  return parts.join(' ');
}

function isGuardFailure(error: unknown): boolean {
  const message = errorChain(error);
  return message.includes('CHECK constraint failed') && (message.includes('allowed') || message.includes('identity_atomic_guards'));
}

async function ownerByAccount(db: Database, account: string) {
  const [owner] = await db.select().from(schema.owners).where(eq(schema.owners.account, account)).limit(1);
  if (!owner) ownerNotFound();
  return { owner, user: await requireUser(db, owner.user_id) };
}

async function requireAvailableAccount(db: Database, account: string): Promise<void> {
  const [existing] = await db.select({ id: schema.owners.user_id }).from(schema.owners).where(eq(schema.owners.account, account)).limit(1);
  if (existing) duplicatePhone();
}

async function requireAvailableCompany(db: Database, company: string): Promise<void> {
  const [existing] = await db.select({ id: schema.owners.user_id }).from(schema.owners).where(eq(schema.owners.company_registration_number, company)).limit(1);
  if (existing) duplicateCompany();
}

function newCertificationCode(): string {
  const sample = new Uint32Array(1);
  do { crypto.getRandomValues(sample); } while (sample[0]! >= 4_294_000_000);
  return String(sample[0]! % 1_000_000).padStart(6, '0');
}

export function ownerSmsStateStatements(target: string, code: string, clock: number): SQL[] {
  const dailyId = `owner_sms_daily:${target}`;
  return [
    ...atomicGuard(sql`NOT EXISTS (SELECT 1 FROM identity_tokens WHERE id = ${dailyId} AND expires_at > ${clock} AND CAST(payload AS INTEGER) >= 5)`),
    sql`INSERT INTO identity_tokens (id, kind, target, payload, expires_at)
      VALUES (${dailyId}, 'owner_sms_daily', ${target}, '1', ${clock + DAILY_LIFETIME})
      ON CONFLICT (id) DO UPDATE SET
        payload = CASE WHEN identity_tokens.expires_at <= ${clock} THEN '1' ELSE CAST(CAST(identity_tokens.payload AS INTEGER) + 1 AS TEXT) END,
        expires_at = CASE WHEN identity_tokens.expires_at <= ${clock} THEN ${clock + DAILY_LIFETIME} ELSE identity_tokens.expires_at END`,
    sql`INSERT INTO identity_tokens (id, kind, target, payload, expires_at)
      VALUES (${`owner_sms:${target}`}, 'owner_sms', ${target}, ${JSON.stringify({ code })}, ${clock + SMS_LIFETIME})
      ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, payload = excluded.payload, expires_at = excluded.expires_at`,
  ];
}

export function ownerVerifyCodeStatement(target: string, code: string, clock: number): SQL {
  return sql`SELECT id FROM identity_tokens
    WHERE id = ${`owner_sms:${target}`} AND kind = 'owner_sms' AND target = ${target} AND expires_at > ${clock}
      AND json_extract(payload, '$.code') = ${code}`;
}

export function ownerRegistrationStatements(request: OwnerRegistration, passwordHash: string, nickname: string, clock: number): SQL[] {
  const ownerId = sql`(SELECT user_id FROM owners WHERE account = ${request.phone_number})`;
  return [
    ...(request.shop_id == null ? [] : atomicGuard(sql`EXISTS (SELECT 1 FROM shops WHERE id = ${request.shop_id} AND is_deleted = 0)`)),
    sql`INSERT INTO users (password, name, anonymous_nickname, user_type, is_authed, is_deleted)
      VALUES (${passwordHash}, ${request.name}, ${nickname}, 'OWNER', 0, 0)`,
    sql`INSERT INTO owners (user_id, company_registration_number, grant_shop, grant_event, account)
      VALUES (last_insert_rowid(), ${request.company_number}, 0, 0, ${request.phone_number})`,
    ...request.attachment_urls.map(({ file_url }) => sql`INSERT INTO owner_attachments (owner_id, url, is_deleted) VALUES (${ownerId}, ${file_url}, 0)`),
    sql`INSERT INTO identity_tokens (id, kind, target, user_id, payload, expires_at)
      SELECT 'owner_shop:' || user_id, 'owner_shop', CAST(user_id AS TEXT), user_id,
        ${JSON.stringify({ shop_id: request.shop_id ?? null, shop_name: request.shop_name, shop_number: request.shop_number })}, ${clock + DAILY_LIFETIME}
      FROM owners WHERE account = ${request.phone_number}`,
    sql`DELETE FROM identity_tokens WHERE id = ${`owner_sms:${request.phone_number}`}`,
  ];
}

async function sendCertification(c: Context<ApiEnv>, target: string): Promise<void> {
  const code = newCertificationCode();
  const sms = identityEvent('identity.owner.sms', { to: target, code });
  const slack = identityEvent('identity.owner.slack', { type: 'verification', phone: target });
  try {
    await executeAtomic(c.get('db'), [
      ...ownerSmsStateStatements(target, code, Date.now()), sms.statement, slack.statement,
    ]);
  } catch (error) {
    if (isGuardFailure(error)) dailyLimit();
    throw error;
  }
  await signalIdentityEvents(c.env, [sms.id, slack.id]);
}

async function verifyCode(db: Database, target: string, code: string): Promise<void> {
  const clock = Date.now();
  const [result] = await executeAtomic(db, [ownerVerifyCodeStatement(target, code, clock)]);
  if (result?.results?.length) return;
  const [token] = await db.select({ id: schema.identity_tokens.id }).from(schema.identity_tokens)
    .where(and(eq(schema.identity_tokens.id, `owner_sms:${target}`), eq(schema.identity_tokens.kind, 'owner_sms'), gt(schema.identity_tokens.expires_at, clock))).limit(1);
  if (!token) missingVerification();
  throw new ApiError(400, 'ILLEGAL_ARGUMENT', '인증번호가 일치하지 않습니다.');
}

export async function handleOwnerIdentityJob(env: Bindings, job: Job): Promise<boolean> {
  if (job.kind === 'identity.owner.sms') {
    const { to, code } = job.payload;
    if (typeof to !== 'string' || typeof code !== 'string') throw new TypeError('Invalid owner SMS event');
    await sendSms(env, { to, content: `[KOIN]본인확인 인증번호는 [${code}]입니다.` });
    return true;
  }
  if (job.kind === 'identity.owner.slack') {
    if (!env.SLACK_OWNER_EVENT_WEBHOOK_URL) throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', 'Owner Slack webhook is not configured.');
    let message: string;
    if (job.payload.type === 'verification' && typeof job.payload.phone === 'string') {
      message = `\`${job.payload.phone}(사장님)님이 문자 인증을 요청하셨습니다.\`\n`;
    } else if (job.payload.type === 'registration' && typeof job.payload.name === 'string' && typeof job.payload.shop_name === 'string') {
      if (!env.KOIN_ADMIN_SHOP_URL) throw new ApiError(503, 'INTEGRATION_NOT_CONFIGURED', 'Owner admin shop URL is not configured.');
      message = `\`${job.payload.name}\`님이 가입 승인을 기다리고 있어요!\n가게 정보: \`${job.payload.shop_name}\`\n<${env.KOIN_ADMIN_SHOP_URL}|Admin page 바로가기>\n`;
    } else {
      throw new TypeError('Invalid owner Slack event');
    }
    await sendSlack(env, { webhook: env.SLACK_OWNER_EVENT_WEBHOOK_URL, message });
    return true;
  }
  return false;
}

export function registerOwners(app: Hono<ApiEnv>): void {
  app.get('/owner', async (c) => {
    const { id } = requirePrincipal(c, ['OWNER']);
    const db = c.get('db');
    const [owner] = await db.select().from(schema.owners).where(eq(schema.owners.user_id, id)).limit(1);
    if (!owner) ownerNotFound();
    const user = await requireUser(db, id);
    const [attachments, shops] = await Promise.all([
      db.select().from(schema.owner_attachments).where(and(eq(schema.owner_attachments.owner_id, id), eq(schema.owner_attachments.is_deleted, false))),
      db.select({ id: schema.shops.id, name: schema.shops.name }).from(schema.shops).where(and(eq(schema.shops.owner_id, id), eq(schema.shops.is_deleted, false))),
    ]);
    return c.json({ email: user.email, name: user.name, company_number: owner.company_registration_number, account: owner.account,
      attachments: attachments.map((attachment) => {
        const separator = attachment.url.lastIndexOf('/');
        if (separator < 0) throw new ApiError(404, 'NOT_FOUND_ATTACHMENT', '존재하지 않는 첨부파일입니다.');
        return { id: attachment.id, file_url: attachment.url, file_name: attachment.url.slice(separator + 1) };
      }), shops });
  });

  app.post('/owners/exists/company-number', async (c) => {
    const request = await parseBody(c, z.object({ company_number: companyNumber }));
    await requireAvailableCompany(c.get('db'), request.company_number);
    return c.body(null, 200);
  });

  app.get('/owner/registered-store', async (c) => {
    const { id } = requirePrincipal(c, ['OWNER']);
    const [token] = await c.get('db').select().from(schema.identity_tokens)
      .where(and(eq(schema.identity_tokens.id, `owner_shop:${id}`), eq(schema.identity_tokens.kind, 'owner_shop'), gt(schema.identity_tokens.expires_at, Date.now()))).limit(1);
    if (!token?.payload) return c.json({ shop_name: '', shop_number: '' });
    const state = z.object({ shop_name: z.string().nullable(), shop_number: z.string().nullable() }).parse(JSON.parse(token.payload));
    return c.json(state);
  });

  app.post('/owner/login', async (c) => {
    const request = await parseBody(c, z.object({ account: phone, password: nonBlank }));
    const { user } = await ownerByAccount(c.get('db'), request.account);
    if (!await passwordMatches(request.password, user.password)) fail('NOT_MATCHED_PASSWORD');
    if (!user.is_authed) throw new ApiError(403, 'FORBIDDEN_OWNER', '미인증 상태입니다. 인증을 진행해주세요.');
    const response = await issueNativeTokens(c, user);
    c.header('Location', '/');
    return c.json(response, 201);
  });

  app.post('/owners/register/phone', async (c) => {
    const request = await parseBody(c, ownerRegistrationSchema);
    const db = c.get('db');
    await requireAvailableAccount(db, request.phone_number);
    await requireAvailableCompany(db, request.company_number);
    if (request.shop_id != null) {
      const [shop] = await db.select({ id: schema.shops.id }).from(schema.shops).where(and(eq(schema.shops.id, request.shop_id), eq(schema.shops.is_deleted, false))).limit(1);
      if (!shop) fail('NOT_FOUND_SHOP');
    }
    const hash = await encodePassword(request.password);
    const event = identityEvent('identity.owner.slack', { type: 'registration', name: request.name, shop_name: request.shop_name });
    try {
      await executeAtomic(db, [...ownerRegistrationStatements(request, hash, anonymousNickname(), Date.now()), event.statement]);
    } catch (error) {
      if (isGuardFailure(error)) fail('NOT_FOUND_SHOP');
      const message = errorChain(error);
      if (message.includes('owners.account')) duplicatePhone();
      if (message.includes('owners.company_registration_number')) duplicateCompany();
      throw error;
    }
    await signalIdentityEvents(c.env, [event.id]);
    return c.body(null, 200);
  });

  app.post('/owners/verification/sms', async (c) => {
    const request = await parseBody(c, phoneRequest);
    await requireAvailableAccount(c.get('db'), request.phone_number);
    await sendCertification(c, request.phone_number);
    return c.body(null, 200);
  });

  app.post('/owners/verification/code/sms', async (c) => {
    const request = await parseBody(c, verificationRequest);
    await verifyCode(c.get('db'), request.phone_number, request.certification_code);
    return c.json({ token: await signJwt(c.env, 0) });
  });

  app.post('/owners/password/reset/verification/sms', async (c) => {
    const request = await parseBody(c, phoneRequest);
    await ownerByAccount(c.get('db'), request.phone_number);
    await sendCertification(c, request.phone_number);
    return c.body(null, 200);
  });

  app.post('/owners/password/reset/send/sms', async (c) => {
    const request = await parseBody(c, verificationRequest);
    await verifyCode(c.get('db'), request.phone_number, request.certification_code);
    return c.body(null, 200);
  });

  app.put('/owners/password/reset/sms', async (c) => {
    const request = await parseBody(c, phoneRequest.extend({ password: nonBlank }));
    const db = c.get('db');
    const { user } = await ownerByAccount(db, request.phone_number);
    const hash = await encodePassword(request.password, true);
    await executeAtomic(db, passwordChangeStatements(db, user.id, hash));
    return c.body(null, 200);
  });

  app.get('/owners/exists/account', async (c) => {
    const result = phone.safeParse(c.req.query('account'));
    if (!result.success) throw new ApiError(400, 'INVALID_REQUEST_BODY', '전화번호 형식이 올바르지 않습니다. 11자리 숫자로 입력해 주세요.');
    await requireAvailableAccount(c.get('db'), result.data);
    return c.body(null, 200);
  });
}
