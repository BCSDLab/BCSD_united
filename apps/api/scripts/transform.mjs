export const D1_MAX_BYTES = 10_000_000_000;
export const D1_MAX_ROW_BYTES = 2 * 1024 ** 2;
export const D1_MAX_STATEMENT_BYTES = 100_000;
export const parseLossless = (text) => JSON.parse(text, (_key, value, context) => typeof value === 'number' && !Number.isSafeInteger(value) && Number.isInteger(value) ? context.source : value);
export const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;
export function sqlLiteral(value) {
  if (value === null) return 'NULL';
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString('hex')}'`;
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new RangeError('Unsafe numeric SQL value');
    return String(value);
  }
  if (typeof value !== 'string') throw new TypeError('SQL value must already be transformed');
  if (value.includes('\0')) return `CAST(X'${Buffer.from(value, 'utf8').toString('hex')}' AS TEXT)`;
  return `'${value.replaceAll("'", "''")}'`;
}
export function signed64(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new RangeError('64-bit identifier already lost precision');
  const text = String(value);
  if (!/^-?(0|[1-9][0-9]*)$/.test(text) || text === '-0') throw new TypeError(`Invalid canonical int64: ${text}`);
  const integer = BigInt(text);
  if (integer < -9223372036854775808n || integer > 9223372036854775807n) throw new RangeError('Outside signed int64');
  return text;
}
export function utcTimestamp(value, offset = '+00:00') {
  if (typeof value !== 'string') throw new TypeError('Timestamp must be an unparsed string');
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match || match[1].startsWith('0000')) throw new TypeError(`Invalid source timestamp: ${value}`);
  const fraction = match[3] ?? '';
  const instant = new Date(`${match[1]}T${match[2]}${match[4] ?? offset}`);
  if (!Number.isFinite(instant.getTime())) throw new TypeError(`Invalid timestamp: ${value}`);
  const calendar = new Date(`${match[1]}T${match[2]}Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 19) !== `${match[1]}T${match[2]}`) throw new TypeError(`Invalid calendar timestamp: ${value}`);
  return instant.toISOString().slice(0, 19).replace('T', ' ') + fraction;
}
export function normalizeUnicodeKey(value, collation) {
  let text = String(value);
  if (!collation.includes('_0900_')) text = text.replace(/ +$/u, '');
  if (collation.endsWith('_ci')) {
    const general = collation.endsWith('_general_ci');
    text = text.normalize(general ? 'NFD' : 'NFKD').toLowerCase().replace(/\p{M}/gu, '').replaceAll('ς', 'σ').replaceAll('ß', general ? 's' : 'ss');
    if (!general) text = text.replaceAll('œ', 'oe');
    if (collation.includes('_0900_')) text = text.replaceAll('æ', 'ae').replaceAll('ł', 'l').replaceAll('đ', 'd').replaceAll('ø', 'o');
  }
  return text;
}
export function mysqlValue(column, value, datetimeOffset) {
  if (value === null) {
    if (column.nullable === 'NO') throw new TypeError(`NULL in required ${column.table}.${column.name}`);
    return null;
  }
  if (column.type === 'bigint') return signed64(value);
  if (column.type === 'binary') {
    if (!value || typeof value.$binary !== 'string') throw new TypeError(`Missing binary envelope: ${column.name}`);
    const binary = Buffer.from(value.$binary, 'base64');
    if (binary.length !== column.length) throw new TypeError(`Invalid binary length: ${column.name}`);
    if (column.length !== 16) return binary;
    const hex = binary.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  if (column.type === 'timestamp' || column.type === 'datetime') return utcTimestamp(String(value), column.type === 'timestamp' ? '+00:00' : datetimeOffset);
  if (column.type === 'json') {
    if (typeof value === 'string') { parseLossless(value); return value; }
    return JSON.stringify(value);
  }
  if (column.type === 'decimal') {
    if (typeof value !== 'string') throw new TypeError('DECIMAL must be exported as an exact string, never a JSON number');
    const text = String(value);
    if (!/^-?\d+(\.\d+)?$/.test(text)) throw new TypeError('Invalid exact decimal');
    if ((text.split('.')[1]?.length ?? 0) > column.scale) throw new RangeError('Decimal scale overflow');
    return text;
  }
  if (['int', 'smallint', 'tinyint'].includes(column.type)) {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new RangeError(`Invalid integer: ${column.name}`);
    if (column.columnType === 'tinyint(1)' && number !== 0 && number !== 1) throw new RangeError(`Nonboolean TINYINT(1): ${column.name}`);
    return number;
  }
  if (column.type === 'double') {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new RangeError('Non-finite DOUBLE');
    return number;
  }
  return String(value);
}
export function rowInsert(table, row) {
  const values = Object.values(row);
  const size = values.reduce((sum, value) => sum + (value instanceof Uint8Array ? value.byteLength : Buffer.byteLength(String(value ?? ''))), values.length * 9 + 16);
  if (size > D1_MAX_ROW_BYTES) throw new RangeError(`D1 row exceeds 2MiB: ${table}`);
  const statement = `INSERT INTO ${quoteIdentifier(table)} (${Object.keys(row).map(quoteIdentifier).join(',')}) VALUES (${values.map(sqlLiteral).join(',')});`;
  if (Buffer.byteLength(statement) > D1_MAX_STATEMENT_BYTES) throw new RangeError(`D1 SQL statement exceeds 100KB: ${table}; parameterized/manual large-object migration required, no truncation performed`);
  return statement;
}
export function decodeExtendedJson(value) {
  if (Array.isArray(value)) return value.map(decodeExtendedJson);
  if (!value || typeof value !== 'object') return value;
  if ('$oid' in value) return value.$oid;
  if ('$numberLong' in value) { const text = signed64(value.$numberLong); const number = Number(text); return Number.isSafeInteger(number) ? number : text; }
  if ('$numberInt' in value) { const number = Number(value.$numberInt); if (!Number.isInteger(number) || number < -2147483648 || number > 2147483647) throw new TypeError('Invalid BSON int32'); return number; }
  if ('$numberDouble' in value) { const number = Number(value.$numberDouble); if (!Number.isFinite(number)) throw new TypeError('Non-finite BSON double cannot be represented in D1 JSON'); return number; }
  if ('$numberDecimal' in value) return value.$numberDecimal;
  if ('$date' in value) {
    const date = value.$date;
    return new Date(typeof date === 'object' ? Number(date.$numberLong) : date).toISOString();
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeExtendedJson(item)]));
}
export function mergeChatMessage(previous, incoming) {
  if (!previous) return incoming;
  for (const key of ['id', 'article_id', 'chatroom_id', 'user_id', 'nick_name', 'contents']) {
    if (previous[key] !== incoming[key]) throw new Error(`Conflicting Mongo/Redis chat message ${incoming.id}: ${key}`);
  }
  if (previous.is_image !== null && incoming.is_image !== null && previous.is_image !== incoming.is_image) throw new Error(`Conflicting message image flag ${incoming.id}`);
  const previousFraction = previous.created_at.match(/\.(\d+)/)?.[1] ?? '';
  const incomingFraction = incoming.created_at.match(/\.(\d+)/)?.[1] ?? '';
  if (Date.parse(previous.created_at) !== Date.parse(incoming.created_at) || (previousFraction.length > 3 && incomingFraction.length > 3 && previousFraction.padEnd(9, '0') !== incomingFraction.padEnd(9, '0'))) throw new Error(`Conflicting message timestamp ${incoming.id}`);
  const created_at = incomingFraction.length > previousFraction.length ? incoming.created_at : previous.created_at;
  return { ...previous, created_at, is_read: Number(Boolean(previous.is_read || incoming.is_read)), is_deleted: Number(Boolean(previous.is_deleted || incoming.is_deleted)), is_image: incoming.is_image ?? previous.is_image };
}
