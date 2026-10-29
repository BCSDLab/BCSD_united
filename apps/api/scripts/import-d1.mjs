import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { D1_MAX_BYTES, REDIS_ARCHIVE_THRESHOLD_BYTES } from './transform.mjs';
import { metadataSources, metadataVerifier, assertImportCapture } from './source-metadata.mjs';
import { REVIEWED_ARCHIVE_ONLY_REDIS_KEY_SHA256, EXCLUDED_SOURCE_AUTH_KEYSPACES } from './state-adapters.mjs';

const wranglerEntry = resolve(dirname(fileURLToPath(import.meta.resolve('wrangler/package.json'))), 'bin/wrangler.js');
const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const [directory, database, mode, ...options] = process.argv.slice(2);
if (
  !directory ||
  !database ||
  !['--local', '--remote'].includes(mode) ||
  options.some((option) => option !== '--allow-online-bootstrap') ||
  new Set(options).size !== options.length
)
  throw new Error(
    'Usage: node import-d1.mjs CONVERTED_DIR DATABASE_NAME --local|--remote [--allow-online-bootstrap]. Target must be NEW and receive no application traffic until verification completes.',
  );
const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
if (!manifest.complete || manifest.foreignKeyViolations !== 0)
  throw new Error('Only completely validated snapshots may be imported');
assertImportCapture(manifest, options.includes('--allow-online-bootstrap'));
if (
  !Array.isArray(manifest.excludedOperationalCredentials) ||
  (manifest.redisDispositions?.['operational-credential-excluded'] ?? 0) !==
    manifest.excludedOperationalCredentials.length ||
  new Set(manifest.excludedOperationalCredentials.map((item) => item.keySha256)).size !==
    manifest.excludedOperationalCredentials.length ||
  manifest.excludedOperationalCredentials.some(
    (item) =>
      !/^[0-9a-f]{64}$/.test(item.keySha256) ||
      item.sourceClass !== 'koin-batch-portal-sso-cookie' ||
      item.count !== 1 ||
      item.reason !== 'Isolate operational portal credentials from D1 environments',
  )
)
  throw new Error('Invalid operational credential exclusion manifest');
if (
  !Array.isArray(manifest.excludedSourceAuthAuthority) ||
  (manifest.redisDispositions?.['source-auth-authority-excluded'] ?? 0) !==
    manifest.excludedSourceAuthAuthority.length ||
  new Set(manifest.excludedSourceAuthAuthority.map((item) => item.keySha256)).size !==
    manifest.excludedSourceAuthAuthority.length ||
  manifest.excludedSourceAuthAuthority.some(
    (item) =>
      !/^[0-9a-f]{64}$/.test(item.keySha256) ||
      !EXCLUDED_SOURCE_AUTH_KEYSPACES.some((policy) => policy.sourceClass === item.sourceClass) ||
      item.count !== 1 ||
      item.reason !== 'Isolate source auth sessions and verification authority from new D1 environments',
  ) ||
  manifest.destinationCounts?.identity_native_sessions !== 0 ||
  manifest.destinationCounts?.identity_web_sessions !== 0 ||
  manifest.destinationCounts?.identity_verifications !== 0
)
  throw new Error('Invalid isolated source auth authority manifest');
if (
  !Array.isArray(manifest.reviewedArchiveOnlyRedis) ||
  (manifest.redisDispositions?.['unattributed-archive-only-user-approved'] ?? 0) !==
    manifest.reviewedArchiveOnlyRedis.length ||
  manifest.reviewedArchiveOnlyRedis.length > 1 ||
  manifest.reviewedArchiveOnlyRedis.some(
    (item) =>
      item.keySha256 !== REVIEWED_ARCHIVE_ONLY_REDIS_KEY_SHA256 ||
      item.sourceClass !== 'unattributed-string-key' ||
      item.count !== 1 ||
      item.reason !== 'User approved archive-only preservation; producer semantics unknown',
  )
)
  throw new Error('Invalid reviewed archive-only Redis manifest');
const expectedMetadata = [...metadataSources(), 'snapshot-manifest'];
if (
  !Array.isArray(manifest.sourceMetadataFiles) ||
  manifest.sourceMetadataFiles.length !== expectedMetadata.length ||
  expectedMetadata.some((source) => manifest.sourceMetadataFiles.filter((file) => file.source === source).length !== 1)
)
  throw new Error('Converted snapshot lacks complete Flyway metadata archival');
for (const file of manifest.files) {
  if (!/^\d+-(?:schema|data)\.sql$/.test(file.name)) throw new Error('Unsafe converted SQL filename');
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(resolve(directory, file.name))) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  if (hash.digest('hex') !== file.sha256 || bytes !== file.bytes)
    throw new Error(`Converted file hash/length mismatch: ${file.name}`);
}
function wrangler(args) {
  return new Promise((success, failure) => {
    const file = args[0] === '--file';
    const child = spawn(
      process.execPath,
      [wranglerEntry, 'd1', 'execute', database, mode, ...(file ? ['--yes'] : ['--json']), ...args],
      {
        cwd: appDirectory,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout = file ? (stdout + chunk).slice(-65_536) : stdout + chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', failure);
    child.once('exit', (code) => {
      if (code !== 0) {
        failure(new Error(`Wrangler D1 command failed (${code}): ${stderr.trim() || stdout.trim()}`));
        return;
      }
      if (file) {
        success([]);
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        const result = Array.isArray(parsed) ? parsed : [parsed];
        if (result.some((entry) => entry.success === false)) throw new Error(JSON.stringify(result));
        success(result);
      } catch (error) {
        failure(new Error(`Cannot parse successful Wrangler response: ${error.message}`));
      }
    });
  });
}
const rows = (response) => response.flatMap((entry) => entry.results ?? []);
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const identifier = (value) => `"${value.replaceAll('"', '""')}"`;
const tables = rows(
  await wrangler([
    '--command',
    "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'",
  ]),
);
const hasCheckpoint = tables.some((row) => row.name === 'native_import_checkpoint');
if (!hasCheckpoint && tables.length)
  throw new Error('Refusing to import into a nonempty target without this importer checkpoint table');
if (!hasCheckpoint)
  await wrangler(['--file', resolve(directory, manifest.files.find((file) => file.kind === 'schema').name)]);
const checkpointRows = rows(await wrangler(['--command', 'SELECT id,sha256,row_count FROM native_import_checkpoint']));
const known = new Map(checkpointRows.map((row) => [row.id, row]));
if (known.get('__schema__')?.sha256 !== manifest.files.find((file) => file.kind === 'schema').schemaHash)
  throw new Error('Target schema was not created by this exact import manifest; use a new database');
const expectedCheckpoints = new Set([
  '__schema__',
  ...manifest.files.filter((file) => file.kind === 'data').map((file) => file.name),
]);
if ([...known.keys()].some((id) => !expectedCheckpoints.has(id)))
  throw new Error('Target contains checkpoints from another snapshot');
const receiptPath = resolve(directory, `import-${mode.slice(2)}-${encodeURIComponent(database)}.json`);
const progress = {
  snapshotHash: manifest.snapshotHash,
  captureMode: manifest.captureMode ?? 'writer-quiesced',
  database,
  mode,
  imported: [],
  verified: false,
};
for (const file of manifest.files.filter((entry) => entry.kind === 'data')) {
  const previous = known.get(file.name);
  if (previous) {
    if (previous.sha256 !== file.dataHash || previous.row_count !== file.rows)
      throw new Error(`Target contains a different snapshot checkpoint: ${file.name}`);
  } else {
    await wrangler(['--file', resolve(directory, file.name)]);
    const check = rows(
      await wrangler([
        '--command',
        `SELECT sha256,row_count FROM native_import_checkpoint WHERE id=${quote(file.name)}`,
      ]),
    )[0];
    if (!check || check.sha256 !== file.dataHash || check.row_count !== file.rows)
      throw new Error(`Import acknowledgement mismatch: ${file.name}`);
  }
  progress.imported.push(file.name);
  await writeFile(receiptPath, JSON.stringify(progress, null, 2));
}
const expectedCounts = Object.entries(manifest.destinationCounts).filter(
  ([table]) => table !== 'native_import_checkpoint',
);
for (let offset = 0; offset < expectedCounts.length; offset += 100) {
  const batch = expectedCounts.slice(offset, offset + 100);
  const command =
    batch.map(([table]) => `SELECT ${quote(table)} AS name,count(*) AS count FROM ${identifier(table)}`).join('; ') +
    ';';
  const actualRows = rows(await wrangler(['--command', command]));
  if (actualRows.length !== batch.length)
    throw new Error(`Target count result inventory mismatch: batch ${offset / 100}`);
  const actual = new Map(actualRows.map((row) => [row.name, row.count]));
  if (actual.size !== batch.length) throw new Error(`Target count result duplicates: batch ${offset / 100}`);
  for (const [table, expected] of batch)
    if (actual.get(table) !== expected)
      throw new Error(`Target row count mismatch ${table}: ${actual.get(table)} != ${expected}`);
}
const archivedFiles = rows(
  await wrangler([
    '--command',
    'SELECT id,source,row_count,byte_count,sha256,chunk_count FROM native_source_metadata_file',
  ]),
);
if (archivedFiles.length !== manifest.sourceMetadataFiles.length)
  throw new Error('Target metadata file inventory mismatch');
for (const expected of manifest.sourceMetadataFiles) {
  const actual = archivedFiles.find((file) => file.id === expected.id);
  if (
    !actual ||
    ['source', 'row_count', 'byte_count', 'sha256', 'chunk_count'].some((key) => actual[key] !== expected[key])
  )
    throw new Error(`Target metadata descriptor mismatch: ${expected.id}`);
  const verifier = metadataVerifier(actual);
  for (let position = 0; position < actual.chunk_count; position += 1) {
    const chunks = rows(
      await wrangler([
        '--command',
        `SELECT position,payload FROM native_source_metadata_chunk WHERE file_id=${quote(actual.id)} AND position=${position}`,
      ]),
    );
    if (chunks.length !== 1) throw new Error(`Target metadata chunk missing: ${actual.id}`);
    verifier.consume(chunks[0]);
  }
  verifier.finish();
}
const foreignKeys = rows(await wrangler(['--command', 'PRAGMA foreign_key_check']));
if (foreignKeys.length) throw new Error(`D1 foreign key check failed: ${JSON.stringify(foreignKeys)}`);
const sourceProofs = rows(
  await wrangler([
    '--command',
    "SELECT count(*) AS count FROM identity_tokens WHERE kind IN ('owner_sms','student_signup','student_reset')",
  ]),
)[0]?.count;
if (sourceProofs !== 0) throw new Error('Source verification/reset authority remains active in target D1');
const activeResponse = await wrangler(['--command', "SELECT active FROM native_import_control WHERE id='import'"]);
const active = rows(activeResponse)[0];
if (active?.active !== 0) throw new Error('Import-mode business guards remain disabled');
const storage = activeResponse.at(-1)?.meta?.size_after;
if (!Number.isSafeInteger(storage) || storage > D1_MAX_BYTES)
  throw new Error('D1 final storage size exceeds 10GB or could not be measured');
if (!Array.isArray(manifest.largeRedisArchive))
  throw new Error('Converted snapshot lacks large Redis archive verification inventory');
const largeCount = rows(
  await wrangler([
    '--command',
    `SELECT count(*) AS count FROM native_legacy_redis WHERE length(CAST(payload AS BLOB))>${REDIS_ARCHIVE_THRESHOLD_BYTES}`,
  ]),
)[0]?.count;
if (largeCount !== manifest.largeRedisArchive.length) throw new Error('Large Redis archive inventory mismatch');
for (let index = 0; index < manifest.largeRedisArchive.length; index += 1) {
  const expected = manifest.largeRedisArchive[index];
  if (
    !Number.isSafeInteger(expected.payloadBytes) ||
    expected.payloadBytes <= REDIS_ARCHIVE_THRESHOLD_BYTES ||
    expected.payloadBytes > 2 * 1024 ** 2 ||
    !/^[0-9a-f]{64}$/.test(expected.payloadSha256)
  )
    throw new Error('Invalid large Redis archive verification descriptor');
  const select = `FROM native_legacy_redis WHERE length(CAST(payload AS BLOB))>${REDIS_ARCHIVE_THRESHOLD_BYTES} ORDER BY key LIMIT 1 OFFSET ${index}`;
  const metadata = rows(
    await wrangler([
      '--command',
      `SELECT length(CAST(payload AS BLOB)) AS bytes,length(payload) AS characters ${select}`,
    ]),
  )[0];
  if (!metadata || metadata.bytes !== expected.payloadBytes || !Number.isSafeInteger(metadata.characters))
    throw new Error(`Large Redis archive length mismatch at ordinal ${index}`);
  const digest = createHash('sha256');
  for (let position = 1; position <= metadata.characters; position += 8192) {
    const fragment = rows(
      await wrangler(['--command', `SELECT substr(payload,${position},8192) AS fragment ${select}`]),
    )[0]?.fragment;
    if (typeof fragment !== 'string' || !fragment.length)
      throw new Error(`Large Redis archive fragment missing at ordinal ${index}`);
    digest.update(fragment, 'utf8');
  }
  if (digest.digest('hex') !== expected.payloadSha256)
    throw new Error(`Large Redis archive SHA-256 mismatch at ordinal ${index}`);
}
progress.verified = true;
progress.foreignKeyViolations = 0;
progress.completedAt = new Date().toISOString();
await writeFile(receiptPath, JSON.stringify(progress, null, 2));
