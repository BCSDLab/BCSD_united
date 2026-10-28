import { createConnection } from 'mysql2/promise';
import { createConnection as connectTcp } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, open, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

process.umask(0o077);
const args = process.argv.slice(2);
const output = args[0];
if (!output || !args.includes('--sources-quiesced')) throw new Error('Usage: node export-sources.mjs OUT --sources-quiesced; stop all source writes across MySQL/Mongo/Redis before capture. MYSQL_URL, MONGO_URI, MONGO_DATABASE, REDIS_URL required.');
for (const name of ['MYSQL_URL', 'MONGO_URI', 'MONGO_DATABASE', 'REDIS_URL']) if (!process.env[name]) throw new Error(`Missing ${name}`);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(await readFile(resolve(root, 'scripts/source-schema.json'), 'utf8'));
const out = resolve(output);
await mkdir(out, { recursive: false, mode: 0o700 });
const manifest = { format: 1, complete: false, sourceCommit: schema.sourceCommit, quiesced: true, startedAt: new Date().toISOString(), files: [], mysqlSessionTimezone: '+00:00' };
await writeFile(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
async function recordFile(name, source, count) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(resolve(out, name))) { hash.update(chunk); bytes += chunk.length; }
  manifest.files.push({ name, source, count, bytes, sha256: hash.digest('hex') });
  await writeFile(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
}
const mysql = await createConnection({ uri: process.env.MYSQL_URL, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, decimalNumbers: false, jsonStrings: true, timezone: 'Z', rowsAsArray: false });
try {
  await mysql.query("SET SESSION time_zone = '+00:00'");
  await mysql.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  await mysql.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
  const [tables] = await mysql.query('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE=\'BASE TABLE\' ORDER BY TABLE_NAME');
  const actualNames = tables.map(t => t.name).filter(name => name !== 'flyway_schema_history');
  if (JSON.stringify(actualNames) !== JSON.stringify(schema.tables.map(t => t.name))) throw new Error('Live table inventory differs from the 165-table source contract; reconcile schema before export');
  const [columns] = await mysql.query('SELECT TABLE_NAME AS `table`, COLUMN_NAME AS name, COLUMN_TYPE AS columnType, IS_NULLABLE AS nullable, EXTRA AS extra, COLUMN_DEFAULT AS `default`, COLLATION_NAME AS collation, GENERATION_EXPRESSION AS expression FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION');
  for (const column of schema.columns) {
    const actual = columns.find(c => c.table === column.table && c.name === column.name);
    if (!actual || ['columnType','nullable','extra','default','collation'].some(key => actual[key] !== column[key]) || actual.expression !== (column.expression ?? '')) throw new Error(`Live column mismatch: ${column.table}.${column.name}`);
  }
  const [indexes] = await mysql.query('SELECT TABLE_NAME AS `table`,INDEX_NAME AS name,NON_UNIQUE AS nonUnique,SEQ_IN_INDEX AS position,COLUMN_NAME AS `column`,SUB_PART AS prefix,INDEX_TYPE AS type,EXPRESSION AS expression FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME <> \'flyway_schema_history\' ORDER BY TABLE_NAME,INDEX_NAME,SEQ_IN_INDEX');
  const indexShape = row => [row.table,row.name,row.position,row.column,row.prefix,row.type,row.expression,Boolean(row.unique ?? row.nonUnique === 0)];
  if (JSON.stringify(indexes.map(indexShape)) !== JSON.stringify(schema.indexes.map(indexShape))) throw new Error('Live indexes differ from final source schema');
  const [foreignKeys] = await mysql.query('SELECT k.TABLE_NAME AS `table`,k.CONSTRAINT_NAME AS name,k.COLUMN_NAME AS `column`,k.REFERENCED_TABLE_NAME AS refTable,k.REFERENCED_COLUMN_NAME AS refColumn,k.ORDINAL_POSITION AS position,r.DELETE_RULE AS `delete`,r.UPDATE_RULE AS `update` FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME WHERE k.TABLE_SCHEMA=DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.TABLE_NAME,k.CONSTRAINT_NAME,k.ORDINAL_POSITION');
  const foreignShape = row => [row.table,row.name,row.column,row.refTable,row.refColumn,row.position,row.delete,row.update];
  if (JSON.stringify(foreignKeys.map(foreignShape)) !== JSON.stringify(schema.fks.map(foreignShape))) throw new Error('Live foreign keys differ from final source schema');
  const [checks] = await mysql.query('SELECT t.TABLE_NAME AS `table`,c.CONSTRAINT_NAME AS name,c.CHECK_CLAUSE AS clause FROM information_schema.CHECK_CONSTRAINTS c JOIN information_schema.TABLE_CONSTRAINTS t ON t.CONSTRAINT_SCHEMA=c.CONSTRAINT_SCHEMA AND t.CONSTRAINT_NAME=c.CONSTRAINT_NAME WHERE c.CONSTRAINT_SCHEMA=DATABASE()');
  const checkShape = rows => rows.map(row => JSON.stringify([row.table,row.name,row.clause])).sort();
  if (JSON.stringify(checkShape(checks)) !== JSON.stringify(checkShape(schema.checks))) throw new Error('Live CHECK constraints differ from final source schema');
  if (tables.some(t => t.name === 'flyway_schema_history')) {
    const [history] = await mysql.query('SELECT * FROM flyway_schema_history ORDER BY installed_rank');
    manifest.flyway = history;
    if (!history.some(row => String(row.version) === '20' && row.success === 1)) throw new Error('Flyway V20 is not successful on source');
  } else throw new Error('Live flyway_schema_history required to prove source version; baseline-only dump is not sufficient');
  for (const table of schema.tables) {
    const name = table.name;
    const quote = '`' + name.replaceAll('`', '``') + '`';
    const [create] = await mysql.query(`SHOW CREATE TABLE ${quote}`);
    await writeFile(resolve(out, `${name}.mysql-ddl.json`), JSON.stringify(create[0], null, 2));
    const [total] = await mysql.query(`SELECT COUNT(*) AS count FROM ${quote}`);
    const file = `${name}.mysql.jsonl`;
    const handle = await open(resolve(out, file), 'wx');
    const primary = schema.indexes.filter(i => i.table === name && i.name === 'PRIMARY').map(i => '`' + i.column + '`').join(',');
    if (!primary) throw new Error(`Source table lacks stable primary key: ${name}`);
    let offset = 0;
    try {
      for (;;) {
        const [rows] = await mysql.query(`SELECT * FROM ${quote} ORDER BY ${primary} LIMIT 1000 OFFSET ?`, [offset]);
        if (!rows.length) break;
        for (const row of rows) {
          const encoded = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Buffer.isBuffer(value) ? { $binary: value.toString('base64') } : value]));
          await handle.write(JSON.stringify(encoded) + '\n');
        }
        offset += rows.length;
      }
    } finally { await handle.close(); }
    if (String(offset) !== String(total[0].count)) throw new Error(`Snapshot count mismatch ${name}`);
    await recordFile(file, `mysql:${name}`, offset);
    await recordFile(`${name}.mysql-ddl.json`, `mysql-ddl:${name}`, 1);
  }
  await mysql.rollback();
} finally { await mysql.end(); }

const collections = ['citybus_timetables', 'shuttlebus_timetables', 'lost_item_chat_room', 'lost_item_chat_user_block', 'address_byeongcheon'];
const inventoryScript = `const source = db.getSiblingDB(${JSON.stringify(process.env.MONGO_DATABASE)}); print(JSON.stringify(source.getCollectionInfos().filter(item => !item.name.startsWith('system.')).map(item => ({name:item.name,type:item.type,count:source.getCollection(item.name).countDocuments({})}))));`;
const inventoryProcess = spawn('mongosh', [process.env.MONGO_URI, '--quiet', '--eval', inventoryScript], { stdio: ['ignore', 'pipe', 'pipe'] });
let inventoryOutput = '';
inventoryProcess.stdout.on('data', chunk => { inventoryOutput += chunk; });
inventoryProcess.stderr.resume();
await new Promise((success, failure) => { inventoryProcess.once('error', failure); inventoryProcess.once('exit', code => code === 0 ? success() : failure(new Error(`Mongo inventory failed (${code}); require read-only listCollections/count permissions`))); });
manifest.mongoInventory = JSON.parse(inventoryOutput);
if (manifest.mongoInventory.some(item => !collections.includes(item.name) || item.type !== 'collection')) throw new Error('Unmapped live Mongo collection/view; reconcile source contract before export');
for (const collection of collections) {
  const name = `${collection}.mongo.jsonl`;
  const child = spawn('mongoexport', ['--uri', process.env.MONGO_URI, '--db', process.env.MONGO_DATABASE, '--collection', collection, '--jsonFormat=canonical', '--out', resolve(out, name)], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.resume();
  await new Promise((success, failure) => { child.once('error', failure); child.once('exit', code => code === 0 ? success() : failure(new Error(`mongoexport failed (${collection}); check credentials/connectivity, exit ${code}`))); });
  let count = 0;
  for await (const line of createInterface({ input: createReadStream(resolve(out, name)) })) if (line) count += 1;
  const expected = manifest.mongoInventory.find(item => item.name === collection)?.count ?? 0;
  if (count !== expected) throw new Error(`Mongo snapshot count mismatch: ${collection}`);
  await recordFile(name, `mongo:${collection}`, count);
}

class RedisReader {
  constructor(url) {
    this.url = new URL(url);
    this.socket = this.url.protocol === 'rediss:' ? connectTls({ host: this.url.hostname, port: Number(this.url.port || 6379), servername: this.url.hostname }) : connectTcp({ host: this.url.hostname, port: Number(this.url.port || 6379) });
    this.buffer = Buffer.alloc(0);
    this.pending = [];
    this.socket.on('data', chunk => { this.buffer = Buffer.concat([this.buffer, chunk]); this.consume(); });
    this.socket.on('error', error => { for (const job of this.pending.splice(0)) job.reject(error); });
  }
  parse(offset = 0) {
    const end = this.buffer.indexOf('\r\n', offset);
    if (end < 0) return null;
    const type = String.fromCharCode(this.buffer[offset]);
    const value = this.buffer.subarray(offset + 1, end).toString();
    let next = end + 2;
    if (type === '$') {
      const size = Number(value);
      if (size === -1) return [null, next];
      if (this.buffer.length < next + size + 2) return null;
      return [this.buffer.subarray(next, next + size), next + size + 2];
    }
    if (type === '*') {
      if (Number(value) === -1) return [null, next];
      const items = [];
      for (let i = 0; i < Number(value); i += 1) { const item = this.parse(next); if (!item) return null; items.push(item[0]); next = item[1]; }
      return [items, next];
    }
    if (type === '-') return [new Error(value), next];
    return [type === ':' ? Number(value) : value, next];
  }
  consume() {
    while (this.pending.length) { const result = this.parse(); if (!result) return; this.buffer = this.buffer.subarray(result[1]); const job = this.pending.shift(); result[0] instanceof Error ? job.reject(result[0]) : job.resolve(result[0]); }
  }
  command(...parts) {
    return new Promise((resolve, reject) => { this.pending.push({ resolve, reject }); const values = parts.map(part => Buffer.isBuffer(part) ? part : Buffer.from(String(part))); this.socket.write(Buffer.concat([Buffer.from(`*${values.length}\r\n`), ...values.flatMap(value => [Buffer.from(`$${value.length}\r\n`), value, Buffer.from('\r\n')])])); });
  }
}
const redis = new RedisReader(process.env.REDIS_URL);
const redisFile = await open(resolve(out, 'redis.jsonl'), 'wx');
const utf8 = new TextDecoder('utf-8', { fatal: true });
const text = value => Buffer.isBuffer(value) ? utf8.decode(value) : value;
const encode = value => Buffer.isBuffer(value) ? { base64: value.toString('base64') } : Array.isArray(value) ? value.map(encode) : value;
let redisCount = 0;
try {
  if (redis.url.password) await redis.command('AUTH', ...(redis.url.username ? [decodeURIComponent(redis.url.username)] : []), decodeURIComponent(redis.url.password));
  if (redis.url.pathname.length > 1) await redis.command('SELECT', redis.url.pathname.slice(1));
  const seen = new Set();
  let cursor = '0';
  do {
    const result = await redis.command('SCAN', cursor, 'COUNT', 1000);
    cursor = text(result[0]);
    for (const key of result[1]) {
      const identity = key.toString('base64');
      if (seen.has(identity)) continue;
      seen.add(identity);
      const lease = await redis.command('EVAL', "local clock=redis.call('TIME'); return {clock[1],clock[2],redis.call('PTTL',KEYS[1])}", 1, key);
      const capturedAt = Number(text(lease[0])) * 1000 + Math.floor(Number(text(lease[1])) / 1000);
      const type = text(await redis.command('TYPE', key));
      if (type === 'none') continue;
      const ttl = lease[2];
      if (ttl === -2) continue;
      const commands = { string: ['GET'], hash: ['HGETALL'], set: ['SMEMBERS'], zset: ['ZRANGE', 0, -1, 'WITHSCORES'], list: ['LRANGE', 0, -1], stream: ['XRANGE', '-', '+'] };
      const command = commands[type];
      if (!command) throw new Error(`Unsupported Redis type ${type}; export aborted without data loss`);
      const value = await redis.command(command[0], key, ...command.slice(1));
      await redisFile.write(JSON.stringify({ key: text(key), type, capturedAt, expiresAt: ttl < 0 ? null : capturedAt + ttl, value: encode(value) }) + '\n');
      redisCount += 1;
    }
  } while (cursor !== '0');
  const completedTime = await redis.command('TIME');
  manifest.redisCompletedAt = new Date(Number(text(completedTime[0])) * 1000 + Math.floor(Number(text(completedTime[1])) / 1000)).toISOString();
} finally { await redisFile.close(); redis.socket.end(); }
await recordFile('redis.jsonl', 'redis', redisCount);
manifest.complete = true;
manifest.completedAt = new Date().toISOString();
await writeFile(resolve(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
