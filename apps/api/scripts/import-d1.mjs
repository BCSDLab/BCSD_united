import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { D1_MAX_BYTES } from './transform.mjs';
import { metadataSources, metadataVerifier } from './source-metadata.mjs';

const wranglerEntry = resolve(dirname(fileURLToPath(import.meta.resolve('wrangler/package.json'))), 'bin/wrangler.js');
const appDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const [directory, database, mode] = process.argv.slice(2);
if (!directory || !database || !['--local', '--remote'].includes(mode))
  throw new Error(
    'Usage: node import-d1.mjs CONVERTED_DIR DATABASE_NAME --local|--remote. Target must be NEW and receive no application traffic until verification completes.',
  );
const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
if (!manifest.complete || manifest.foreignKeyViolations !== 0)
  throw new Error('Only completely validated snapshots may be imported');
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
    const child = spawn(process.execPath, [wranglerEntry, 'd1', 'execute', database, mode, '--json', ...args], {
      cwd: appDirectory,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', failure);
    child.once('exit', (code) => {
      if (code !== 0) {
        failure(new Error(`Wrangler D1 command failed (${code}): ${stderr}`));
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
const progress = { snapshotHash: manifest.snapshotHash, database, mode, imported: [], verified: false };
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
  await writeFile(resolve(directory, `import-${mode.slice(2)}.json`), JSON.stringify(progress, null, 2));
}
for (const [table, expected] of Object.entries(manifest.destinationCounts)) {
  if (table === 'native_import_checkpoint') continue;
  const actual = rows(await wrangler(['--command', `SELECT count(*) AS count FROM ${identifier(table)}`]))[0]?.count;
  if (actual !== expected) throw new Error(`Target row count mismatch ${table}: ${actual} != ${expected}`);
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
const active = rows(await wrangler(['--command', "SELECT active FROM native_import_control WHERE id='import'"]))[0];
if (active?.active !== 0) throw new Error('Import-mode business guards remain disabled');
const storage = rows(
  await wrangler([
    '--command',
    'SELECT (SELECT page_count FROM pragma_page_count)*(SELECT page_size FROM pragma_page_size) AS bytes',
  ]),
)[0]?.bytes;
if (!Number.isSafeInteger(storage) || storage > D1_MAX_BYTES)
  throw new Error('D1 final storage size exceeds 10GB or could not be measured');
progress.verified = true;
progress.foreignKeyViolations = 0;
progress.completedAt = new Date().toISOString();
await writeFile(resolve(directory, `import-${mode.slice(2)}.json`), JSON.stringify(progress, null, 2));
