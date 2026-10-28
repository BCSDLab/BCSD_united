import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, stat, open } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mysqlValue, parseLossless, quoteIdentifier, rowInsert, sqlLiteral, normalizeUnicodeKey, mergeChatMessage, D1_MAX_BYTES } from './transform.mjs';
import { mongoRows, redisRows } from './state-adapters.mjs';

process.umask(0o077);
const [input, output, offset] = process.argv.slice(2);
if (!input || !output || !/^[+-]\d{2}:\d{2}$/.test(offset ?? '')) throw new Error('Usage: node convert-snapshot.mjs SNAPSHOT_DIR NEW_OUTPUT_DIR SOURCE_DATETIME_OFFSET (for example +09:00). Source DATETIME offset must be established from the live Java/JDBC timezone, never guessed.');
const [offsetHours, offsetMinutes] = offset.slice(1).split(':').map(Number);
if (offsetHours > 14 || offsetMinutes > 59 || (offsetHours === 14 && offsetMinutes !== 0)) throw new Error('Invalid source timezone offset');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = JSON.parse(await readFile(resolve(root, 'scripts/source-schema.json'), 'utf8'));
const schema = JSON.parse(await readFile(resolve(root, 'scripts/schema-manifest.json'), 'utf8'));
const snapshot = JSON.parse(await readFile(resolve(input, 'manifest.json'), 'utf8'));
if (snapshot.format !== 1 || !snapshot.complete || !snapshot.quiesced || snapshot.sourceCommit !== source.sourceCommit) throw new Error('Incomplete/unquiesced/foreign-version snapshot cannot be imported');
if (snapshot.mysqlSessionTimezone !== '+00:00') throw new Error('MySQL TIMESTAMP export must use UTC');
if (!Number.isFinite(Date.parse(snapshot.redisCompletedAt))) throw new Error('Snapshot must record Redis server TIME, not the exporter workstation clock');
const expectedSources = [...source.tables.map(t => `mysql:${t.name}`), ...['citybus_timetables','shuttlebus_timetables','lost_item_chat_room','lost_item_chat_user_block','address_byeongcheon'].map(t => `mongo:${t}`), 'redis'];
for (const expected of expectedSources) if (snapshot.files.filter(f => f.source === expected).length !== 1) throw new Error(`Missing/duplicate snapshot input: ${expected}`);
const allowedSources = new Set([...expectedSources, ...source.tables.map(table => `mysql-ddl:${table.name}`)]);
if (snapshot.files.some(file => !allowedSources.has(file.source)) || new Set(snapshot.files.map(file => file.name)).size !== snapshot.files.length) throw new Error('Unexpected or duplicate snapshot file; no source records may be silently skipped');
for (const file of snapshot.files) {
  if (!/^[a-zA-Z0-9_.-]+$/.test(file.name) || file.name.includes('..')) throw new Error('Unsafe snapshot path');
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(resolve(input, file.name))) { hash.update(chunk); bytes += chunk.length; }
  if (bytes !== file.bytes || hash.digest('hex') !== file.sha256) throw new Error(`Corrupt snapshot file: ${file.name}`);
}
await mkdir(resolve(output), { recursive: false });
const checkpoint = { format: 1, sourceCommit: source.sourceCommit, snapshotHash: createHash('sha256').update(await readFile(resolve(input, 'manifest.json'))).digest('hex'), complete: false, datetimeOffset: offset, sourceCounts: {}, destinationCounts: {}, files: [], limitations: ['Unicode registry uses NFKD/casefold approximation, not exact MySQL UCA4/UCA9/general_ci. Validate actual source WEIGHT_STRING equality before cutover; SQL NOCASE queries remain ASCII-only.', 'Date/time calendar values are preserved; new_koreatech_articles.registered_at and citybus_timetables.updated_at are explicitly calendar semantics.', 'D1 TEXT bigint must use CAST(... AS INTEGER) for numerical sorting; lexical sorting is not a numeric-order substitute.', 'Mongo/Redis capture requires all source writes stopped; exported TTLs are absolute and expired records are retained in native_legacy_redis only.'] };
await writeFile(resolve(output, 'manifest.json'), JSON.stringify(checkpoint, null, 2));
const databasePath = resolve(output, 'validated.sqlite');
const db = new DatabaseSync(databasePath);
db.exec('PRAGMA foreign_keys=OFF;');
const migrationNames = (await readdir(resolve(root, 'drizzle'))).filter(name => /^\d+.*\.sql$/.test(name)).sort();
for (const name of migrationNames) db.exec(await readFile(resolve(root, 'drizzle', name), 'utf8'));
db.exec("UPDATE native_import_control SET active=1 WHERE id='import'; DELETE FROM dining_soldout_report_sequence;");
let totalRows = 0;
const insertCache = new Map();
const tableByName = new Map(schema.tables.map(table => [table.name, table]));
function assertSize() {
  const page = db.prepare('PRAGMA page_count').get().page_count;
  const size = db.prepare('PRAGMA page_size').get().page_size;
  if (page * size > D1_MAX_BYTES) throw new RangeError('Database exceeds D1 10GB capacity; sharding or explicit scope approval required');
}
function insert(tableName, row) {
  const table = tableByName.get(tableName);
  if (!table) throw new Error(`Unknown target table ${tableName}`);
  for (const name of Object.keys(row)) if (!table.columns.some(c => c.name === name && !c.expression)) throw new Error(`Unknown/generated target column ${tableName}.${name}`);
  rowInsert(tableName, row);
  if (tableName === 'native_chat_message') {
    const previous = db.prepare('SELECT * FROM native_chat_message WHERE id=?').get(row.id);
    if (previous) {
      const merged = mergeChatMessage(previous, row);
      db.prepare('UPDATE native_chat_message SET is_read=?,is_deleted=?,is_image=?,created_at=? WHERE id=?').run(merged.is_read, merged.is_deleted, merged.is_image, merged.created_at, row.id);
      return;
    }
  }
  const keys = Object.keys(row);
  const key = tableName + ':' + keys.join(',');
  let statement = insertCache.get(key);
  if (!statement) { statement = db.prepare(`INSERT INTO ${quoteIdentifier(tableName)} (${keys.map(quoteIdentifier).join(',')}) VALUES (${keys.map(() => '?').join(',')})`); insertCache.set(key, statement); }
  statement.run(...Object.values(row));
  totalRows += 1;
  if (totalRows % 1000 === 0) assertSize();
}
async function lines(file, handler) {
  let count = 0;
  for await (const line of createInterface({ input: createReadStream(resolve(input, file.name)), crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    count += 1;
    try { handler(parseLossless(line)); } catch (error) { throw new Error(`${file.name}:${count}: ${error.message}`, { cause: error }); }
  }
  if (count !== file.count) throw new Error(`Row count mismatch: ${file.name}`);
  checkpoint.sourceCounts[file.source] = count;
}
try {
  db.exec('BEGIN;');
  for (const table of source.tables) {
    const file = snapshot.files.find(f => f.source === `mysql:${table.name}`);
    const columns = source.columns.filter(c => c.table === table.name);
    await lines(file, record => {
      for (const key of Object.keys(record)) if (!columns.some(c => c.name === key)) throw new Error(`Unrecognized source column ${table.name}.${key}`);
      const row = {};
      for (const column of columns) {
        if (column.expression) continue;
        if (!(column.name in record)) throw new Error(`Missing source column ${table.name}.${column.name}`);
        row[column.name] = table.name === 'new_koreatech_articles' && column.name === 'registered_at' ? String(record[column.name]) : mysqlValue(column, record[column.name], offset);
      }
      insert(table.name, row);
    });
  }
  for (const file of snapshot.files.filter(f => f.source.startsWith('mongo:'))) await lines(file, record => { for (const entry of mongoRows(file.source.slice(6), record, { offset })) insert(entry.table, entry.row); });
  const redis = snapshot.files.find(f => f.source === 'redis');
  const dispositions = {};
  await lines(redis, record => { const result = redisRows(record, { db, offset, now: Date.parse(snapshot.redisCompletedAt) }); for (const entry of result.rows) insert(entry.table, entry.row); dispositions[result.disposition] = (dispositions[result.disposition] ?? 0) + 1; });
  checkpoint.redisDispositions = dispositions;
  const stopwords = ['a','an','as','at','be','by','de','en','i','in','is','it','la','of','on','or','to'];
  for (const article of db.prepare('SELECT id,title FROM new_articles').iterate()) {
    let position = 0;
    for (const word of String(article.title).normalize('NFC').toLowerCase().split(/\s+/u)) {
      const chars = Array.from(word);
      for (let i = 0; i + 1 < chars.length; i += 1) { const token = chars[i] + chars[i + 1]; const current = position++; if (!stopwords.some(stopword => token.includes(stopword))) insert('native_article_ngram', { article_id: article.id, position: current, token }); }
    }
  }
  const indexes = Object.values(Object.groupBy(source.indexes.filter(i => i.unique), i => i.table + ':' + i.name));
  for (const index of indexes) {
    const columns = index.map(i => source.columns.find(c => c.table === i.table && c.name === i.column));
    if (!columns.some(c => c.collation?.endsWith('_ci'))) continue;
    const table = tableByName.get(index[0].table);
    for (const row of db.prepare(`SELECT * FROM ${quoteIdentifier(table.name)}`).iterate()) {
      if (columns.some(c => row[c.name] === null)) continue;
      const owner = JSON.stringify(table.primaryKey.map(name => row[name]));
      const normalized = JSON.stringify(columns.map(c => c.collation ? normalizeUnicodeKey(row[c.name], c.collation) : row[c.name]));
      insert('native_collation_key', { scope: table.name + ':' + index[0].name, owner, normalized });
    }
  }
  for (const table of ['notification','notification_subscribe']) db.prepare('UPDATE native_sequence SET value=CAST((SELECT COALESCE(MAX(CAST(id AS INTEGER)),0) FROM ' + quoteIdentifier(table) + ') AS TEXT) WHERE id=?').run(table);
  db.exec("UPDATE native_import_control SET active=0 WHERE id='import'; COMMIT;");
  db.exec('PRAGMA foreign_keys=ON;');
  const violations = db.prepare('PRAGMA foreign_key_check').all();
  if (violations.length) throw new Error(`Foreign key violations: ${JSON.stringify(violations.slice(0, 20))}`);
  const integrity = db.prepare('PRAGMA integrity_check').all();
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error(`SQLite integrity check failed: ${JSON.stringify(integrity)}`);
  assertSize();
  for (const table of schema.tables) checkpoint.destinationCounts[table.name] = db.prepare(`SELECT count(*) AS count FROM ${quoteIdentifier(table.name)}`).get().count;
  for (const table of source.tables) if (checkpoint.destinationCounts[table.name] !== checkpoint.sourceCounts[`mysql:${table.name}`]) throw new Error(`Source/destination count differs: ${table.name}`);

  const dependencies = new Map(schema.tables.map(t => [t.name, new Set()]));
  for (const foreign of source.fks) dependencies.get(foreign.table).add(foreign.refTable);
  for (const table of schema.tables) for (const column of table.columns) if (column.ref) dependencies.get(table.name).add(column.ref);
  let nextIndex = 0;
  const indexOf = new Map(), low = new Map(), stack = [], stacked = new Set(), components = [];
  function visit(name) {
    indexOf.set(name, nextIndex); low.set(name, nextIndex++); stack.push(name); stacked.add(name);
    for (const parent of dependencies.get(name)) { if (!indexOf.has(parent)) { visit(parent); low.set(name, Math.min(low.get(name), low.get(parent))); } else if (stacked.has(parent)) low.set(name, Math.min(low.get(name), indexOf.get(parent))); }
    if (low.get(name) === indexOf.get(name)) { const component = []; let current; do { current = stack.pop(); stacked.delete(current); component.push(current); } while (current !== name); components.push(component.sort()); }
  }
  for (const name of dependencies.keys()) if (!indexOf.has(name)) visit(name);
  const schemaSql = (await Promise.all(migrationNames.map(name => readFile(resolve(root, 'drizzle', name), 'utf8')))).join('\n');
  const schemaHash = createHash('sha256').update(schemaSql).digest('hex');
  const setupSql = schemaSql + `\nINSERT INTO native_import_checkpoint(id,sha256,row_count,completed_at) VALUES('__schema__',${sqlLiteral(schemaHash)},0,CURRENT_TIMESTAMP);\n`;
  const setupName = '0000-schema.sql';
  await writeFile(resolve(output, setupName), setupSql);
  checkpoint.files.push({ name: setupName, kind: 'schema', schemaHash, sha256: createHash('sha256').update(setupSql).digest('hex'), bytes: Buffer.byteLength(setupSql) });
  let part = 1;
  for (const component of components) {
    const names = component.filter(name => name !== 'native_import_checkpoint' && name !== 'native_import_control');
    if (!names.length) continue;
    const filename = String(part++).padStart(4, '0') + '-data.sql';
    const handle = await open(resolve(output, filename), 'wx');
    const hash = createHash('sha256'); let bytes = 0; let rows = 0;
    const append = async text => { const line = text + '\n'; bytes += Buffer.byteLength(line); if (bytes > 5 * 1024 ** 3) throw new RangeError(`Strongly connected FK component exceeds D1 5GiB import file limit: ${names.join(',')}`); hash.update(line); await handle.write(line); };
    try {
      await append("PRAGMA defer_foreign_keys=ON; UPDATE native_import_control SET active=1 WHERE id='import';");
      for (const name of names) {
        if (['native_sequence','native_dining_guard','dining_soldout_report_sequence'].includes(name)) await append(`DELETE FROM ${quoteIdentifier(name)};`);
        const table = tableByName.get(name);
        const columns = table.columns.filter(c => !c.expression).map(c => c.name);
        for (const row of db.prepare(`SELECT ${columns.map(quoteIdentifier).join(',')} FROM ${quoteIdentifier(name)} ORDER BY ${table.primaryKey.map(quoteIdentifier).join(',')}`).iterate()) { await append(rowInsert(name, row)); rows += 1; }
      }
      const dataHash = hash.copy().digest('hex');
      await append(`INSERT INTO native_import_checkpoint(id,sha256,row_count,completed_at) VALUES(${sqlLiteral(filename)},${sqlLiteral(dataHash)},${rows},CURRENT_TIMESTAMP);`);
      await append("UPDATE native_import_control SET active=0 WHERE id='import';");
      checkpoint.files.push({ name: filename, kind: 'data', tables: names, rows, dataHash, sha256: hash.digest('hex'), bytes });
    } finally { await handle.close(); }
    await writeFile(resolve(output, 'manifest.json'), JSON.stringify(checkpoint, null, 2));
  }
  checkpoint.foreignKeyViolations = 0;
  checkpoint.sqliteBytes = (await stat(databasePath)).size;
  checkpoint.complete = true;
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify(checkpoint, null, 2));
} catch (error) {
  try { db.exec('ROLLBACK;'); } catch {}
  checkpoint.error = error.message;
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify(checkpoint, null, 2));
  throw error;
} finally { db.close(); }
