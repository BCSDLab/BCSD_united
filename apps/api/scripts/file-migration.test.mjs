import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  canonical,
  sha256,
  partSizeFor,
  parts,
  hashBody,
  assertCheckpoint,
  hasVersionReference,
  objectMetadata,
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
