import { createHash } from 'node:crypto';

export const MYSQL_METADATA_TABLES = ['flyway_schema_history', 'flyway_schema_history_legacy_20260617'];
export const ARCHIVE_CHUNK_BYTES = 48 * 1024;

const column = (name, type = 'text', ref = null) => ({ name, type, nullable: false, default: null, ref });
export const metadataTables = [
  {
    name: 'native_source_metadata_file',
    columns: [
      column('id'),
      column('source'),
      column('row_count', 'int'),
      column('byte_count', 'int'),
      column('sha256'),
      column('chunk_count', 'int'),
    ],
    primary: ['id'],
    indexes: [],
    checks: ['row_count >= 0', 'byte_count >= 0', 'chunk_count >= 0', 'length(sha256) = 64'],
  },
  {
    name: 'native_source_metadata_chunk',
    columns: [column('file_id', 'text', 'native_source_metadata_file'), column('position', 'int'), column('payload')],
    primary: ['file_id', 'position'],
    indexes: [],
    checks: ['position >= 0'],
  },
];

export function assertSourceTables(tables, expected) {
  const actual = tables.map((table) => table.name).sort();
  const required = [...expected.map((table) => table.name), ...MYSQL_METADATA_TABLES].sort();
  if (JSON.stringify(actual) !== JSON.stringify(required))
    throw new Error(
      'Live table inventory differs from the source and explicit Flyway metadata contract; reconcile schema before export',
    );
}

export function normalizeMysqlDefault(value, extra) {
  if (typeof value !== 'string' || !extra.includes('DEFAULT_GENERATED')) return value;
  // JSON 배열의 순수 ASCII 문자열만 문자셋에 무관하다. 비교식·이스케이프·비ASCII 리터럴은 원문으로 비교한다.
  const literal = String.raw`_(?:utf8|utf8mb3|utf8mb4|latin1)(?:'([\x20-\x26\x28-\x5b\x5d-\x7e]*)'|\\'([\x20-\x26\x28-\x5b\x5d-\x7e]*)\\')`;
  if (!new RegExp(`^json_array\\(${literal}(?:,\\s*${literal})*\\)$`).test(value)) return value;
  return value.replace(new RegExp(literal, 'g'), (_, plain, escaped) => `'${plain ?? escaped}'`);
}

export function assertSourceColumns(actual, expected) {
  const business = actual.filter((item) => !MYSQL_METADATA_TABLES.includes(item.table));
  if (business.length !== expected.length) throw new Error('Live business column inventory differs from source schema');
  const columns = new Map(business.map((item) => [item.table + '.' + item.name, item]));
  if (columns.size !== expected.length) throw new Error('Duplicate live business column');
  const collation = (value) => (typeof value === 'string' ? value.replace(/^utf8_/, 'utf8mb3_') : value);
  for (const column of expected) {
    const current = columns.get(column.table + '.' + column.name);
    if (
      !current ||
      ['columnType', 'nullable', 'extra'].some((key) => current[key] !== column[key]) ||
      collation(current.collation) !== collation(column.collation) ||
      normalizeMysqlDefault(current.default, current.extra) !== normalizeMysqlDefault(column.default, column.extra) ||
      current.expression !== (column.expression ?? '')
    )
      throw new Error(`Live column mismatch: ${column.table}.${column.name}`);
  }
}

export function metadataSources() {
  return MYSQL_METADATA_TABLES.flatMap((name) => [`mysql:${name}`, `mysql-ddl:${name}`]);
}

export function assertMetadataManifest(snapshot) {
  if (JSON.stringify(snapshot.mysqlMetadataTables) !== JSON.stringify(MYSQL_METADATA_TABLES))
    throw new Error('Snapshot must declare both Flyway metadata tables');
  for (const source of metadataSources()) {
    const files = snapshot.files.filter((file) => file.source === source);
    if (files.length !== 1) throw new Error(`Missing/duplicate metadata input: ${source}`);
    const file = files[0];
    if (
      !Number.isSafeInteger(file.count) ||
      file.count < 0 ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      !/^[0-9a-f]{64}$/.test(file.sha256)
    )
      throw new Error(`Invalid metadata integrity fields: ${source}`);
    if (source.startsWith('mysql-ddl:') && file.count !== 1) throw new Error(`Invalid metadata DDL count: ${source}`);
  }
}
const validTimestamp = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));

function assertCaptureIntervals(captures, startedAt, completedAt) {
  const labels = {
    mysql: 'repeatable-read-transaction',
    mongo: 'sequential-collection-cursors-not-atomic',
    redis: 'scan-per-key-atomic-not-global',
  };
  if (!validTimestamp(startedAt) || !validTimestamp(completedAt) || !captures)
    throw new Error('Online capture requires complete UTC timing provenance');
  let previous = Date.parse(startedAt);
  for (const store of ['mysql', 'mongo', 'redis']) {
    const capture = captures[store];
    if (
      !capture ||
      capture.consistency !== labels[store] ||
      !validTimestamp(capture.startedAt) ||
      !validTimestamp(capture.completedAt) ||
      Date.parse(capture.startedAt) < previous ||
      Date.parse(capture.startedAt) > Date.parse(capture.completedAt)
    )
      throw new Error(`Invalid or overlapping online ${store} capture interval`);
    previous = Date.parse(capture.completedAt);
  }
  if (previous > Date.parse(completedAt)) throw new Error('Online capture exceeds source manifest interval');
}

export function assertSnapshotCapture(snapshot, allowOnline, collections) {
  if (snapshot.format !== 1 || snapshot.complete !== true) throw new Error('Incomplete or unsupported source snapshot');
  if (
    snapshot.quiesced === true &&
    (snapshot.captureMode === undefined || snapshot.captureMode === 'writer-quiesced') &&
    (snapshot.consistency === undefined || snapshot.consistency === 'cross-store-writer-quiesced')
  )
    return 'writer-quiesced';
  if (
    !allowOnline ||
    snapshot.quiesced !== false ||
    snapshot.captureMode !== 'per-store-online' ||
    snapshot.consistency !== 'per-store-online'
  )
    throw new Error(
      'Per-store online snapshot requires explicit --allow-online-bootstrap; quiescence must never be inferred',
    );
  assertCaptureIntervals(snapshot.storeCaptures, snapshot.startedAt, snapshot.completedAt);
  for (const name of ['mongoInventory', 'mongoInventoryAfter']) {
    const inventory = snapshot[name];
    if (
      !Array.isArray(inventory) ||
      new Set(inventory.map((item) => item?.name)).size !== inventory.length ||
      inventory.some(
        (item) =>
          !collections.includes(item?.name) ||
          item.type !== 'collection' ||
          !Number.isSafeInteger(item.count) ||
          item.count < 0,
      )
    )
      throw new Error(`Invalid online ${name}; unknown collections are not permitted`);
  }
  return 'per-store-online';
}

export function assertImportCapture(manifest, allowOnline) {
  if (manifest.captureMode === 'per-store-online') {
    if (
      !allowOnline ||
      manifest.consistency !== 'per-store-online' ||
      manifest.sourceQuiesced !== false ||
      !manifest.storeCaptures ||
      !validTimestamp(manifest.sourceStartedAt) ||
      !validTimestamp(manifest.sourceCompletedAt) ||
      !/^[0-9a-f]{64}$/.test(manifest.snapshotHash ?? '')
    )
      throw new Error('Online D1 import requires verified provenance and explicit --allow-online-bootstrap');
    assertCaptureIntervals(manifest.storeCaptures, manifest.sourceStartedAt, manifest.sourceCompletedAt);
    return;
  }
  if (manifest.captureMode !== 'writer-quiesced' || manifest.sourceQuiesced !== true)
    throw new Error('Converted strict snapshot must retain explicit writer-quiescence provenance');
}

export function metadataVerifier(file) {
  const hash = createHash('sha256');
  let bytes = 0;
  let chunks = 0;
  return {
    consume(row) {
      if (row.position !== chunks || typeof row.payload !== 'string')
        throw new Error(`Metadata chunk sequence mismatch: ${file.id}`);
      const data = Buffer.from(row.payload, 'base64');
      if (data.toString('base64') !== row.payload || !data.length || data.length > ARCHIVE_CHUNK_BYTES)
        throw new Error(`Invalid metadata chunk: ${file.id}`);
      hash.update(data);
      bytes += data.length;
      chunks += 1;
    },
    finish() {
      if (bytes !== file.byte_count || chunks !== file.chunk_count || hash.digest('hex') !== file.sha256)
        throw new Error(`Metadata archive integrity mismatch: ${file.id}`);
    },
  };
}
