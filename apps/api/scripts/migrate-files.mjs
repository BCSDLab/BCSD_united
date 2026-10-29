import {
  S3Client,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  GetObjectAclCommand,
  GetBucketVersioningCommand,
  ListObjectVersionsCommand,
  ListMultipartUploadsCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, unlink, realpath } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  canonical,
  sha256,
  partSizeFor,
  parts,
  hashBody,
  jsonLines,
  durableJson,
  optionalJson,
  objectMetadata,
  assertCheckpoint,
  hasVersionReference,
  sdkData,
} from './file-migration.mjs';

let stage = 'configuration';
const required = (env, name) => {
  if (!env[name]?.trim()) throw new Error(`Missing ${name}`);
  return env[name];
};

export function configuration(env) {
  const names = [
    'S3_SOURCE_BUCKET',
    'S3_SOURCE_REGION',
    'S3_SOURCE_ACCESS_KEY_ID',
    'S3_SOURCE_SECRET_ACCESS_KEY',
    'R2_ACCOUNT_ID',
    'R2_BUCKET',
    'R2_ACCESS_KEY_ID',
    'R2_SECRET_ACCESS_KEY',
    'CLOUDFLARE_API_TOKEN',
    'FILE_MIGRATION_RUN',
    'FILE_MIGRATION_DB_SNAPSHOT',
  ];
  for (const name of names) required(env, name);
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(env.FILE_MIGRATION_RUN)) throw new Error('Invalid FILE_MIGRATION_RUN');
  if (!/^[a-f0-9]{32}$/i.test(env.R2_ACCOUNT_ID)) throw new Error('Invalid R2_ACCOUNT_ID');
  if (env.FILE_MIGRATION_EXCLUSIVE_PRIVATE_TARGET !== 'true')
    throw new Error(
      'Require FILE_MIGRATION_EXCLUSIVE_PRIVATE_TARGET=true: no other writers, Workers, public bindings or lifecycle deletion',
    );
  if (env.FILE_MIGRATION_CURRENT_KEYS_ONLY !== 'true')
    throw new Error('Require FILE_MIGRATION_CURRENT_KEYS_ONLY=true: historical version bodies remain in S3');
  if (env.FILE_MIGRATION_DB_URLS_REVIEWED !== 'true')
    throw new Error(
      'Require FILE_MIGRATION_DB_URLS_REVIEWED=true: audit opaque/encoded application references for historical version dependencies',
    );
  const jurisdiction = env.R2_JURISDICTION || 'default';
  if (!['default', 'eu', 'us'].includes(jurisdiction)) throw new Error('Unsupported R2_JURISDICTION');
  const endpoint = `https://${env.R2_ACCOUNT_ID}${jurisdiction === 'default' ? '' : `.${jurisdiction}`}.r2.cloudflarestorage.com`;
  return {
    source: { bucket: env.S3_SOURCE_BUCKET, region: env.S3_SOURCE_REGION },
    target: { bucket: env.R2_BUCKET, endpoint, account: env.R2_ACCOUNT_ID, jurisdiction },
    run: env.FILE_MIGRATION_RUN,
    dbSnapshot: resolve(env.FILE_MIGRATION_DB_SNAPSHOT),
  };
}

async function assertPrivate(config, token) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${config.account}/r2/buckets/${encodeURIComponent(config.bucket)}/domains`;
  const get = async (suffix) => {
    const response = await fetch(`${base}/${suffix}`, {
      headers: { Authorization: `Bearer ${token}`, 'cf-r2-jurisdiction': config.jurisdiction },
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error('Cannot verify R2 privacy');
    const result = await response.json();
    if (result.success !== true) throw new Error('Cannot verify R2 privacy');
    return result.result;
  };
  const managed = await get('managed');
  const custom = await get('custom');
  if (
    managed?.enabled !== false ||
    !Array.isArray(custom?.domains) ||
    custom.domains.some((domain) => domain.enabled !== false)
  )
    throw new Error('R2 destination must have all public domains disabled');
}

async function snapshotEvidence(directory) {
  const raw = await readFile(resolve(directory, 'manifest.json'));
  const manifest = JSON.parse(raw);
  if (manifest.complete !== true || !Array.isArray(manifest.files))
    throw new Error('Complete database export manifest required');
  for (const source of ['mysql:', 'mongo:', 'redis']) {
    if (!manifest.files.some((file) => file.source?.startsWith(source)))
      throw new Error('Database export must cover MySQL, Mongo and Redis');
  }
  for (const file of manifest.files) {
    if (basename(file.name) !== file.name) throw new Error('Invalid database manifest path');
    const path = resolve(directory, file.name);
    const evidence = await hashBody(createReadStream(path));
    if (evidence.sha256 !== file.sha256 || evidence.bytes !== file.bytes)
      throw new Error('Database export integrity mismatch');
    if (file.name.endsWith('.jsonl')) {
      for await (const row of jsonLines(path))
        if (hasVersionReference(row))
          throw new Error(
            'Version-specific database URL requires historical-body migration; current-key migration refused',
          );
    }
  }
  return sha256(raw);
}

async function* objects(client, Bucket) {
  let ContinuationToken;
  do {
    const page = await client.send(new ListObjectsV2Command({ Bucket, ContinuationToken, MaxKeys: 1000 }));
    for (const item of page.Contents ?? []) {
      if (typeof item.Key !== 'string' || !item.ETag || !Number.isSafeInteger(item.Size))
        throw new Error('Incomplete object inventory');
      yield item;
    }
    const next = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && (!next || next === ContinuationToken)) throw new Error('Invalid object pagination');
    ContinuationToken = next;
  } while (ContinuationToken);
}

async function sourceRecord(client, Bucket, item) {
  const head = await client.send(new HeadObjectCommand({ Bucket, Key: item.Key, IfMatch: item.ETag }));
  if (
    head.ETag !== item.ETag ||
    head.ContentLength !== item.Size ||
    canonical(head.LastModified) !== canonical(item.LastModified) ||
    head.MissingMeta
  )
    throw new Error('Source changed or metadata is not losslessly readable');
  partSizeFor(head.ContentLength);
  const reference = { Bucket, Key: item.Key, ...(head.VersionId === undefined ? {} : { VersionId: head.VersionId }) };
  const tags = await client.send(new GetObjectTaggingCommand(reference));
  const acl = await client.send(new GetObjectAclCommand(reference));
  return { key: item.Key, head: sdkData(head), tags: sdkData(tags), acl: sdkData(acl) };
}

async function capture(client, Bucket, directory, name) {
  const currentPath = resolve(directory, `${name}.current.jsonl`);
  const versionsPath = resolve(directory, `${name}.versions.jsonl`);
  const current = await open(currentPath, 'w', 0o600);
  let count = 0;
  let bytes = 0n;
  try {
    for await (const item of objects(client, Bucket)) {
      const record = await sourceRecord(client, Bucket, item);
      await current.write(canonical(record) + '\n');
      count += 1;
      bytes += BigInt(item.Size);
    }
    await current.sync();
  } finally {
    await current.close();
  }
  const versions = await open(versionsPath, 'w', 0o600);
  let versionCount = 0;
  try {
    const versioning = await client.send(new GetBucketVersioningCommand({ Bucket }));
    await versions.write(canonical({ versioning: sdkData(versioning) }) + '\n');
    let KeyMarker;
    let VersionIdMarker;
    for (;;) {
      const page = await client.send(
        new ListObjectVersionsCommand({ Bucket, KeyMarker, VersionIdMarker, MaxKeys: 1000 }),
      );
      for (const version of page.Versions ?? []) {
        await versions.write(canonical({ version }) + '\n');
        versionCount += 1;
      }
      for (const marker of page.DeleteMarkers ?? []) await versions.write(canonical({ deleteMarker: marker }) + '\n');
      if (!page.IsTruncated) break;
      if (!page.NextKeyMarker || (page.NextKeyMarker === KeyMarker && page.NextVersionIdMarker === VersionIdMarker))
        throw new Error('Invalid version pagination');
      KeyMarker = page.NextKeyMarker;
      VersionIdMarker = page.NextVersionIdMarker;
    }
    await versions.sync();
  } finally {
    await versions.close();
  }
  return {
    current: await hashBody(createReadStream(currentPath)),
    versions: await hashBody(createReadStream(versionsPath)),
    count,
    bytes: bytes.toString(),
    versionCount,
  };
}

function sameSnapshot(actual, expected) {
  if (canonical(actual) !== canonical(expected))
    throw new Error('Source inventory changed; do not resume against a different snapshot');
}

async function headOrMissing(client, Bucket, Key) {
  try {
    return await client.send(new HeadObjectCommand({ Bucket, Key }));
  } catch (error) {
    if (error.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}

async function abort(client, Bucket, Key, UploadId) {
  try {
    await client.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }));
  } catch (error) {
    if (error.name !== 'NoSuchUpload') throw error;
  }
}

async function recoverUploads(client, Bucket, directory, snapshot) {
  let KeyMarker;
  let UploadIdMarker;
  for (;;) {
    const page = await client.send(
      new ListMultipartUploadsCommand({ Bucket, KeyMarker, UploadIdMarker, MaxUploads: 1000 }),
    );
    for (const upload of page.Uploads ?? []) {
      const path = resolve(directory, 'objects', `${sha256(upload.Key)}.json`);
      const checkpoint = await optionalJson(path);
      if (
        !checkpoint ||
        checkpoint.key !== upload.Key ||
        checkpoint.snapshot !== snapshot ||
        checkpoint.uploadId !== upload.UploadId
      )
        throw new Error('Unknown unfinished target upload; manual ownership reconciliation required');
      await abort(client, Bucket, upload.Key, upload.UploadId);
      delete checkpoint.uploadId;
      await durableJson(path, checkpoint);
    }
    if (!page.IsTruncated) break;
    if (!page.NextKeyMarker || (page.NextKeyMarker === KeyMarker && page.NextUploadIdMarker === UploadIdMarker))
      throw new Error('Invalid multipart pagination');
    KeyMarker = page.NextKeyMarker;
    UploadIdMarker = page.NextUploadIdMarker;
  }
}

async function verifyTarget(client, Bucket, record, checkpoint) {
  const response = await client.send(new GetObjectCommand({ Bucket, Key: record.key }));
  try {
    if (
      canonical(objectMetadata(response)) !== canonical(objectMetadata(record.head)) ||
      response.ContentLength !== record.head.ContentLength
    )
      throw new Error('Destination object metadata mismatch');
    const evidence = await hashBody(response.Body);
    if (evidence.bytes !== record.head.ContentLength || evidence.sha256 !== checkpoint.sourceSha256)
      throw new Error('Destination byte hash mismatch');
    return { ...evidence, etag: response.ETag, lastModified: response.LastModified };
  } finally {
    response.Body?.destroy();
  }
}

export async function transferObject(
  source,
  target,
  sourceBucket,
  targetBucket,
  record,
  checkpoint,
  checkpointPath,
  signal,
) {
  const Key = record.key;
  const existing = await headOrMissing(target, targetBucket, Key);
  if (existing) {
    if (!checkpoint.sourceSha256) throw new Error('Unowned target object: no durable source byte hash');
    const evidence = await verifyTarget(target, targetBucket, record, checkpoint);
    checkpoint.destination = evidence;
    checkpoint.verified = true;
    delete checkpoint.uploadId;
    await durableJson(checkpointPath, checkpoint);
    return;
  }
  if (checkpoint.verified) throw new Error('Previously verified target object disappeared');
  const response = await source.send(new GetObjectCommand({ Bucket: sourceBucket, Key, IfMatch: record.head.ETag }), {
    abortSignal: signal,
  });
  let uploadId;
  try {
    for (const field of ['ETag', 'ContentLength', 'VersionId', 'LastModified']) {
      if (canonical(response[field]) !== canonical(record.head[field]))
        throw new Error('Source object changed since inventory');
    }
    if (canonical(objectMetadata(response)) !== canonical(objectMetadata(record.head)))
      throw new Error('Source metadata changed since inventory');
    const size = record.head.ContentLength;
    const partSize = partSizeFor(size);
    const metadata = objectMetadata(response);
    const hash = createHash('sha256');
    const completed = [];
    if (size > partSize) {
      const created = await target.send(new CreateMultipartUploadCommand({ Bucket: targetBucket, Key, ...metadata }), {
        abortSignal: signal,
      });
      if (!created.UploadId) throw new Error('Missing multipart upload ID');
      uploadId = created.UploadId;
      checkpoint.uploadId = uploadId;
      await durableJson(checkpointPath, checkpoint);
      for await (const body of parts(response.Body, partSize, size)) {
        hash.update(body);
        const PartNumber = completed.length + 1;
        const uploaded = await target.send(
          new UploadPartCommand({
            Bucket: targetBucket,
            Key,
            UploadId: uploadId,
            PartNumber,
            Body: body,
            ContentLength: body.length,
          }),
          { abortSignal: signal },
        );
        if (!uploaded.ETag) throw new Error('Missing uploaded part ETag');
        completed.push({ PartNumber, ETag: uploaded.ETag });
      }
      checkpoint.sourceSha256 = hash.digest('hex');
      await durableJson(checkpointPath, checkpoint);
      if (await headOrMissing(target, targetBucket, Key))
        throw new Error('Target key appeared during upload; refusing overwrite');
      await target.send(
        new CompleteMultipartUploadCommand({
          Bucket: targetBucket,
          Key,
          UploadId: uploadId,
          MultipartUpload: { Parts: completed },
          IfNoneMatch: '*',
        }),
        { abortSignal: signal },
      );
      uploadId = undefined;
    } else {
      let body = Buffer.alloc(0);
      for await (const chunk of parts(response.Body, partSize, size)) {
        body = chunk;
        hash.update(chunk);
      }
      checkpoint.sourceSha256 = hash.digest('hex');
      await durableJson(checkpointPath, checkpoint);
      await target.send(
        new PutObjectCommand({
          Bucket: targetBucket,
          Key,
          Body: body,
          ContentLength: size,
          ...metadata,
          IfNoneMatch: '*',
        }),
        { abortSignal: signal },
      );
    }
    checkpoint.destination = await verifyTarget(target, targetBucket, record, checkpoint);
    checkpoint.verified = true;
    delete checkpoint.uploadId;
    await durableJson(checkpointPath, checkpoint);
  } finally {
    response.Body?.destroy();
    if (uploadId) {
      await abort(target, targetBucket, Key, uploadId);
      delete checkpoint.uploadId;
      await durableJson(checkpointPath, checkpoint);
    }
  }
}

async function targetInventory(client, Bucket, directory, snapshot, requireComplete) {
  let count = 0;
  let bytes = 0n;
  for await (const item of objects(client, Bucket)) {
    const checkpoint = await optionalJson(resolve(directory, 'objects', `${sha256(item.Key)}.json`));
    if (
      !checkpoint ||
      checkpoint.key !== item.Key ||
      checkpoint.snapshot !== snapshot ||
      !checkpoint.sourceSha256 ||
      (requireComplete && !checkpoint.verified)
    )
      throw new Error('Destination contains an unrelated or unverified object');
    if (
      checkpoint.destination &&
      (checkpoint.destination.bytes !== item.Size ||
        checkpoint.destination.etag !== item.ETag ||
        canonical(checkpoint.destination.lastModified) !== canonical(item.LastModified))
    )
      throw new Error('Destination object changed after verification');
    count += 1;
    bytes += BigInt(item.Size);
  }
  return { count, bytes: bytes.toString() };
}

export async function main(env = process.env) {
  process.umask(0o077);
  if (process.argv.length > 2)
    throw new Error('No command arguments accepted; configuration and credentials use runtime environment only');
  let config;
  try {
    config = configuration(env);
  } catch (error) {
    error.configurationMessage = error.message;
    throw error;
  }
  const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const dataRoot = resolve(repository, 'migration-data');
  await mkdir(dataRoot, { recursive: true, mode: 0o700 });
  const actualRoot = await realpath(dataRoot);
  const inside = relative(repository, actualRoot);
  if (inside.startsWith('..') || isAbsolute(inside))
    throw new Error('migration-data must remain inside the ignored repository directory');
  const directory = resolve(dataRoot, config.run);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await realpath(directory)) !== resolve(actualRoot, config.run))
    throw new Error('Migration run directory cannot be a symlink');
  const lockPath = resolve(directory, 'run.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const source = new S3Client({
    region: config.source.region,
    credentials: {
      accessKeyId: env.S3_SOURCE_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SOURCE_SECRET_ACCESS_KEY,
      ...(env.S3_SOURCE_SESSION_TOKEN ? { sessionToken: env.S3_SOURCE_SESSION_TOKEN } : {}),
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const target = new S3Client({
    region: 'auto',
    endpoint: config.target.endpoint,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  const manifestPath = resolve(directory, 'manifest.json');
  let manifest;
  try {
    await lock.writeFile(canonical({ pid: process.pid, startedAt: new Date().toISOString() }));
    await lock.sync();
    stage = 'private target and database-reference preflight';
    await assertPrivate(config.target, env.CLOUDFLARE_API_TOKEN);
    const dbManifestSha256 = await snapshotEvidence(config.dbSnapshot);
    const identity = { source: config.source, target: config.target, dbManifestSha256, scope: 'current-keys-only' };
    const existingManifest = await optionalJson(manifestPath);
    if (
      existingManifest &&
      (existingManifest.format !== 1 || canonical(existingManifest.identity) !== canonical(identity))
    )
      throw new Error('Migration configuration differs from checkpoint');
    manifest = existingManifest;
    if (manifest) {
      manifest.complete = false;
      await durableJson(manifestPath, manifest);
      stage = 'recovering checkpoint-owned multipart uploads';
      await recoverUploads(target, config.target.bucket, directory, manifest.snapshot);
    }
    stage = 'full source inventory';
    const inventory = await capture(source, config.source.bucket, directory, 'observed');
    if (manifest) sameSnapshot(inventory, manifest.inventory);
    else {
      for await (const ignored of objects(target, config.target.bucket)) {
        void ignored;
        throw new Error('New migration requires an empty destination');
      }
      const uploads = await target.send(
        new ListMultipartUploadsCommand({ Bucket: config.target.bucket, MaxUploads: 1 }),
      );
      if (uploads.Uploads?.length || uploads.IsTruncated)
        throw new Error('New migration requires no unfinished destination uploads');
      const stable = await capture(source, config.source.bucket, directory, 'baseline');
      sameSnapshot(stable, inventory);
      manifest = {
        format: 1,
        complete: false,
        identity,
        inventory,
        snapshot: sha256(canonical({ identity, inventory })),
        startedAt: new Date().toISOString(),
        historicalBodiesCopied: false,
      };
      await durableJson(manifestPath, manifest);
    }
    await mkdir(resolve(directory, 'objects'), { recursive: true, mode: 0o700 });
    await targetInventory(target, config.target.bucket, directory, manifest.snapshot, false);
    stage = 'streaming and verifying object bytes';
    const evidencePath = resolve(directory, 'verification.jsonl');
    const evidence = await open(evidencePath, 'w', 0o600);
    try {
      for await (const record of jsonLines(resolve(directory, 'observed.current.jsonl'))) {
        controller.signal.throwIfAborted();
        const path = resolve(directory, 'objects', `${sha256(record.key)}.json`);
        let checkpoint = await optionalJson(path);
        if (checkpoint) assertCheckpoint(checkpoint, record, manifest.snapshot);
        else {
          checkpoint = {
            key: record.key,
            snapshot: manifest.snapshot,
            sourceFingerprint: sha256(canonical(record)),
            verified: false,
          };
          await durableJson(path, checkpoint);
        }
        await transferObject(
          source,
          target,
          config.source.bucket,
          config.target.bucket,
          record,
          checkpoint,
          path,
          controller.signal,
        );
        await evidence.write(
          canonical({ key: record.key, sourceSha256: checkpoint.sourceSha256, destination: checkpoint.destination }) +
            '\n',
        );
      }
      await evidence.sync();
    } finally {
      await evidence.close();
    }
    stage = 'final full source and destination reconciliation';
    const finalInventory = await capture(source, config.source.bucket, directory, 'final');
    sameSnapshot(finalInventory, manifest.inventory);
    const totals = await targetInventory(target, config.target.bucket, directory, manifest.snapshot, true);
    if (totals.count !== inventory.count || totals.bytes !== inventory.bytes)
      throw new Error('Final destination object count or byte total mismatch');
    await assertPrivate(config.target, env.CLOUDFLARE_API_TOKEN);
    if ((await snapshotEvidence(config.dbSnapshot)) !== dbManifestSha256)
      throw new Error('Database reference snapshot changed during migration');
    controller.signal.throwIfAborted();
    manifest.verification = await hashBody(createReadStream(evidencePath));
    manifest.totals = totals;
    manifest.complete = true;
    manifest.completedAt = new Date().toISOString();
    await durableJson(manifestPath, manifest);
    process.stdout.write(
      `Verified ${totals.count} current objects (${totals.bytes} bytes). Private evidence: migration-data/${config.run}/manifest.json\n`,
    );
  } catch (error) {
    if (manifest) {
      manifest.complete = false;
      manifest.failedStage = stage;
      await durableJson(manifestPath, manifest);
    }
    throw error;
  } finally {
    source.destroy();
    target.destroy();
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    await lock.close();
    await unlink(lockPath);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const name = /^[A-Za-z0-9_]+$/.test(error.name) ? error.name : 'Error';
    if (error.configurationMessage) process.stderr.write(`${error.configurationMessage}\n`);
    process.stderr.write(
      `File migration failed during ${stage} (${name}). No source writes performed. Keep the private checkpoint; reconcile configuration/permissions/source stability before resuming.\n`,
    );
    process.exitCode = 1;
  });
}
