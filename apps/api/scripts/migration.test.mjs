import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mysqlValue, signed64, utcTimestamp, rowInsert, parseLossless, normalizeUnicodeKey, mergeChatMessage, D1_MAX_ROW_BYTES } from './transform.mjs';
import { mongoRows, redisRows } from './state-adapters.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = JSON.parse(readFileSync(resolve(root, 'scripts/source-schema.json'), 'utf8'));
function database() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON;');
  for (const file of readdirSync(resolve(root, 'drizzle')).filter(name => /^\d+.*\.sql$/.test(name)).sort()) db.exec(readFileSync(resolve(root, 'drizzle', file), 'utf8'));
  return db;
}

test('all 165 source tables execute and preserve exact table names', () => {
  const db = database();
  try {
    assert.equal(source.tables.length, 165);
    const names = new Set(db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row => row.name));
    for (const table of source.tables) assert.ok(names.has(table.name), table.name);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('signed64 values roundtrip beyond JS precision and SQL increments remain exact', () => {
  const db = database();
  try {
    db.prepare('UPDATE dining_soldout_report_sequence SET last_sequence=? WHERE id=1').run('9007199254740993');
    db.exec('UPDATE dining_soldout_report_sequence SET last_sequence=CAST(CAST(last_sequence AS INTEGER)+1 AS TEXT) WHERE id=1');
    assert.equal(db.prepare('SELECT last_sequence FROM dining_soldout_report_sequence WHERE id=1').get().last_sequence, '9007199254740994');
    assert.throws(() => db.prepare('UPDATE dining_soldout_report_sequence SET last_sequence=? WHERE id=1').run('9223372036854775808'));
    assert.equal(signed64('9223372036854775807'), '9223372036854775807');
    assert.throws(() => signed64(9007199254740992));
    assert.throws(() => signed64('01'));
    assert.equal(parseLossless('{"id":9223372036854775807}').id, '9223372036854775807');
  } finally { db.close(); }
});

test('generated nullable-major key enforces academic catalog uniqueness', () => {
  const db = database();
  try {
    db.exec("INSERT INTO department(id,name) VALUES(1,'기계공학부'); INSERT INTO academic_program_year(student_year,department_id,major_id) VALUES('2026',1,NULL);");
    assert.equal(db.prepare('SELECT major_key FROM academic_program_year').get().major_key, 0);
    assert.throws(() => db.exec("INSERT INTO academic_program_year(student_year,department_id,major_id) VALUES('2026',1,NULL)"));
    assert.throws(() => db.exec("INSERT INTO academic_program_year(student_year,department_id,major_id) VALUES('2026',999,NULL)"));
  } finally { db.close(); }
});

test('foreign-key cascade and timestamp ON UPDATE execute in SQLite', () => {
  const db = database();
  try {
    db.exec("INSERT INTO department_contact_departments(id,category,name,display_order,updated_at) VALUES(1,'ACADEMIC','test',1,'2000-01-01 00:00:00'); INSERT INTO department_contacts(department_id,phone_number,display_order) VALUES(1,'041-000-0000',1);");
    db.exec("UPDATE department_contact_departments SET name='changed' WHERE id=1");
    assert.notEqual(db.prepare('SELECT updated_at FROM department_contact_departments WHERE id=1').get().updated_at, '2000-01-01 00:00:00');
    db.exec('DELETE FROM department_contact_departments WHERE id=1');
    assert.equal(db.prepare('SELECT count(*) AS count FROM department_contacts').get().count, 0);
  } finally { db.close(); }
});

test('failed atomic assertions roll back earlier business writes', () => {
  const db = database();
  try {
    db.exec('BEGIN');
    assert.throws(() => db.exec("INSERT INTO native_callvan_guard(id) VALUES('uncommitted'); INSERT INTO identity_atomic_guards(id,allowed) VALUES('guard',0)"));
    db.exec('ROLLBACK');
    assert.equal(db.prepare('SELECT count(*) AS count FROM native_callvan_guard').get().count, 0);
    assert.throws(() => db.exec("INSERT INTO identity_verification_limits(id,send_count,verify_count,expires_at) VALUES('fraction',1.2,0,1900000000000)"));
    db.exec("INSERT INTO identity_verification_limits(id,send_count,verify_count,expires_at) VALUES('epoch',0,0,1900000000000)");
  } finally { db.close(); }
});

test('binary UUID and decimal transforms are lossless', () => {
  const binary = { type: 'binary', name: 'id', length: 16 };
  assert.equal(mysqlValue(binary, { $binary: Buffer.from('00112233445566778899aabbccddeeff', 'hex').toString('base64') }, '+09:00'), '00112233-4455-6677-8899-aabbccddeeff');
  assert.equal(mysqlValue({ type: 'decimal', scale: 8 }, '127.12345678', '+09:00'), '127.12345678');
  assert.throws(() => mysqlValue(binary, { $binary: 'AA==' }, '+09:00'));
  assert.equal(utcTimestamp('2026-10-28 00:00:00.123456', '+09:00'), '2026-10-27 15:00:00.123456');
  assert.equal(utcTimestamp('2026-10-28T00:00:00.123456Z', '+09:00'), '2026-10-28 00:00:00.123456');
});

test('normalization registry keeps display spelling and catches normalized collision', () => {
  const db = database();
  try {
    const first = normalizeUnicodeKey('Straße ', 'utf8mb4_unicode_ci');
    const second = normalizeUnicodeKey('STRASSE', 'utf8mb4_unicode_ci');
    assert.equal(first, second);
    assert.notEqual(normalizeUnicodeKey('a ', 'utf8mb4_0900_ai_ci'), normalizeUnicodeKey('a', 'utf8mb4_0900_ai_ci'));
    db.prepare('INSERT INTO native_collation_key(scope,owner,normalized) VALUES(?,?,?)').run('users:nickname','[1]',first);
    assert.throws(() => db.prepare('INSERT INTO native_collation_key(scope,owner,normalized) VALUES(?,?,?)').run('users:nickname','[2]',second));
  } finally { db.close(); }
});

test('Mongo and Redis chat reconciliation merges monotonic flags but rejects immutable conflicts', () => {
  const original = { id: '9007199254740993', article_id: 1, chatroom_id: 2, user_id: 3, is_read: 0, is_deleted: 0, is_image: null, nick_name: null, contents: 'found', created_at: '2026-10-27T15:00:00Z' };
  const merged = mergeChatMessage(original, { ...original, is_read: 1, is_deleted: 1, is_image: 0 });
  assert.equal(merged.is_read, 1); assert.equal(merged.is_deleted, 1); assert.equal(merged.is_image, 0);
  assert.throws(() => mergeChatMessage(original, { ...original, contents: 'different' }));
  const result = mongoRows('lost_item_chat_room', { _id: { $oid: 'a' }, article_id: 1, chatroom_id: 2, article_author_id: 3, item_owner_id: 4, created_at: '2026-10-28T00:00:00', messages: [{ tsid: '9007199254740993', user_id: 3, is_read: false, is_deleted: false, nickname: null, contents: 'found', created_at: '2026-10-28T00:00:00' }] }, { offset: '+09:00' });
  assert.equal(result[1].row.id, original.id); assert.equal(result[1].row.created_at, original.created_at);
});

test('TTL expiry is explicit and unknown live Redis keys stop conversion', () => {
  const record = { key: 'unsupported-live-key', type: 'string', capturedAt: 1000, expiresAt: 2000, value: { base64: Buffer.from('payload').toString('base64') } };
  assert.throws(() => redisRows(record, { now: 1000, offset: '+09:00' }), /Unmapped live Redis key/);
  const expired = redisRows(record, { now: 2001, offset: '+09:00' });
  assert.equal(expired.disposition, 'expired-archived'); assert.equal(expired.rows.length, 1);
  assert.throws(() => rowInsert('large', { content: 'x'.repeat(D1_MAX_ROW_BYTES + 1) }), /2MiB/);
  assert.throws(() => rowInsert('large', { content: 'x'.repeat(100001) }), /100KB/);
});

test('complete snapshot conversion reconciles chat, preserves sessions and emits resumable FK-ordered data', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'koin-d1-migration-'));
  const input = resolve(directory, 'snapshot');
  const output = resolve(directory, 'converted');
  mkdirSync(input);
  const manifest = { format: 1, sourceCommit: source.sourceCommit, complete: true, quiesced: true, mysqlSessionTimezone: '+00:00', startedAt: '2026-10-28T00:00:00Z', completedAt: '2026-10-28T00:00:01Z', redisCompletedAt: '2026-10-28T00:00:01Z', files: [] };
  const append = (name, origin, records) => {
    const content = records.map(record => JSON.stringify(record) + '\n').join('');
    writeFileSync(resolve(input, name), content);
    manifest.files.push({ name, source: origin, count: records.length, bytes: Buffer.byteLength(content), sha256: createHash('sha256').update(content).digest('hex') });
  };
  try {
    for (const table of source.tables) {
      const records = [];
      if (table.name === 'users') {
        const row = Object.fromEntries(source.columns.filter(column => column.table === 'users').map(column => [column.name, column.default === 'CURRENT_TIMESTAMP' ? '2026-10-28 00:00:00' : column.default]));
        Object.assign(row, { id: 1, password: 'fixture-password', user_type: 'GENERAL', anonymous_nickname: 'fixture-user' });
        records.push(row);
      }
      if (table.name === 'dining_soldout_report_sequence') records.push({ id: 1, last_sequence: '9007199254740993', delivery_cooldown_until: null });
      append(`${table.name}.mysql.jsonl`, `mysql:${table.name}`, records);
    }
    const mongoMessage = { tsid: '9007199254740993', user_id: 1, is_read: false, is_deleted: false, nickname: '123', contents: 'null', created_at: { $date: '2026-10-27T15:00:00.123Z' } };
    for (const collection of ['citybus_timetables','shuttlebus_timetables','lost_item_chat_room','lost_item_chat_user_block','address_byeongcheon']) append(`${collection}.mongo.jsonl`, `mongo:${collection}`, collection === 'lost_item_chat_room' ? [{ _id: { $oid: '012345678901234567890123' }, article_id: 10, chatroom_id: 20, article_author_id: 1, item_owner_id: 2, created_at: { $date: '2026-10-27T15:00:00Z' }, messages: [mongoMessage] }] : []);
    const binary = value => ({ base64: Buffer.from(value).toString('base64') });
    const redisMessage = { id: '9007199254740993', articleId: 10, chatRoomId: 20, userId: 1, isRead: true, isDeleted: false, isImage: false, nickName: '123', contents: 'null', createdAt: '2026-10-28T00:00:00.123456' };
    append('redis.jsonl', 'redis', [
      { key: 'webAuthSession:fixture-session', type: 'string', capturedAt: 1793145600000, expiresAt: 1893456000000, value: binary(JSON.stringify({ id: 'fixture-session', userId: 1, refreshTokenHash: 'refresh-hash', csrfToken: 'csrf-value', credentialHash: 'credential-hash', expiresAt: '2030-01-01T00:00:00Z', autoLogin: true })) },
      { key: 'article:10:chatroom:20:message', type: 'zset', capturedAt: 1793145600000, expiresAt: null, value: [binary(JSON.stringify('900719925474:0993|' + JSON.stringify(redisMessage))), binary('0')] },
    ]);
    writeFileSync(resolve(input, 'manifest.json'), JSON.stringify(manifest));
    const result = spawnSync(process.execPath, [resolve(root, 'scripts/convert-snapshot.mjs'), input, output, '+09:00'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const converted = JSON.parse(readFileSync(resolve(output, 'manifest.json'), 'utf8'));
    assert.equal(converted.complete, true);
    assert.equal(converted.foreignKeyViolations, 0);
    const db = new DatabaseSync(resolve(output, 'validated.sqlite'));
    try {
      assert.equal(db.prepare('SELECT last_sequence FROM dining_soldout_report_sequence').get().last_sequence, '9007199254740993');
      assert.equal(db.prepare('SELECT auto_login FROM identity_web_sessions').get().auto_login, 1);
      const chat = db.prepare('SELECT * FROM native_chat_message').get();
      assert.equal(chat.contents, 'null');
      assert.equal(chat.nick_name, '123');
      assert.equal(chat.is_read, 1);
      assert.equal(chat.created_at, '2026-10-27T15:00:00.123456Z');
      assert.equal(db.prepare('SELECT count(*) AS count FROM native_legacy_mongo').get().count, 1);
      assert.equal(db.prepare('SELECT count(*) AS count FROM native_legacy_redis').get().count, 2);
    } finally { db.close(); }
    assert.ok(converted.files.some(file => file.kind === 'schema' && file.schemaHash));
    assert.ok(converted.files.filter(file => file.kind === 'data').every(file => file.dataHash && file.sha256));
    const incompleteSequence = JSON.stringify({ id: 1, last_sequence: '9007199254740993' }) + '\n';
    const sequenceFile = manifest.files.find(file => file.source === 'mysql:dining_soldout_report_sequence');
    writeFileSync(resolve(input, sequenceFile.name), incompleteSequence);
    Object.assign(sequenceFile, { bytes: Buffer.byteLength(incompleteSequence), sha256: createHash('sha256').update(incompleteSequence).digest('hex') });
    writeFileSync(resolve(input, 'manifest.json'), JSON.stringify(manifest));
    const rejected = spawnSync(process.execPath, [resolve(root, 'scripts/convert-snapshot.mjs'), input, resolve(directory, 'rejected'), '+09:00'], { encoding: 'utf8' });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Missing source column dining_soldout_report_sequence\.delivery_cooldown_until/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
