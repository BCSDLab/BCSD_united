import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, rename, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

export const MiB = 1024 * 1024;
export const MAX_OBJECT_BYTES = 5 * 1024 ** 4 - 5 * 1024 ** 3;

export function canonical(value) {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export function sdkData(value) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== '$metadata'));
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function partSizeFor(size) {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_OBJECT_BYTES)
    throw new Error('Object size exceeds supported R2 multipart range');
  return Math.max(8 * MiB, Math.ceil(size / 10000 / MiB) * MiB);
}

export async function* parts(body, size, expectedBytes) {
  let buffer = Buffer.allocUnsafe(Math.min(size, expectedBytes));
  let used = 0;
  let total = 0;
  for await (const chunk of body) {
    if (!(chunk instanceof Uint8Array)) throw new Error('Expected binary source stream');
    total += chunk.byteLength;
    if (total > expectedBytes) throw new Error('Source stream exceeds snapshot length');
    let offset = 0;
    while (offset < chunk.byteLength) {
      const length = Math.min(buffer.length - used, chunk.byteLength - offset);
      buffer.set(chunk.subarray(offset, offset + length), used);
      offset += length;
      used += length;
      if (used === buffer.length) {
        yield buffer;
        buffer = Buffer.allocUnsafe(Math.min(size, expectedBytes - (total - chunk.byteLength + offset)));
        used = 0;
      }
    }
  }
  if (total !== expectedBytes) throw new Error('Source stream ended before snapshot length');
  if (used) yield buffer.subarray(0, used);
}

export async function hashBody(body) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of body) {
    hash.update(chunk);
    bytes += chunk.byteLength;
  }
  return { bytes, sha256: hash.digest('hex') };
}

export async function* jsonLines(path) {
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    if (line) yield JSON.parse(line);
  }
}

export async function durableJson(path, value) {
  const temporary = `${path}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try {
    await handle.writeFile(canonical(value) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  if (process.platform !== 'win32') {
    const directory = await open(dirname(path), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}

export async function optionalJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export const preservedFields = [
  'ContentType',
  'CacheControl',
  'ContentDisposition',
  'ContentLanguage',
  'ContentEncoding',
  'Expires',
  'Metadata',
];
export function objectMetadata(head) {
  return Object.fromEntries(preservedFields.filter((key) => head[key] !== undefined).map((key) => [key, head[key]]));
}

export function assertCheckpoint(record, object, snapshot) {
  if (
    !record ||
    record.snapshot !== snapshot ||
    record.key !== object.key ||
    record.sourceFingerprint !== sha256(canonical(object))
  )
    throw new Error('Object checkpoint does not match source snapshot');
}

export function hasVersionReference(value) {
  if (typeof value === 'string') {
    let decoded = value;
    for (let i = 0; i < 3; i += 1) {
      if (/[?&](?:versionId|version_id)=/i.test(decoded)) return true;
      try {
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      } catch {
        break;
      }
    }
    return false;
  }
  if (value && typeof value === 'object') {
    if (typeof value.$binary === 'string' && hasVersionReference(Buffer.from(value.$binary, 'base64').toString('utf8')))
      return true;
    if (
      typeof value.$binary?.base64 === 'string' &&
      hasVersionReference(Buffer.from(value.$binary.base64, 'base64').toString('utf8'))
    )
      return true;
    if (typeof value.base64 === 'string' && hasVersionReference(Buffer.from(value.base64, 'base64').toString('utf8')))
      return true;
    return Object.values(value).some(hasVersionReference);
  }
  return false;
}
