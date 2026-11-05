import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mysqlValue,
  signed64,
  utcTimestamp,
  rowInsert,
  rowInsertStatements,
  parseLossless,
  normalizeUnicodeKey,
  mergeChatMessage,
  D1_MAX_ROW_BYTES,
  D1_MAX_STATEMENT_BYTES,
  REDIS_ARCHIVE_THRESHOLD_BYTES,
} from './transform.mjs';
import {
  MONGO_COLLECTIONS,
  ARCHIVED_MONGO_COLLECTIONS,
  REVIEWED_ARCHIVE_ONLY_REDIS_KEY_SHA256,
  reviewedArchiveOnlyRedisKey,
  mongoRows,
  redisRows,
} from './state-adapters.mjs';
import {
  MYSQL_METADATA_TABLES,
  ARCHIVE_CHUNK_BYTES,
  assertSourceTables,
  assertSourceColumns,
  assertMetadataManifest,
  metadataVerifier,
  assertSnapshotCapture,
  assertImportCapture,
} from './source-metadata.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = JSON.parse(readFileSync(resolve(root, 'scripts/source-schema.json'), 'utf8'));
function database() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON;');
  for (const file of readdirSync(resolve(root, 'drizzle'))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort())
    db.exec(readFileSync(resolve(root, 'drizzle', file), 'utf8'));
  return db;
}

test('online snapshot acceptance is explicit and preserves per-store provenance', () => {
  const snapshot = {
    format: 1,
    complete: true,
    quiesced: false,
    captureMode: 'per-store-online',
    consistency: 'per-store-online',
    startedAt: '2026-10-28T00:00:00.000Z',
    completedAt: '2026-10-28T00:00:03.000Z',
    storeCaptures: {
      mysql: {
        startedAt: '2026-10-28T00:00:00.000001Z',
        completedAt: '2026-10-28T00:00:01.000Z',
        consistency: 'repeatable-read-transaction',
      },
      mongo: {
        startedAt: '2026-10-28T00:00:01.000Z',
        completedAt: '2026-10-28T00:00:02.000Z',
        consistency: 'sequential-collection-cursors-not-atomic',
      },
      redis: {
        startedAt: '2026-10-28T00:00:02.000Z',
        completedAt: '2026-10-28T00:00:03.000Z',
        consistency: 'scan-per-key-atomic-not-global',
      },
    },
    mongoInventory: [],
    mongoInventoryAfter: [],
  };
  assert.throws(() => assertSnapshotCapture(snapshot, false, MONGO_COLLECTIONS), /--allow-online-bootstrap/);
  assert.equal(assertSnapshotCapture(snapshot, true, MONGO_COLLECTIONS), 'per-store-online');
  for (const change of [
    { complete: false },
    { quiesced: true },
    { captureMode: 'unknown' },
    { consistency: 'cross-store-writer-quiesced' },
    {
      storeCaptures: {
        ...snapshot.storeCaptures,
        mongo: { ...snapshot.storeCaptures.mongo, startedAt: '2026-10-27T23:59:59.000Z' },
      },
    },
    {
      storeCaptures: {
        ...snapshot.storeCaptures,
        redis: { ...snapshot.storeCaptures.redis, consistency: 'atomic-global' },
      },
    },
    { mongoInventoryAfter: [{ name: 'unknown', type: 'collection', count: 1 }] },
  ])
    assert.throws(() => assertSnapshotCapture({ ...snapshot, ...change }, true, MONGO_COLLECTIONS));
  assert.equal(
    assertSnapshotCapture({ format: 1, complete: true, quiesced: true }, false, MONGO_COLLECTIONS),
    'writer-quiesced',
  );
  const converted = {
    captureMode: 'per-store-online',
    consistency: 'per-store-online',
    sourceQuiesced: false,
    snapshotHash: 'a'.repeat(64),
    storeCaptures: snapshot.storeCaptures,
    sourceStartedAt: snapshot.startedAt,
    sourceCompletedAt: snapshot.completedAt,
  };
  assert.throws(() => assertImportCapture(converted, false), /--allow-online-bootstrap/);
  assert.doesNotThrow(() => assertImportCapture(converted, true));
  assert.throws(() => assertImportCapture({ ...converted, storeCaptures: null }, true));
  assert.throws(() => assertImportCapture({ ...converted, sourceQuiesced: true }, true));
  assert.doesNotThrow(() => assertImportCapture({ captureMode: 'writer-quiesced', sourceQuiesced: true }, false));
  assert.throws(() => assertImportCapture({ captureMode: 'writer-quiesced', sourceQuiesced: false }, false));
});

test('all 165 source tables execute and preserve exact table names', () => {
  const db = database();
  try {
    assert.equal(source.tables.length, 165);
    const names = new Set(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
        .all()
        .map((row) => row.name),
    );
    for (const table of source.tables) assert.ok(names.has(table.name), table.name);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});

test('signed64 values roundtrip beyond JS precision and SQL increments remain exact', () => {
  const db = database();
  try {
    db.prepare('UPDATE dining_soldout_report_sequence SET last_sequence=? WHERE id=1').run('9007199254740993');
    db.exec(
      'UPDATE dining_soldout_report_sequence SET last_sequence=CAST(CAST(last_sequence AS INTEGER)+1 AS TEXT) WHERE id=1',
    );
    assert.equal(
      db.prepare('SELECT last_sequence FROM dining_soldout_report_sequence WHERE id=1').get().last_sequence,
      '9007199254740994',
    );
    assert.throws(() =>
      db.prepare('UPDATE dining_soldout_report_sequence SET last_sequence=? WHERE id=1').run('9223372036854775808'),
    );
    assert.equal(signed64('9223372036854775807'), '9223372036854775807');
    assert.throws(() => signed64(9007199254740992));
    assert.throws(() => signed64('01'));
    assert.equal(parseLossless('{"id":9223372036854775807}').id, '9223372036854775807');
  } finally {
    db.close();
  }
});

test('generated nullable-major key enforces academic catalog uniqueness', () => {
  const db = database();
  try {
    db.exec(
      "INSERT INTO department(id,name) VALUES(1,'기계공학부'); INSERT INTO academic_program_year(student_year,department_id,major_id) VALUES('2026',1,NULL);",
    );
    assert.equal(db.prepare('SELECT major_key FROM academic_program_year').get().major_key, 0);
    assert.throws(() =>
      db.exec("INSERT INTO academic_program_year(student_year,department_id,major_id) VALUES('2026',1,NULL)"),
    );
    assert.throws(() =>
      db.exec("INSERT INTO academic_program_year(student_year,department_id,major_id) VALUES('2026',999,NULL)"),
    );
  } finally {
    db.close();
  }
});

test('foreign-key cascade and timestamp ON UPDATE execute in SQLite', () => {
  const db = database();
  try {
    db.exec(
      "INSERT INTO department_contact_departments(id,category,name,display_order,updated_at) VALUES(1,'ACADEMIC','test',1,'2000-01-01 00:00:00'); INSERT INTO department_contacts(department_id,phone_number,display_order) VALUES(1,'041-000-0000',1);",
    );
    db.exec("UPDATE department_contact_departments SET name='changed' WHERE id=1");
    assert.notEqual(
      db.prepare('SELECT updated_at FROM department_contact_departments WHERE id=1').get().updated_at,
      '2000-01-01 00:00:00',
    );
    db.exec('DELETE FROM department_contact_departments WHERE id=1');
    assert.equal(db.prepare('SELECT count(*) AS count FROM department_contacts').get().count, 0);
  } finally {
    db.close();
  }
});

test('failed atomic assertions roll back earlier business writes', () => {
  const db = database();
  try {
    db.exec('BEGIN');
    assert.throws(() =>
      db.exec(
        "INSERT INTO native_callvan_guard(id) VALUES('uncommitted'); INSERT INTO identity_atomic_guards(id,allowed) VALUES('guard',0)",
      ),
    );
    db.exec('ROLLBACK');
    assert.equal(db.prepare('SELECT count(*) AS count FROM native_callvan_guard').get().count, 0);
    assert.throws(() =>
      db.exec(
        "INSERT INTO identity_verification_limits(id,send_count,verify_count,expires_at) VALUES('fraction',1.2,0,1900000000000)",
      ),
    );
    db.exec(
      "INSERT INTO identity_verification_limits(id,send_count,verify_count,expires_at) VALUES('epoch',0,0,1900000000000)",
    );
  } finally {
    db.close();
  }
});

test('binary UUID and decimal transforms are lossless', () => {
  const binary = { type: 'binary', name: 'id', length: 16 };
  assert.equal(
    mysqlValue(
      binary,
      { $binary: Buffer.from('00112233445566778899aabbccddeeff', 'hex').toString('base64') },
      '+09:00',
    ),
    '00112233-4455-6677-8899-aabbccddeeff',
  );
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
    db.prepare('INSERT INTO native_collation_key(scope,owner,normalized) VALUES(?,?,?)').run(
      'users:nickname',
      '[1]',
      first,
    );
    assert.throws(() =>
      db
        .prepare('INSERT INTO native_collation_key(scope,owner,normalized) VALUES(?,?,?)')
        .run('users:nickname', '[2]', second),
    );
  } finally {
    db.close();
  }
});

test('Mongo and Redis chat reconciliation merges monotonic flags but rejects immutable conflicts', () => {
  const original = {
    id: '9007199254740993',
    article_id: 1,
    chatroom_id: 2,
    user_id: 3,
    is_read: 0,
    is_deleted: 0,
    is_image: null,
    nick_name: null,
    contents: 'found',
    created_at: '2026-10-27T15:00:00Z',
  };
  const merged = mergeChatMessage(original, { ...original, is_read: 1, is_deleted: 1, is_image: 0 });
  assert.equal(merged.is_read, 1);
  assert.equal(merged.is_deleted, 1);
  assert.equal(merged.is_image, 0);
  assert.throws(() => mergeChatMessage(original, { ...original, contents: 'different' }));
  const result = mongoRows(
    'lost_item_chat_room',
    {
      _id: { $oid: 'a' },
      article_id: 1,
      chatroom_id: 2,
      article_author_id: 3,
      item_owner_id: 4,
      created_at: '2026-10-28T00:00:00',
      messages: [
        {
          tsid: '9007199254740993',
          user_id: 3,
          is_read: false,
          is_deleted: false,
          nickname: null,
          contents: 'found',
          created_at: '2026-10-28T00:00:00',
        },
      ],
    },
    { offset: '+09:00' },
  );
  assert.equal(result[1].row.id, original.id);
  assert.equal(result[1].row.created_at, original.created_at);
});

test('TTL expiry is explicit and unknown live Redis keys stop conversion', () => {
  const record = {
    key: 'unsupported-live-key',
    type: 'string',
    capturedAt: 1000,
    expiresAt: 2000,
    value: { base64: Buffer.from('payload').toString('base64') },
  };
  assert.throws(() => redisRows(record, { now: 1000, offset: '+09:00' }), /Unmapped live Redis key/);
  const expired = redisRows(record, { now: 2001, offset: '+09:00' });
  assert.equal(expired.disposition, 'expired-archived');
  assert.equal(expired.rows.length, 1);
  assert.throws(() => rowInsert('large', { content: 'x'.repeat(D1_MAX_ROW_BYTES + 1) }), /2MiB/);
  assert.throws(() => rowInsert('large', { content: 'x'.repeat(100001) }), /100KB/);
});

test('Spring Redis indexed lists and numeric-key weather maps retain their distinct shapes', () => {
  const binary = (value) => ({ base64: Buffer.from(String(value)).toString('base64') });
  const record = (key, fields) => ({
    key,
    type: 'hash',
    capturedAt: 1000,
    expiresAt: null,
    value: fields.flatMap(([name, value]) => [binary(name), binary(value)]),
  });
  const bus = record('expressBus:fixture', [
    ['busInfos.[1].depart', '12:00'],
    ['busInfos.[1].arrival', '12:30'],
    ['busInfos.[1].charge', '1500'],
    ['busInfos.[0].depart', '11:00'],
    ['busInfos.[0].arrival', '11:30'],
    ['busInfos.[0].charge', '1200'],
  ]);
  const cache = redisRows(bus, { now: 1000, offset: '+09:00' }).rows.find(
    (row) => row.table === 'native_transport_cache',
  );
  assert.deepEqual(JSON.parse(cache.row.payload), [
    { depart: '11:00', arrival: '11:30', charge: 1200 },
    { depart: '12:00', arrival: '12:30', charge: 1500 },
  ]);
  const direct = record('expressBus:direct', [
    ['busInfos[0].depart', '10:00'],
    ['busInfos[0].arrival', '10:30'],
    ['busInfos[0].charge', '900'],
  ]);
  assert.equal(JSON.parse(redisRows(direct, { now: 1000, offset: '+09:00' }).rows[0].row.payload)[0].charge, 900);
  const weather = record('Weather:fixture', [
    ['hourlyWeathers.[202610292000].temperature', '12'],
    ['hourlyWeathers.[202610292000].weather', '맑음'],
    ['hourlyWeathers.[202610292000].weatherId', '1'],
    ['hourlyWeathers.[202610292000].weatherIconUrl', 'https://example.invalid/sun.webp'],
  ]);
  const forecast = JSON.parse(redisRows(weather, { now: 1000, offset: '+09:00' }).rows[0].row.payload);
  assert.deepEqual(forecast['202610292000'], {
    temperature: 12,
    weather: '맑음',
    weather_id: 1,
    weather_icon_url: 'https://example.invalid/sun.webp',
  });
  for (const path of [
    'busInfos.[1].depart',
    'busInfos..[0].depart',
    'busInfos.[0].__proto__',
    'busInfos.[10001].depart',
  ])
    assert.throws(() => redisRows(record('expressBus:invalid', [[path, '11:00']]), { now: 1000, offset: '+09:00' }));
});

test('portal SSO cookies stay out of D1 while exact bus notice hash remains mapped', () => {
  for (const key of ['JSESSIONID', '__KSMSID__', 'KHANUSER']) {
    const result = redisRows(
      { key, type: 'string', value: { base64: Buffer.from('synthetic-cookie').toString('base64') }, expiresAt: null },
      { now: 1000, offset: '+09:00' },
    );
    assert.equal(result.disposition, 'operational-credential-excluded');
    assert.deepEqual(result.rows, []);
    assert.throws(() => redisRows({ key, type: 'hash', value: [], expiresAt: null }, { now: 1000, offset: '+09:00' }));
  }
  const binary = (value) => ({ base64: Buffer.from(String(value)).toString('base64') });
  const notice = redisRows(
    {
      key: 'busNoticeArticle',
      type: 'hash',
      value: [binary('id'), binary('42'), binary('title'), binary('공고')],
      capturedAt: 1000,
      expiresAt: null,
    },
    { now: 1000, offset: '+09:00' },
  );
  const cache = notice.rows.find((entry) => entry.table === 'native_transport_cache');
  assert.deepEqual(JSON.parse(cache.row.payload), { id: 42, title: '공고' });
  assert.ok(notice.rows.some((entry) => entry.table === 'native_legacy_redis'));
  assert.throws(() =>
    redisRows(
      { key: 'unreviewed-live-key', type: 'string', value: binary('x'), expiresAt: null },
      { now: 1000, offset: '+09:00' },
    ),
  );
});

test('source session, reset and verification proofs never become D1 authority or raw archive rows', () => {
  for (const [key, type] of [
    ['refreshToken:fixture-user', 'hash'],
    ['webAuthSession:fixture-session', 'string'],
    ['passwordResetToken:fixture-user', 'hash'],
    ['userVerificationStatus:fixture-phone', 'hash'],
    ['verificationStatus@:fixture-phone', 'hash'],
    ['StudentTemporaryStatus:fixture-email', 'hash'],
    ['StudentTemporaryStatus:fixture-index', 'set'],
  ]) {
    const record = { key, type, value: [], expiresAt: null };
    const excluded = redisRows(record, { now: 1000, offset: '+09:00' });
    assert.equal(excluded.disposition, 'source-auth-authority-excluded');
    assert.deepEqual(excluded.rows, []);
    assert.ok(excluded.sourceClass);
    assert.throws(() => redisRows({ ...record, type: 'list' }, { now: 1000, offset: '+09:00' }));
  }
  const binary = (value) => ({ base64: Buffer.from(String(value)).toString('base64') });
  const counter = redisRows(
    {
      key: 'userDailyVerificationCount:fixture',
      type: 'hash',
      value: [binary('id'), binary('fixture'), binary('verificationCount'), binary('2')],
      expiresAt: 5000,
    },
    { now: 1000, offset: '+09:00' },
  );
  assert.equal(counter.disposition, 'mapped');
  assert.ok(counter.rows.some((entry) => entry.table === 'identity_verification_limits'));
});

test('one reviewed unattributed Redis string is archive-only by exact SHA and shape', () => {
  assert.equal(reviewedArchiveOnlyRedisKey(REVIEWED_ARCHIVE_ONLY_REDIS_KEY_SHA256, 'string', 3, null), true);
  assert.equal(reviewedArchiveOnlyRedisKey(REVIEWED_ARCHIVE_ONLY_REDIS_KEY_SHA256, 'hash', 3, null), false);
  assert.equal(reviewedArchiveOnlyRedisKey(REVIEWED_ARCHIVE_ONLY_REDIS_KEY_SHA256, 'string', 4, null), false);
  assert.equal(reviewedArchiveOnlyRedisKey(REVIEWED_ARCHIVE_ONLY_REDIS_KEY_SHA256, 'string', 3, 1000), false);
  assert.equal(reviewedArchiveOnlyRedisKey('0'.repeat(64), 'string', 3, null), false);
});

test('large Redis archive SQL preserves exact UTF-8 bytes across partial replay', () => {
  const payload = JSON.stringify({ text: "한글'😀".repeat(9000), quote: '"\\u0000' });
  assert.ok(Buffer.byteLength(payload) > REDIS_ARCHIVE_THRESHOLD_BYTES);
  const row = {
    key: 'AbtestVariableAssign:fixture',
    type: 'set',
    payload,
    expires_at: null,
    disposition: 'spring-secondary-index-archived',
  };
  const statements = [...rowInsertStatements('native_legacy_redis', row)];
  assert.ok(statements.length > 10);
  assert.ok(statements.every((statement) => Buffer.byteLength(statement) <= D1_MAX_STATEMENT_BYTES));
  const expectedHash = createHash('sha256').update(payload).digest('hex');
  const apply = (db, sqlStatements) => {
    for (const statement of sqlStatements) db.exec(statement);
  };
  const complete = database();
  const interrupted = database();
  try {
    apply(complete, statements);
    apply(complete, statements);
    const fromComplete = complete.prepare('SELECT payload FROM native_legacy_redis WHERE key=?').get(row.key).payload;
    assert.equal(fromComplete, payload);
    assert.equal(createHash('sha256').update(fromComplete).digest('hex'), expectedHash);
    assert.equal(complete.prepare('SELECT count(*) AS count FROM identity_atomic_guards').get().count, 0);
    apply(interrupted, statements.slice(0, 4));
    apply(interrupted, statements);
    const fromReplay = interrupted.prepare('SELECT payload FROM native_legacy_redis WHERE key=?').get(row.key).payload;
    assert.equal(fromReplay, payload);
    assert.equal(Buffer.byteLength(fromReplay), Buffer.byteLength(payload));
    assert.equal(createHash('sha256').update(fromReplay).digest('hex'), expectedHash);
    interrupted.prepare('UPDATE native_legacy_redis SET payload=? WHERE key=?').run('corrupt', row.key);
    assert.throws(() => apply(interrupted, statements));
    assert.notEqual(
      interrupted.prepare('SELECT payload FROM native_legacy_redis WHERE key=?').get(row.key).payload,
      payload,
    );
  } finally {
    complete.close();
    interrupted.close();
  }
  assert.throws(
    () => [...rowInsertStatements('native_legacy_redis', { ...row, payload: 'x'.repeat(D1_MAX_ROW_BYTES + 1) })],
    /2MiB/,
  );
});

test('complete snapshot conversion reconciles chat, isolates source sessions and emits resumable FK-ordered data', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'koin-d1-migration-'));
  const input = resolve(directory, 'snapshot');
  const output = resolve(directory, 'converted');
  mkdirSync(input);
  const manifest = {
    format: 1,
    sourceCommit: source.sourceCommit,
    complete: true,
    quiesced: true,
    mysqlSessionTimezone: '+00:00',
    startedAt: '2026-10-28T00:00:00Z',
    completedAt: '2026-10-28T00:00:01Z',
    redisCompletedAt: '2026-10-28T00:00:01Z',
    files: [],
  };
  const append = (name, origin, records) => {
    const content = records.map((record) => JSON.stringify(record) + '\n').join('');
    writeFileSync(resolve(input, name), content);
    manifest.files.push({
      name,
      source: origin,
      count: records.length,
      bytes: Buffer.byteLength(content),
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  };
  try {
    manifest.mysqlMetadataTables = MYSQL_METADATA_TABLES;
    manifest.flyway = [
      {
        installed_rank: 1,
        version: '20',
        description: 'current',
        type: 'SQL',
        script: 'V20.sql',
        checksum: -123,
        installed_by: 'fixture',
        installed_on: '2026-06-17 00:00:00',
        execution_time: 12,
        success: 1,
      },
    ];
    for (const name of MYSQL_METADATA_TABLES) {
      const history =
        name === 'flyway_schema_history'
          ? manifest.flyway
          : [
              {
                installed_rank: 1,
                version: '1',
                description: '초기 기록',
                type: 'SQL',
                script: 'V1.sql',
                checksum: null,
                installed_by: 'legacy',
                installed_on: '2020-01-01 00:00:00',
                execution_time: 0,
                success: 1,
              },
              {
                installed_rank: 2,
                version: '2',
                description: "failed 'migration'",
                type: 'SQL',
                script: 'V2.sql',
                checksum: -2147483648,
                installed_by: 'legacy',
                installed_on: '2020-02-01 00:00:00',
                execution_time: 2,
                success: 0,
              },
            ];
      append(`${name}.mysql.jsonl`, `mysql:${name}`, history);
      append(`${name}.mysql-ddl.json`, `mysql-ddl:${name}`, [
        {
          Table: name,
          'Create Table': `CREATE TABLE \`${name}\` (installed_rank int NOT NULL) COMMENT='${'x'.repeat(ARCHIVE_CHUNK_BYTES + 1)}'`,
        },
      ]);
    }
    for (const table of source.tables) {
      const records = [];
      if (table.name === 'users') {
        const row = Object.fromEntries(
          source.columns
            .filter((column) => column.table === 'users')
            .map((column) => [
              column.name,
              column.default === 'CURRENT_TIMESTAMP' ? '2026-10-28 00:00:00' : column.default,
            ]),
        );
        Object.assign(row, {
          id: 1,
          password: 'fixture-password',
          user_type: 'GENERAL',
          anonymous_nickname: 'fixture-user',
        });
        records.push(row);
      }
      if (table.name === 'abtest')
        records.push({
          id: 10,
          title: '순환 FK 실험',
          display_title: '순환 FK',
          description: null,
          creator: null,
          team: null,
          winner_id: 20,
          status: 'IN_PROGRESS',
          created_at: '2025-01-01 01:02:03',
          updated_at: '2025-01-02 03:04:05',
        });
      if (table.name === 'abtest_variable')
        records.push({
          id: 20,
          abtest_id: 10,
          name: 'A',
          display_name: 'A',
          rate: 100,
          count: 0,
          created_at: '2025-01-01 01:02:03',
          updated_at: '2025-01-02 03:04:05',
        });
      if (table.name === 'dining_soldout_report_sequence')
        records.push({ id: 1, last_sequence: '9007199254740993', delivery_cooldown_until: null });
      if (table.name === 'password_resets')
        records.push(
          { email: 'fixture@example.invalid', token: 'fixture-reset', created_at: null },
          { email: 'fixture@example.invalid', token: 'fixture-reset', created_at: null },
        );
      append(`${table.name}.mysql.jsonl`, `mysql:${table.name}`, records);
    }
    const mongoMessage = {
      tsid: '9007199254740993',
      user_id: 1,
      is_read: false,
      is_deleted: false,
      nickname: '123',
      contents: 'null',
      created_at: { $date: '2026-10-27T15:00:00.123Z' },
    };
    for (const collection of MONGO_COLLECTIONS)
      append(
        `${collection}.mongo.jsonl`,
        `mongo:${collection}`,
        collection === 'lost_item_chat_room'
          ? [
              {
                _id: { $oid: '012345678901234567890123' },
                article_id: 10,
                chatroom_id: 20,
                article_author_id: 1,
                item_owner_id: 2,
                created_at: { $date: '2026-10-27T15:00:00Z' },
                messages: [mongoMessage],
              },
            ]
          : [],
      );
    const binary = (value) => ({ base64: Buffer.from(value).toString('base64') });
    const redisMessage = {
      id: '9007199254740993',
      articleId: 10,
      chatRoomId: 20,
      userId: 1,
      isRead: true,
      isDeleted: false,
      isImage: false,
      nickName: '123',
      contents: 'null',
      createdAt: '2026-10-28T00:00:00.123456',
    };
    append('redis.jsonl', 'redis', [
      {
        key: 'webAuthSession:fixture-session',
        type: 'string',
        capturedAt: 1793145600000,
        expiresAt: 1893456000000,
        value: binary(
          JSON.stringify({
            id: 'fixture-session',
            userId: 1,
            refreshTokenHash: 'refresh-hash',
            csrfToken: 'csrf-value',
            credentialHash: 'credential-hash',
            expiresAt: '2030-01-01T00:00:00Z',
            autoLogin: true,
          }),
        ),
      },
      {
        key: 'article:10:chatroom:20:message',
        type: 'zset',
        capturedAt: 1793145600000,
        expiresAt: null,
        value: [binary(JSON.stringify('900719925474:0993|' + JSON.stringify(redisMessage))), binary('0')],
      },
    ]);
    writeFileSync(resolve(input, 'manifest.json'), JSON.stringify(manifest));
    const result = spawnSync(
      process.execPath,
      [resolve(root, 'scripts/convert-snapshot.mjs'), input, output, '+09:00'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const converted = JSON.parse(readFileSync(resolve(output, 'manifest.json'), 'utf8'));
    assert.equal(converted.complete, true);
    assert.equal(converted.excludedSourceAuthAuthority.length, 1);
    assert.equal(converted.redisDispositions['source-auth-authority-excluded'], 1);
    assert.equal(converted.foreignKeyViolations, 0);
    const db = new DatabaseSync(resolve(output, 'validated.sqlite'));
    try {
      assert.equal(
        db.prepare('SELECT last_sequence FROM dining_soldout_report_sequence').get().last_sequence,
        '9007199254740993',
      );
      assert.equal(db.prepare('SELECT count(*) AS count FROM identity_web_sessions').get().count, 0);
      assert.equal(db.prepare('SELECT count(*) AS count FROM identity_native_sessions').get().count, 0);
      assert.equal(
        db
          .prepare(
            "SELECT count(*) AS count FROM native_legacy_redis WHERE key LIKE 'webAuthSession:%' OR key LIKE 'refreshToken:%'",
          )
          .get().count,
        0,
      );
      assert.equal(db.prepare('SELECT count(*) AS count FROM password_resets').get().count, 2);
      const chat = db.prepare('SELECT * FROM native_chat_message').get();
      assert.equal(chat.contents, 'null');
      assert.equal(chat.nick_name, '123');
      assert.equal(chat.is_read, 1);
      assert.equal(chat.created_at, '2026-10-27T15:00:00.123456Z');
      assert.equal(db.prepare('SELECT count(*) AS count FROM native_legacy_mongo').get().count, 1);
      assert.equal(db.prepare('SELECT count(*) AS count FROM native_legacy_redis').get().count, 1);
    } finally {
      db.close();
    }
    assert.ok(converted.files.some((file) => file.kind === 'schema' && file.schemaHash));
    assert.ok(converted.files.filter((file) => file.kind === 'data').every((file) => file.dataHash && file.sha256));
    assert.equal(converted.sourceMetadataFiles.length, 5);
    const firstData = readFileSync(resolve(output, converted.files[1].name), 'utf8');
    const firstTwoStatements = firstData.split('\n').slice(0, 2).join('\n');
    const imported = new DatabaseSync(':memory:');
    try {
      imported.exec('PRAGMA foreign_keys=ON');
      imported.exec(readFileSync(resolve(output, converted.files[0].name), 'utf8'));
      imported.exec(firstTwoStatements);
      for (const file of converted.files.slice(1)) imported.exec(readFileSync(resolve(output, file.name), 'utf8'));
      const winner = imported.prepare('SELECT winner_id,updated_at FROM abtest WHERE id=10').get();
      assert.equal(winner.winner_id, 20);
      assert.equal(winner.updated_at, '2025-01-02 03:04:05');
      assert.deepEqual(imported.prepare('PRAGMA foreign_key_check').all(), []);
      for (const file of converted.sourceMetadataFiles) {
        const descriptor = imported.prepare('SELECT * FROM native_source_metadata_file WHERE id=?').get(file.id);
        assert.deepEqual({ ...descriptor }, file);
        const chunks = imported
          .prepare('SELECT position,payload FROM native_source_metadata_chunk WHERE file_id=? ORDER BY position')
          .all(file.id);
        const verifier = metadataVerifier(descriptor);
        for (const chunk of chunks) verifier.consume(chunk);
        verifier.finish();
        assert.deepEqual(
          Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.payload, 'base64'))),
          readFileSync(resolve(input, file.id)),
        );
      }
      assert.equal(
        imported
          .prepare(
            "SELECT row_count FROM native_source_metadata_file WHERE source='mysql:flyway_schema_history_legacy_20260617'",
          )
          .get().row_count,
        2,
      );
    } finally {
      imported.close();
    }
    const corrupted = new DatabaseSync(':memory:');
    try {
      corrupted.exec('PRAGMA foreign_keys=ON');
      corrupted.exec(readFileSync(resolve(output, converted.files[0].name), 'utf8'));
      corrupted.exec(firstTwoStatements);
      corrupted.exec("UPDATE abtest SET title='tampered' WHERE id=10");
      assert.throws(() => corrupted.exec(firstData));
      assert.notEqual(corrupted.prepare('SELECT title FROM abtest WHERE id=10').get().title, '순환 FK 실험');
    } finally {
      corrupted.close();
    }
    const inventory = MONGO_COLLECTIONS.map((name) => ({
      name,
      type: 'collection',
      count: manifest.files.find((file) => file.source === `mongo:${name}`).count,
    }));
    const onlineManifest = {
      ...manifest,
      quiesced: false,
      captureMode: 'per-store-online',
      consistency: 'per-store-online',
      mongoInventory: inventory,
      mongoInventoryAfter: inventory,
      storeCaptures: {
        mysql: {
          startedAt: '2026-10-28T00:00:00.000Z',
          completedAt: '2026-10-28T00:00:00.100Z',
          consistency: 'repeatable-read-transaction',
        },
        mongo: {
          startedAt: '2026-10-28T00:00:00.100Z',
          completedAt: '2026-10-28T00:00:00.200Z',
          consistency: 'sequential-collection-cursors-not-atomic',
        },
        redis: {
          startedAt: '2026-10-28T00:00:00.200Z',
          completedAt: '2026-10-28T00:00:00.300Z',
          consistency: 'scan-per-key-atomic-not-global',
        },
      },
    };
    writeFileSync(resolve(input, 'manifest.json'), JSON.stringify(onlineManifest));
    const onlineArgs = [
      resolve(root, 'scripts/convert-snapshot.mjs'),
      input,
      resolve(directory, 'online-denied'),
      '+09:00',
    ];
    const denied = spawnSync(process.execPath, onlineArgs, { encoding: 'utf8' });
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /--allow-online-bootstrap/);
    const onlineResult = spawnSync(
      process.execPath,
      [
        resolve(root, 'scripts/convert-snapshot.mjs'),
        input,
        resolve(directory, 'online-converted'),
        '+09:00',
        '--allow-online-bootstrap',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(onlineResult.status, 0, onlineResult.stderr);
    const onlineConverted = JSON.parse(readFileSync(resolve(directory, 'online-converted/manifest.json'), 'utf8'));
    assert.equal(onlineConverted.captureMode, 'per-store-online');
    assert.equal(onlineConverted.sourceQuiesced, false);
    assert.equal(onlineConverted.foreignKeyViolations, 0);
    assert.throws(() => assertImportCapture(onlineConverted, false), /--allow-online-bootstrap/);
    assert.doesNotThrow(() => assertImportCapture(onlineConverted, true));
    writeFileSync(resolve(input, 'manifest.json'), JSON.stringify(manifest));
    for (const [label, mutate, message] of [
      [
        'metadata-count',
        (value) => {
          value.files.find((file) => file.source === 'mysql:flyway_schema_history_legacy_20260617').count += 1;
        },
        /Row count mismatch/,
      ],
      [
        'metadata-missing',
        (value) => {
          value.files = value.files.filter((file) => file.source !== 'mysql:flyway_schema_history_legacy_20260617');
        },
        /Missing\/duplicate metadata input/,
      ],
      [
        'metadata-hash',
        (value) => {
          value.files.find((file) => file.source === 'mysql-ddl:flyway_schema_history').sha256 = '0'.repeat(64);
        },
        /Corrupt snapshot file/,
      ],
      [
        'metadata-current',
        (value) => {
          value.flyway[0].checksum = 999;
        },
        /Flyway manifest and archived rows differ/,
      ],
    ]) {
      const invalid = structuredClone(manifest);
      mutate(invalid);
      writeFileSync(resolve(input, 'manifest.json'), JSON.stringify(invalid));
      const result = spawnSync(
        process.execPath,
        [resolve(root, 'scripts/convert-snapshot.mjs'), input, resolve(directory, label), '+09:00'],
        { encoding: 'utf8' },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, message);
    }
    const incompleteSequence = JSON.stringify({ id: 1, last_sequence: '9007199254740993' }) + '\n';
    const sequenceFile = manifest.files.find((file) => file.source === 'mysql:dining_soldout_report_sequence');
    writeFileSync(resolve(input, sequenceFile.name), incompleteSequence);
    Object.assign(sequenceFile, {
      bytes: Buffer.byteLength(incompleteSequence),
      sha256: createHash('sha256').update(incompleteSequence).digest('hex'),
    });
    writeFileSync(resolve(input, 'manifest.json'), JSON.stringify(manifest));
    const rejected = spawnSync(
      process.execPath,
      [resolve(root, 'scripts/convert-snapshot.mjs'), input, resolve(directory, 'rejected'), '+09:00'],
      { encoding: 'utf8' },
    );
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Missing source column dining_soldout_report_sequence\.delivery_cooldown_until/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('source metadata accepts only genuine collation aliases and ASCII JSON charset rendering', () => {
  const expected = {
    table: 'department',
    name: 'dept_nums',
    columnType: 'json',
    nullable: 'NO',
    extra: 'DEFAULT_GENERATED',
    default: "json_array(_latin1\\'N/A\\')",
    collation: 'utf8_general_ci',
    expression: '',
  };
  assert.doesNotThrow(() =>
    assertSourceColumns(
      [{ ...expected, collation: 'utf8mb3_general_ci', default: "json_array(_utf8mb4\\'N/A\\')" }],
      [expected],
    ),
  );
  assert.doesNotThrow(() => assertSourceColumns([{ ...expected, default: "json_array(_utf8mb3'N/A')" }], [expected]));
  for (const change of [
    { collation: 'utf8mb4_general_ci' },
    { collation: 'utf8_unicode_ci' },
    { default: "json_array(_utf8mb4\\'N/B\\')" },
    { default: null },
    { nullable: 'YES' },
    { columnType: 'text' },
    { extra: '' },
    { expression: '1' },
  ])
    assert.throws(() => assertSourceColumns([{ ...expected, ...change }], [expected]), /Live column mismatch/);
  for (const [before, after, extra] of [
    ["json_array(_latin1'é')", "json_array(_utf8mb4'é')", 'DEFAULT_GENERATED'],
    ["json_array(_latin1'a\\\\n')", "json_array(_utf8mb4'a\\\\n')", 'DEFAULT_GENERATED'],
    ["concat(_latin1'ABC', _latin1'DEF')", "concat(_utf8mb4'ABC', _utf8mb4'DEF')", 'DEFAULT_GENERATED'],
    ["'_latin1\\'N/A\\''", "'_utf8mb4\\'N/A\\''", 'DEFAULT_GENERATED'],
    ["json_array(_latin1'N/A')", "json_array(_utf8mb4'N/A')", ''],
  ])
    assert.throws(
      () => assertSourceColumns([{ ...expected, extra, default: after }], [{ ...expected, extra, default: before }]),
      /Live column mismatch/,
    );
  assert.throws(
    () => assertSourceColumns([expected, { ...expected, name: 'unexpected' }], [expected]),
    /column inventory/,
  );
  assert.throws(() => assertSourceColumns([], [expected]), /column inventory/);
});

test('source inventory explicitly requires both Flyway histories and rejects unknown business tables', () => {
  const tables = [...source.tables, ...MYSQL_METADATA_TABLES.map((name) => ({ name }))];
  assert.doesNotThrow(() => assertSourceTables(tables, source.tables));
  assert.throws(
    () => assertSourceTables([...tables, { name: 'unexpected_business' }], source.tables),
    /table inventory/,
  );
  assert.throws(() => assertSourceTables(tables.slice(0, -1), source.tables), /table inventory/);
  assert.throws(
    () =>
      assertSourceTables(
        tables.filter((table) => table.name !== source.tables[0].name),
        source.tables,
      ),
    /table inventory/,
  );
});

test('metadata archive rejects omitted histories, altered bytes, counts and chunk sequence', () => {
  const contents = Buffer.from('historical migration 기록\\n');
  const hash = createHash('sha256').update(contents).digest('hex');
  const descriptor = { id: 'history', byte_count: contents.length, chunk_count: 1, sha256: hash };
  const chunk = { position: 0, payload: contents.toString('base64') };
  const valid = metadataVerifier(descriptor);
  valid.consume(chunk);
  valid.finish();
  for (const change of [{ byte_count: contents.length + 1 }, { chunk_count: 2 }, { sha256: '0'.repeat(64) }]) {
    const invalid = metadataVerifier({ ...descriptor, ...change });
    invalid.consume(chunk);
    assert.throws(() => invalid.finish(), /integrity mismatch/);
  }
  const changed = metadataVerifier(descriptor);
  changed.consume({ ...chunk, payload: Buffer.from('changed').toString('base64') });
  assert.throws(() => changed.finish(), /integrity mismatch/);
  assert.throws(() => metadataVerifier(descriptor).consume({ ...chunk, position: 1 }), /sequence mismatch/);
  assert.throws(() => metadataVerifier(descriptor).consume({ ...chunk, payload: '!!!!' }), /Invalid metadata chunk/);
  const snapshot = {
    mysqlMetadataTables: MYSQL_METADATA_TABLES,
    files: MYSQL_METADATA_TABLES.flatMap((name) => [
      { name: `${name}.mysql.jsonl`, source: `mysql:${name}`, count: 2, bytes: contents.length, sha256: hash },
      { name: `${name}.mysql-ddl.json`, source: `mysql-ddl:${name}`, count: 1, bytes: contents.length, sha256: hash },
    ]),
  };
  assert.doesNotThrow(() => assertMetadataManifest(snapshot));
  assert.throws(() => assertMetadataManifest({ ...snapshot, files: snapshot.files.slice(1) }), /Missing\/duplicate/);
  assert.throws(
    () => assertMetadataManifest({ ...snapshot, files: [...snapshot.files, snapshot.files[0]] }),
    /Missing\/duplicate/,
  );
  assert.throws(
    () => assertMetadataManifest({ ...snapshot, mysqlMetadataTables: MYSQL_METADATA_TABLES.slice(0, 1) }),
    /both Flyway/,
  );
  assert.throws(
    () => assertMetadataManifest({ ...snapshot, files: snapshot.files.map((file) => ({ ...file, count: -1 })) }),
    /integrity fields/,
  );
});

test('historical Mongo collections preserve original Extended JSON without creating live timetable rows', () => {
  const original = {
    _id: { $oid: '012345678901234567890123' },
    nested: { sequence: { $numberLong: '9007199254740993' }, oldField: ['보존', null] },
  };
  for (const collection of ARCHIVED_MONGO_COLLECTIONS) {
    assert.deepEqual(mongoRows(collection, original, { offset: '+00:00' }), [
      {
        table: 'native_legacy_mongo',
        row: { collection, source_id: '012345678901234567890123', payload: JSON.stringify(original) },
      },
    ]);
  }
  assert.throws(
    () => mongoRows('unknown_live_collection', original, { offset: '+00:00' }),
    /Unmapped Mongo collection/,
  );
});
