import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, it } from 'node:test';
import { URL } from 'node:url';
import type { SQL } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import type { Database } from '@api/db/client';
import {
  ownerApproveCodeStatements,
  ownerCodeAttemptStatement,
  ownerPasswordResetStatements,
  ownerRegistrationSchema,
  ownerRegistrationStatements,
  ownerSmsStateStatements,
} from '@api/domains/identity/owners';
import { encodePassword, passwordMatches } from '@api/domains/identity/shared';
const migration = readFileSync(new URL('../../../drizzle/0000_source_and_native.sql', import.meta.url), 'utf8');
const dialect = new SQLiteSyncDialect();
const phone = '01012345678';
const proof = 'f1142c6e-191a-4f9b-b253-2ef93e749aa1';
const wrongProof = '26d7cfdd-c6fa-40e1-84be-a46bd9d5299b';
const start = 1_800_000_000_000;
const registration = {
  company_number: '123-45-67890',
  name: '홍길동',
  password: 'owner-password',
  phone_number: phone,
  verification_token: proof,
  shop_name: '우리 가게',
  shop_number: '0411234567',
  attachment_urls: [{ file_url: 'https://static.koreatech.in/owner/license.png' }],
};

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(migration);
  return db;
}

function statement(db: DatabaseSync, query: SQL) {
  const compiled = dialect.sqlToQuery(query);
  return db.prepare(compiled.sql).all(...(compiled.params as SQLInputValue[]));
}

function atomic(db: DatabaseSync, statements: SQL[]): void {
  db.exec('BEGIN');
  try {
    for (const query of statements) statement(db, query);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function count(
  db: DatabaseSync,
  table:
    | 'users'
    | 'owners'
    | 'owner_attachments'
    | 'shops'
    | 'identity_tokens'
    | 'identity_native_sessions'
    | 'identity_web_sessions',
): number {
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()!.count);
}

function token(db: DatabaseSync, id: string) {
  return db.prepare('SELECT payload, expires_at FROM identity_tokens WHERE id = ?').get(id);
}

function approve(db: DatabaseSync, target: string, purpose: 'register' | 'reset', clock: number): void {
  atomic(db, ownerSmsStateStatements(target, '123456', clock, purpose));
  assert.equal(statement(db, ownerCodeAttemptStatement(target, clock, purpose)).length, 1);
  atomic(db, ownerApproveCodeStatements(target, '123456', clock, purpose, proof, String(token(db, `owner_sms:${target}`)!.payload)));
}

describe('owner SMS verification persistence', () => {
  it('allows five requests and rejects the sixth without replacing the last code', () => {
    const db = database();
    try {
      for (let index = 0; index < 5; index += 1)
        atomic(db, ownerSmsStateStatements(phone, String(index).padStart(6, '0'), start + index, 'register'));
      const before = token(db, `owner_sms:${phone}`);
      assert.throws(() => atomic(db, ownerSmsStateStatements(phone, '999999', start + 5, 'register')), /CHECK constraint failed/);
      assert.deepEqual(token(db, `owner_sms:${phone}`), before);
      assert.equal(token(db, `owner_sms_daily:${phone}`)!.payload, '5');
      assert.equal(token(db, `owner_sms_daily:${phone}`)!.expires_at, start + 86_400_000);
    } finally {
      db.close();
    }
  });

  it('resets the counter at the exact 24-hour boundary, not at midnight', () => {
    const db = database();
    try {
      for (let index = 0; index < 5; index += 1) atomic(db, ownerSmsStateStatements(phone, '123456', start + index, 'register'));
      assert.throws(() => atomic(db, ownerSmsStateStatements(phone, '654321', start + 86_400_000 - 1, 'register')));
      atomic(db, ownerSmsStateStatements(phone, '654321', start + 86_400_000, 'register'));
      assert.equal(token(db, `owner_sms_daily:${phone}`)!.payload, '1');
      assert.equal(token(db, `owner_sms_daily:${phone}`)!.expires_at, start + 172_800_000);
    } finally {
      db.close();
    }
  });

  it('preserves leading zeroes, enforces expiry, and caps wrong-code attempts', () => {
    const db = database();
    try {
      atomic(db, ownerSmsStateStatements(phone, '000001', start, 'register'));
      assert.equal(statement(db, ownerCodeAttemptStatement('01000000000', start, 'register')).length, 0);
      assert.equal(statement(db, ownerCodeAttemptStatement(phone, start + 180_000, 'register')).length, 0);
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        assert.equal(statement(db, ownerCodeAttemptStatement(phone, start + attempt, 'register')).length, 1);
        assert.throws(() => atomic(db, ownerApproveCodeStatements(phone, '000002', start + attempt, 'register', proof, String(token(db, `owner_sms:${phone}`)!.payload))));
      }
      assert.equal(statement(db, ownerCodeAttemptStatement(phone, start + 6, 'register')).length, 0);
      assert.equal(token(db, `owner_verified_register:${phone}`), undefined);
    } finally {
      db.close();
    }
  });

  it('invalidates the previous code on resend without resetting the daily quota', () => {
    const db = database();
    try {
      atomic(db, ownerSmsStateStatements(phone, '111111', start, 'register'));
      atomic(db, ownerSmsStateStatements(phone, '222222', start + 100, 'register'));
      assert.equal(statement(db, ownerCodeAttemptStatement(phone, start + 101, 'reset')).length, 0);
      assert.equal(statement(db, ownerCodeAttemptStatement(phone, start + 101, 'register')).length, 1);
      assert.equal(JSON.parse(String(token(db, `owner_sms:${phone}`)!.payload)).code, '222222');
      assert.equal(token(db, `owner_sms_daily:${phone}`)!.payload, '2');
    } finally {
      db.close();
    }
  });

  it('binds one-use approval to phone and purpose and invalidates it on resend', () => {
    const db = database();
    try {
      approve(db, phone, 'register', start);
      assert.equal(token(db, `owner_sms:${phone}`), undefined);
      assert.ok(token(db, `owner_verified_register:${phone}`));
      assert.throws(() => atomic(db, ownerApproveCodeStatements(phone, '123456', start, 'reset', proof, JSON.stringify({ code: '123456', attempts: 1, purpose: 'reset', challenge: proof }))));
      assert.equal(token(db, `owner_verified_reset:${phone}`), undefined);
      assert.throws(() => atomic(db, ownerRegistrationStatements({ ...registration, verification_token: wrongProof }, 'hash', 'owner', start)));
      assert.throws(() => atomic(db, ownerRegistrationStatements({ ...registration, phone_number: '01000000000' }, 'hash', 'owner', start)));
      assert.equal(count(db, 'users'), 0);
      atomic(db, ownerSmsStateStatements(phone, '654321', start + 1, 'register'));
      assert.equal(token(db, `owner_verified_register:${phone}`), undefined);
      assert.throws(() => atomic(db, ownerRegistrationStatements(registration, 'hash', 'owner', start + 2)));
    } finally {
      db.close();
    }
  });
});

describe('owner registration atomicity', () => {
  it('creates pending owner, attachments, and expiring shop metadata without claiming or creating a shop', () => {
    const db = database();
    try {
      approve(db, phone, 'register', start);
      atomic(db, ownerRegistrationStatements(registration, 'encoded-password', 'owner-nickname', start));
      const owner = db
        .prepare(
          'SELECT users.id, users.phone_number, users.email, users.is_authed, users.user_type, owners.account, owners.grant_shop, owners.grant_event FROM users JOIN owners ON users.id = owners.user_id',
        )
        .get()!;
      assert.equal(owner.phone_number, null);
      assert.equal(owner.email, null);
      assert.equal(owner.account, phone);
      assert.equal(owner.is_authed, 0);
      assert.equal(owner.user_type, 'OWNER');
      assert.equal(owner.grant_shop, 0);
      assert.equal(owner.grant_event, 0);
      assert.equal(count(db, 'owner_attachments'), 1);
      assert.equal(count(db, 'shops'), 0);
      const pending = token(db, `owner_shop:${owner.id}`)!;
      assert.deepEqual(JSON.parse(String(pending.payload)), {
        shop_id: null,
        shop_name: registration.shop_name,
        shop_number: registration.shop_number,
      });
      assert.equal(pending.expires_at, start + 86_400_000);
      assert.equal(token(db, `owner_sms:${phone}`), undefined);
      assert.equal(token(db, `owner_verified_register:${phone}`), undefined);
      assert.equal(token(db, `owner_sms_daily:${phone}`)!.payload, '1');
    } finally {
      db.close();
    }
  });

  it('rolls back a newly inserted user when owner account or business number conflicts', () => {
    const db = database();
    try {
      approve(db, phone, 'register', start);
      atomic(db, ownerRegistrationStatements(registration, 'hash', 'first-owner', start));
      approve(db, phone, 'register', start + 1);
      assert.throws(
        () =>
          atomic(
            db,
            ownerRegistrationStatements(
              { ...registration, company_number: '111-22-33333' },
              'hash',
              'duplicate-account',
              start + 1,
            ),
          ),
        /UNIQUE constraint failed/,
      );
      approve(db, '01000000000', 'register', start + 2);
      assert.throws(
        () =>
          atomic(
            db,
            ownerRegistrationStatements(
              { ...registration, phone_number: '01000000000' },
              'hash',
              'duplicate-company',
              start + 2,
            ),
          ),
        /UNIQUE constraint failed/,
      );
      assert.equal(count(db, 'users'), 1);
      assert.equal(count(db, 'owners'), 1);
      assert.equal(count(db, 'owner_attachments'), 1);
    } finally {
      db.close();
    }
  });

  it('leaves all account state untouched when a requested shop does not exist', () => {
    const db = database();
    try {
      approve(db, phone, 'register', start);
      assert.throws(
        () => atomic(db, ownerRegistrationStatements({ ...registration, shop_id: 42 }, 'hash', 'owner', start)),
        /CHECK constraint failed/,
      );
      assert.equal(count(db, 'users'), 0);
      assert.equal(count(db, 'owners'), 0);
      assert.equal(count(db, 'owner_attachments'), 0);
      assert.ok(token(db, `owner_verified_register:${phone}`));
    } finally {
      db.close();
    }
  });

  it('rolls back account and prior attachments if a later attachment violates a database constraint', () => {
    const db = database();
    try {
      const invalid = {
        ...registration,
        attachment_urls: [...registration.attachment_urls, { file_url: null as unknown as string }],
      };
      approve(db, phone, 'register', start);
      assert.throws(
        () => atomic(db, ownerRegistrationStatements(invalid, 'hash', 'owner', start)),
        /NOT NULL constraint failed/,
      );
      assert.equal(count(db, 'users'), 0);
      assert.equal(count(db, 'owners'), 0);
      assert.equal(count(db, 'owner_attachments'), 0);
      assert.ok(token(db, `owner_verified_register:${phone}`));
    } finally {
      db.close();
    }
  });

  it('enforces business number, phone, name, attachment count, and HTTPS attachment constraints', () => {
    assert.equal(ownerRegistrationSchema.safeParse(registration).success, true);
    for (const update of [
      { company_number: '1234567890' },
      { phone_number: '010-1234-5678' },
      { shop_number: '123456789' },
      { name: ' '.repeat(2) },
      { name: '홍'.repeat(51) },
      { attachment_urls: [] },
      { attachment_urls: Array.from({ length: 6 }, () => registration.attachment_urls[0]!) },
      { attachment_urls: [{ file_url: 'http://static.koreatech.in/license.png' }] },
      { attachment_urls: [{ file_url: 'https://example.org/license.png' }] },
      { verification_token: wrongProof.slice(1) },
      { attachment_urls: [{ file_url: 'https://attacker.example/static.koreatech.in/license.png' }] },
      { attachment_urls: [{ file_url: 'not-a-url' }] },
      { attachment_urls: [{ file_url: 'https://static.koreatech.in.attacker.example/license.png' }] },
    ])
      assert.equal(ownerRegistrationSchema.safeParse({ ...registration, ...update }).success, false);
  });
});

describe('owner password reset', () => {
  it('strips hyphens and invalidates native and web sessions atomically', async () => {
    const db = database();
    try {
      approve(db, phone, 'register', start);
      atomic(db, ownerRegistrationStatements(registration, 'old-password', 'owner', start));
      const id = Number(db.prepare('SELECT user_id FROM owners WHERE account = ?').get(phone)!.user_id);
      db.prepare('INSERT INTO identity_native_sessions (id,user_id,platform,token,expires_at) VALUES (?,?,?,?,?)').run(
        'native',
        id,
        'PC',
        'refresh',
        start + 1000,
      );
      db.prepare(
        'INSERT INTO identity_web_sessions (id,user_id,refresh_token_hash,csrf_token,credential_hash,expires_at) VALUES (?,?,?,?,?,?)',
      ).run('web', id, 'refresh-hash', 'csrf', 'old-password', start + 1000);
      const hash = await encodePassword('new-password', true);
      approve(db, phone, 'reset', start + 1);
      assert.throws(() => atomic(db, ownerPasswordResetStatements(undefined as unknown as Database, phone, id, hash, start + 1, wrongProof)));
      assert.throws(() => atomic(db, ownerPasswordResetStatements(undefined as unknown as Database, phone, id, hash, start + 180_001, proof)));
      assert.equal(String(db.prepare('SELECT password FROM users WHERE id=?').get(id)!.password), 'old-password');
      atomic(db, ownerPasswordResetStatements(undefined as unknown as Database, phone, id, hash, start + 1, proof));
      assert.throws(() => atomic(db, ownerPasswordResetStatements(undefined as unknown as Database, phone, id, hash, start + 1, proof)));
      assert.equal(
        await passwordMatches(
          'newpassword',
          String(db.prepare('SELECT password FROM users WHERE id = ?').get(id)!.password),
        ),
        true,
      );
      assert.equal(await passwordMatches('new-password', hash), false);
      assert.equal(count(db, 'identity_native_sessions'), 0);
      assert.equal(count(db, 'identity_web_sessions'), 0);
      assert.equal(db.prepare('SELECT phone_number FROM users WHERE id = ?').get(id)!.phone_number, null);
    } finally {
      db.close();
    }
  });
});
