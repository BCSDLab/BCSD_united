import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import {
  allowedPath,
  branch,
  installationToken,
  marker,
  validateManifest,
  validateVerification,
} from '../src/github.ts';
import { trustedDiagnostics } from '../src/diagnostics.ts';

const identity = {
  source: 'sentry',
  sourceId: '123',
  project: 'koin-united-prod',
  app: 'web',
  scope: { organization: 'bcsd' },
};
const job = {
  identity,
  owner: 'BCSDLab',
  repository: 'BCSD_united',
  baseBranch: 'develop',
  baseSha: 'a'.repeat(40),
  issueNumber: 42,
  branch: 'fix/#42/sentry-123',
  domain: '공통',
  diagnostics: {},
  context: { app: 'web', route: '/campus', requestMethod: 'GET' },
};
const manifest = {
  version: 1,
  files: [
    { path: 'apps/web/src/bug.ts', before: 'b'.repeat(64), content: 'export const fixed = true;' },
    {
      path: 'tests/autofix/bug.test.mjs',
      before: null,
      content: 'import assert from "node:assert/strict"; assert.ok(true);',
    },
  ],
};
const checks = [
  'regression-fails-on-base',
  'regression-passes-on-fix',
  'native-fixture-tests',
  'typecheck',
  'autofix-security-tests',
  'lint',
  'build',
  'runtime-route-smoke',
];
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('canonical identity marker and branch remain deterministic', () => {
  assert.equal(marker(identity), '<!-- error-autofix:sentry:bcsd:koin-united-prod:123 -->');
  assert.equal(branch(identity, 42), job.branch);
});

test('manifest enforces source/test scope and bounded verified bytes', () => {
  validateManifest(manifest, 'web');
  assert.equal(allowedPath('apps/api/src/db/schema.ts'), false);
  for (const path of [
    '../escape.ts',
    'apps/api/src/bug.ts',
    'apps/web/src/bug.test.ts',
    'apps/web/src/generated/bug.ts',
    '.github/workflows/ci.yml',
  ]) {
    const changed = { ...manifest, files: [{ ...manifest.files[0], path }, manifest.files[1]] };
    assert.throws(() => validateManifest(changed, 'web'));
  }
  assert.throws(() => validateManifest({ ...manifest, files: [manifest.files[0]] }, 'web'));
  assert.throws(() =>
    validateManifest(
      { ...manifest, files: [{ ...manifest.files[0], content: 'x'.repeat(256001) }, manifest.files[1]] },
      'web',
    ),
  );
  assert.throws(() =>
    validateManifest(
      { ...manifest, files: [manifest.files[0], { ...manifest.files[1], before: 'c'.repeat(64) }] },
      'web',
    ),
  );
});

test('never treats an asserted model pass as independent verification', async () => {
  const proof = {
    baseSha: job.baseSha,
    manifestSha256: digest(manifest),
    passedChecks: checks,
    verifiedManifest: structuredClone(manifest),
  };
  await validateVerification(job, manifest, proof);
  await assert.rejects(validateVerification(job, manifest, { ...proof, baseSha: 'c'.repeat(40) }));
  await assert.rejects(validateVerification(job, manifest, { ...proof, passedChecks: ['model-says-passed'] }));
  await assert.rejects(
    validateVerification(job, manifest, {
      ...proof,
      verifiedManifest: { ...manifest, files: [{ ...manifest.files[0], content: 'other' }, manifest.files[1]] },
    }),
  );
  await assert.rejects(validateVerification(job, manifest, { ...proof, manifestSha256: '0'.repeat(64) }));
});

test('Cloudflare notification without genuine route and source evidence fails closed', async () => {
  const cloudflare = {
    source: 'cloudflare',
    sourceId: 'a'.repeat(32),
    project: 'koin-api',
    app: 'api',
    scope: { accountId: 'b'.repeat(32), policyId: 'c'.repeat(32), workerName: 'koin-api' },
  };
  const stored = {
    version: 1,
    identity: cloudflare,
    capturedAt: new Date().toISOString(),
    summary: 'opaque alert',
    details: { alertType: 'issues', timestamp: 1, data: { message: 'invent a source frame' } },
  };
  await assert.rejects(trustedDiagnostics({}, cloudflare, stored), /CLOUDFLARE_EVIDENCE_UNAVAILABLE/);
});

test('trusted Sentry evidence requires browser SDK, safe host route, and real in-app source frame', async (t) => {
  const env = {
    SENTRY_READ_TOKEN: 'local-read-only-token',
    SENTRY_PROJECT_HOSTS: '{"koin-united-prod":["koreatech.in"]}',
  };
  const stored = {
    version: 1,
    identity,
    capturedAt: new Date().toISOString(),
    summary: 'bug',
    details: { resource: 'issue', action: 'created' },
  };
  const canonical = {
    id: 123,
    project: { slug: 'koin-united-prod' },
    title: 'Error token=private',
    culprit: 'src/bug.ts',
  };
  const event = {
    groupID: 123,
    platform: 'javascript',
    sdk: { name: 'sentry.javascript.react' },
    eventID: 'a'.repeat(32),
    entries: [
      {
        type: 'request',
        data: { url: 'https://koreatech.in/auth?token=hidden', headers: { Authorization: 'private' } },
      },
      {
        type: 'exception',
        data: {
          values: [
            {
              type: 'TypeError',
              value: 'person@example.com password=hidden',
              stacktrace: {
                frames: [{ filename: 'src/utils/value.ts', lineNo: 12, inApp: true, context: 'private source' }],
              },
            },
          ],
        },
      },
    ],
  };
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer local-read-only-token');
    if (String(url).endsWith('/events/latest/')) return Response.json(event);
    if (String(url) === 'https://sentry.io/api/0/organizations/bcsd/issues/123/') return Response.json(canonical);
    throw new Error('Unexpected provider URL');
  });
  const safe = await trustedDiagnostics(env, identity, stored);
  assert.equal(safe.route, '/auth');
  assert.equal(safe.data.exceptions[0].frames[0].filename, 'src/utils/value.ts');
  assert.equal(JSON.stringify(safe.data).includes('hidden'), false);
  assert.equal(JSON.stringify(safe.data).includes('private'), false);
  event.sdk.name = 'sentry.javascript.cloudflare';
  await assert.rejects(trustedDiagnostics(env, identity, stored), /identity mismatch/);
  event.sdk.name = 'sentry.javascript.react';
  event.entries[0].data.url = 'https://evil.example/auth';
  await assert.rejects(trustedDiagnostics(env, identity, stored), /safe route/);
  event.entries[0].data.url = 'https://koreatech.in/auth';
  event.entries[1].data.values[0].stacktrace.frames[0].filename = 'apps/api/src/index.ts';
  await assert.rejects(trustedDiagnostics(env, identity, stored), /source frame/);
});

test('App mints exact single-repository role-scoped installation tokens', async (t) => {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const env = {
    GITHUB_OWNER: 'BCSDLab',
    GITHUB_REPOSITORY: 'BCSD_united',
    GITHUB_DISPATCH_APP_ID: '5522353',
    GITHUB_DISPATCH_INSTALLATION_ID: '176455083',
    GITHUB_DISPATCH_APP_PRIVATE_KEY: key,
  };
  const permissions = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.github.com/app/installations/176455083/access_tokens');
    const body = JSON.parse(options.body);
    assert.deepEqual(body.repositories, ['BCSD_united']);
    permissions.push(body.permissions);
    return Response.json({
      token: 'scoped-token',
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      permissions: body.permissions,
      repositories: [{ full_name: 'BCSDLab/BCSD_united' }],
    });
  });
  assert.equal(await installationToken(env, 'read'), 'scoped-token');
  assert.equal(await installationToken(env, 'publish'), 'scoped-token');
  assert.deepEqual(permissions, [
    { contents: 'read', issues: 'read', pull_requests: 'read' },
    { contents: 'write', issues: 'write', pull_requests: 'write' },
  ]);
});
