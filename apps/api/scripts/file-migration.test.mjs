import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  GetObjectAclCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { sourceRecord, targetInventory, transferObject } from './migrate-files.mjs';
import {
  canonical,
  sha256,
  partSizeFor,
  parts,
  hashBody,
  assertCheckpoint,
  hasVersionReference,
  objectMetadata,
  sameModifiedSecond,
  sdkData,
  MiB,
  MAX_OBJECT_BYTES,
} from './file-migration.mjs';

async function collect(input, size, bytes) {
  const output = [];
  for await (const part of parts(Readable.from(input), size, bytes)) output.push(part);
  return output;
}

test('multipart chunk boundaries preserve all bytes including a short final part', async () => {
  const input = [Buffer.from('a'), Buffer.from('bcdefgh'), Buffer.from('ij'), Buffer.from('klm')];
  const output = await collect(input, 5, 13);
  assert.deepEqual(
    output.map((part) => part.length),
    [5, 5, 3],
  );
  assert.equal(Buffer.concat(output).toString(), 'abcdefghijklm');
  assert.deepEqual(await hashBody(Readable.from(output)), { bytes: 13, sha256: sha256(Buffer.concat(input)) });
});

test('empty and exact-boundary streams do not emit uninitialized trailing bytes', async () => {
  assert.deepEqual(await collect([], 5, 0), []);
  assert.deepEqual(
    (await collect([Buffer.from('abcdefghij')], 5, 10)).map((part) => part.toString()),
    ['abcde', 'fghij'],
  );
  await assert.rejects(collect([Buffer.from('abcd')], 5, 5), /before snapshot length/);
  await assert.rejects(collect([Buffer.from('abcdef')], 5, 5), /exceeds snapshot length/);
  await assert.rejects(collect([Buffer.from('a')], 5, 0), /exceeds snapshot length/);
});

test('multipart sizes cover objects above 5GiB without exceeding 10000 parts', () => {
  for (const size of [0, 8 * MiB, 5 * 1024 ** 3 + 1, MAX_OBJECT_BYTES]) {
    const partSize = partSizeFor(size);
    assert.ok(partSize >= 5 * MiB);
    assert.ok(Math.ceil(size / partSize) <= 10000);
    assert.ok(partSize < 5 * 1024 ** 3);
  }
  for (const invalid of [-1, 1.5, NaN, MAX_OBJECT_BYTES + 1, Number.MAX_SAFE_INTEGER])
    assert.throws(() => partSizeFor(invalid));
});

test('resume binds the exact key, snapshot and metadata rather than ETag alone', () => {
  const object = {
    key: '../한글/%2F',
    head: { ETag: 'multipart-etag-2', ContentLength: 12, Metadata: { owner: 'one' } },
  };
  const checkpoint = { key: object.key, snapshot: 'snapshot-one', sourceFingerprint: sha256(canonical(object)) };
  assert.doesNotThrow(() => assertCheckpoint(checkpoint, object, 'snapshot-one'));
  assert.throws(() => assertCheckpoint(checkpoint, object, 'snapshot-two'));
  assert.throws(() => assertCheckpoint(checkpoint, { ...object, key: '../한글//' }, 'snapshot-one'));
  assert.throws(() =>
    assertCheckpoint(checkpoint, { ...object, head: { ...object.head, Metadata: { owner: 'two' } } }, 'snapshot-one'),
  );
});

test('canonical audit retains meaningful metadata and ignores SDK transport request IDs', () => {
  assert.equal(
    canonical(
      sdkData({
        Metadata: { z: '1', a: '2', $metadata: 'user-value' },
        date: new Date('2020-01-01T00:00:00Z'),
        $metadata: { requestId: 'a' },
      }),
    ),
    canonical({ date: '2020-01-01T00:00:00.000Z', Metadata: { a: '2', z: '1', $metadata: 'user-value' } }),
  );
  const metadata = {
    ContentType: 'image/png',
    ContentLanguage: 'ko',
    ContentEncoding: 'gzip',
    CacheControl: 'private',
    ContentDisposition: 'inline',
    Metadata: { original: 'value' },
  };
  assert.deepEqual(objectMetadata({ ...metadata, ETag: 'not-a-content-hash', StorageClass: 'GLACIER' }), metadata);
  assert.throws(() => objectMetadata({ ExpiresString: 'not an HTTP date' }), /Expires header is not representable/);
});

test('version URL dependencies are found in nested, escaped, MySQL, Mongo and Redis values', () => {
  const url = 'https://bucket.s3.amazonaws.com/a?versionId=old-version';
  for (const value of [
    url,
    encodeURIComponent(url),
    encodeURIComponent(encodeURIComponent(url)),
    { data: [url] },
    { $binary: Buffer.from(url).toString('base64') },
    { $binary: { base64: Buffer.from(url).toString('base64'), subType: '00' } },
    { base64: Buffer.from(url).toString('base64') },
  ])
    assert.equal(hasVersionReference(value), true);
  assert.equal(hasVersionReference({ base64: Buffer.from('unrelated').toString('base64'), url }), true);
  assert.equal(hasVersionReference({ url: 'https://bucket.s3.amazonaws.com/a?width=100' }), false);
  assert.equal(hasVersionReference('https://bucket.s3.amazonaws.com/100%not-encoded'), false);
});

test('source inventory accepts HTTP-date precision and refuses an unrepresentable Expires before copying', async () => {
  const item = { Key: 'photo', ETag: '"source"', Size: 3, LastModified: new Date('2026-01-02T03:04:05.789Z') };
  const expires = new Date('2035-10-21T07:28:00.000Z');
  const head = {
    ETag: item.ETag,
    ContentLength: item.Size,
    LastModified: new Date('2026-01-02T03:04:05.000Z'),
    Expires: expires,
    ExpiresString: expires.toUTCString(),
  };
  const commands = [];
  const client = {
    async send(command) {
      commands.push(command);
      if (command instanceof HeadObjectCommand) return head;
      if (command instanceof GetObjectTaggingCommand) return { TagSet: [] };
      if (command instanceof GetObjectAclCommand) return { Grants: [] };
      throw new Error('Unexpected source request');
    },
  };
  const record = await sourceRecord(client, 'source-bucket', item);
  assert.equal(record.head.ExpiresString, head.ExpiresString);
  assert.equal(commands.length, 3);
  assert.equal(commands[0].input.IfMatch, item.ETag);
  assert.equal(sameModifiedSecond(head.LastModified, new Date('2026-01-02T03:04:06.000Z')), false);
  assert.equal(sameModifiedSecond('not-a-date', item.LastModified), false);

  commands.length = 0;
  const invalid = { send: async (command) => (commands.push(command), { ...head, ExpiresString: 'invalid' }) };
  await assert.rejects(sourceRecord(invalid, 'source-bucket', item), /Expires header is not representable/);
  assert.equal(commands.length, 1);
  await assert.rejects(
    sourceRecord({ send: async () => ({ ...head, ETag: '"changed"' }) }, 'source-bucket', item),
    /Source changed/,
  );
});

test('copying uses a representable Expires date from persisted inventory and refuses invalid GET headers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'file-migration-'));
  try {
    const checkpointPath = join(directory, 'checkpoint.json');
    const expires = new Date('2035-10-21T07:28:00.000Z');
    const head = {
      ETag: '"source"',
      ContentLength: 3,
      LastModified: '2026-01-02T03:04:05.000Z',
      Expires: expires.toISOString(),
      ExpiresString: expires.toUTCString(),
    };
    const record = { key: 'photo', head };
    const checkpoint = { key: 'photo', snapshot: 'snapshot', verified: false };
    let rawExpires = head.ExpiresString;
    let sourceRequests = 0;
    const source = {
      async send(command) {
        sourceRequests += 1;
        assert.ok(command instanceof GetObjectCommand);
        return {
          ...head,
          LastModified: new Date(head.LastModified),
          Expires: expires,
          ExpiresString: rawExpires,
          Body: Readable.from([Buffer.from('abc')]),
        };
      },
    };
    const uploads = [];
    let targetExists = false;
    const target = {
      async send(command) {
        if (command instanceof HeadObjectCommand) {
          if (targetExists) return { ETag: '"target"' };
          throw { $metadata: { httpStatusCode: 404 } };
        }
        if (command instanceof PutObjectCommand) {
          uploads.push(command.input);
          return { ETag: '"target"' };
        }
        if (command instanceof GetObjectCommand)
          return {
            Expires: expires,
            ExpiresString: expires.toUTCString(),
            ContentLength: 3,
            ETag: '"target"',
            LastModified: new Date('2026-01-02T03:04:07.000Z'),
            Body: Readable.from([Buffer.from('abc')]),
          };
        throw new Error('Unexpected target request');
      },
    };
    const signal = new AbortController().signal;
    await transferObject(source, target, 'source-bucket', 'target-bucket', record, checkpoint, checkpointPath, signal);
    assert.equal(uploads.length, 1);
    assert.deepEqual(uploads[0].Expires, expires);
    assert.equal(checkpoint.verified, true);

    rawExpires = 'not an HTTP date';
    uploads.length = 0;
    await assert.rejects(
      transferObject(
        source,
        target,
        'source-bucket',
        'target-bucket',
        record,
        { key: 'photo', snapshot: 'snapshot', verified: false },
        checkpointPath,
        signal,
      ),
      /Expires header is not representable/,
    );
    assert.equal(uploads.length, 0);

    targetExists = true;
    const resumed = JSON.parse(await readFile(checkpointPath, 'utf8'));
    await transferObject(source, target, 'source-bucket', 'target-bucket', record, resumed, checkpointPath, signal);
    assert.equal(resumed.verified, true);
    assert.equal(sourceRequests, 2);
    assert.equal(uploads.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('destination reconciliation accepts persisted GET seconds against R2 list milliseconds', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'file-inventory-'));
  try {
    await mkdir(join(directory, 'objects'));
    const item = { Key: 'photo', ETag: '"target"', Size: 3, LastModified: new Date('2026-01-02T03:04:07.901Z') };
    const checkpoint = {
      key: item.Key,
      snapshot: 'snapshot',
      sourceSha256: sha256('abc'),
      verified: true,
      destination: { bytes: 3, etag: item.ETag, lastModified: '2026-01-02T03:04:07.000Z' },
    };
    await writeFile(join(directory, 'objects', `${sha256(item.Key)}.json`), JSON.stringify(checkpoint));
    let listed = item;
    const target = {
      async send(command) {
        assert.ok(command instanceof ListObjectsV2Command);
        return { Contents: [listed], IsTruncated: false };
      },
    };
    assert.deepEqual(await targetInventory(target, 'target-bucket', directory, 'snapshot', true), {
      count: 1,
      bytes: '3',
    });
    listed = { ...item, ETag: '"changed"' };
    await assert.rejects(
      targetInventory(target, 'target-bucket', directory, 'snapshot', true),
      /changed after verification/,
    );
    listed = { ...item, LastModified: new Date('2026-01-02T03:04:08.000Z') };
    await assert.rejects(
      targetInventory(target, 'target-bucket', directory, 'snapshot', true),
      /changed after verification/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
