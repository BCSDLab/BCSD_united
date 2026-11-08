import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import {
  allowedPath,
  branch,
  installationToken,
  marker,
  publish,
  validateManifest,
  validateVerification,
} from '../src/github.ts';
import { extractTailEvidence } from '../src/tail.ts';
const platform =
  'data:text/javascript,' +
  encodeURIComponent('export class DurableObject { constructor(ctx,env) { this.ctx=ctx; this.env=env; } }');
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'cloudflare:workers') return { url: platform, shortCircuit: true };
    if (
      specifier.startsWith('./') &&
      context.parentURL?.includes('/apps/error-automation/src/') &&
      !specifier.endsWith('.ts')
    )
      return nextResolve(`${specifier}.ts`, context);
    return nextResolve(specifier, context);
  },
});
const { trustedDiagnostics } = await import('../src/diagnostics.ts');
const { mappedTailFrames } = await import('../src/source-maps.ts');
const { prepare } = await import('../src/prepare.ts');

const identity = {
  source: 'sentry',
  sourceId: '123',
  project: 'koin-united-prod',
  app: 'web',
  scope: { organization: 'bcsd' },
};
const identityKey = 'sentry/bcsd/koin-united-prod/123';
const identityBranch = `fix/sentry-${createHash('sha256').update(identityKey).digest('hex')}`;
const job = {
  identity,
  owner: 'BCSDLab',
  repository: 'BCSD_united',
  baseBranch: 'main',
  targetBranch: 'develop',
  baseSha: 'a'.repeat(40),
  branch: identityBranch,
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

test('branch hashes the full canonical source scope, independent of GitHub issues', async () => {
  assert.equal(marker(identity), '<!-- error-autofix:sentry:bcsd:koin-united-prod:123 -->');
  assert.equal(await branch(identity), job.branch);
  assert.match(job.branch, /^fix\/sentry-[a-f0-9]{64}$/);
  assert.notEqual(await branch({ ...identity, scope: { organization: 'other' } }), job.branch);
  assert.notEqual(await branch({ ...identity, project: 'other-project' }), job.branch);
  assert.notEqual(await branch({ ...identity, sourceId: '124' }), job.branch);
  const cloudflare = {
    source: 'cloudflare',
    sourceId: 'a'.repeat(32),
    project: 'koin-api',
    app: 'api',
    scope: { accountId: 'b'.repeat(32), policyId: 'c'.repeat(32), workerName: 'koin-api' },
  };
  assert.equal(
    await branch(cloudflare),
    `fix/cloudflare-${createHash('sha256').update(`cloudflare/${cloudflare.scope.accountId}/${cloudflare.scope.policyId}/${cloudflare.project}/${cloudflare.sourceId}`).digest('hex')}`,
  );
  assert.notEqual(
    await branch({ ...cloudflare, scope: { ...cloudflare.scope, accountId: 'd'.repeat(32) } }),
    await branch(cloudflare),
  );
  assert.notEqual(
    await branch({ ...cloudflare, scope: { ...cloudflare.scope, policyId: 'e'.repeat(32) } }),
    await branch(cloudflare),
  );
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

test('Tail keeps bounded positions from the two approved production Workers', () => {
  const item = {
    scriptName: 'koin-api',
    scriptVersion: { id: '11111111-1111-1111-1111-111111111111' },
    eventTimestamp: Date.now(),
    truncated: false,
    outcome: 'exception',
    event: {
      request: {
        method: 'GET',
        url: 'https://koin-api.bcsdlab.workers.dev/campus?private=value',
        headers: { 'cf-ray': `${'f'.repeat(16)}-ICN`, authorization: 'never-retain' },
      },
    },
    exceptions: [{ stack: 'Error: confidential\\n    at handler (apps/api/src/handler.ts:12:3)', name: 'Error' }],
    logs: [
      { level: 'error', message: ['private-body'], errorInfo: [{ stack: 'at other (apps/web/src/other.ts:5:2)' }] },
    ],
  };
  const evidence = extractTailEvidence(item, 'koin-api', 'api');
  assert.deepEqual(evidence, {
    version: 1,
    workerName: 'koin-api',
    rayId: 'f'.repeat(16),
    scriptVersion: item.scriptVersion.id,
    eventTimestamp: item.eventTimestamp,
    route: '/campus',
    frames: [{ path: 'apps/api/src/handler.ts', line: 12, column: 3 }],
  });
  assert.equal(JSON.stringify(evidence).includes('private'), false);
  assert.equal(extractTailEvidence({ ...item, scriptName: 'foreign' }, 'koin-api', 'api'), null);
  assert.equal(
    extractTailEvidence(
      {
        ...item,
        event: {
          request: {
            ...item.event.request,
            url: 'https://preview-koin-api.bcsdlab.workers.dev/campus',
          },
        },
      },
      'koin-api',
      'api',
    ),
    null,
  );
  assert.deepEqual(
    extractTailEvidence({ ...item, exceptions: [{ stack: 'at handler (index.js:12:3)' }], logs: [] }, 'koin-api', 'api')
      ?.frames,
    [{ path: 'index.js', line: 12, column: 3 }],
  );
});

test('Tail resolves app-relative source-mapped frames without accepting foreign paths', () => {
  const item = {
    scriptName: 'koin-web',
    scriptVersion: { id: '11111111-1111-1111-1111-111111111111' },
    eventTimestamp: Date.now(),
    truncated: false,
    outcome: 'ok',
    event: { request: { method: 'GET', url: 'https://koreatech.in/', headers: { 'cf-ray': 'a'.repeat(16) } } },
    exceptions: [],
    logs: [
      {
        level: 'error',
        errorInfo: [
          {
            stack:
              'HttpError: Request failed\n    at send (src/utils/ts/apiClient.ts:201:17)\n    at page (src/routes/store.$id.index.tsx:25:4)',
          },
        ],
      },
    ],
  };
  assert.deepEqual(extractTailEvidence(item, 'koin-web', 'web')?.frames, [
    { path: 'apps/web/src/utils/ts/apiClient.ts', line: 201, column: 17 },
    { path: 'apps/web/src/routes/store.$id.index.tsx', line: 25, column: 4 },
  ]);
  for (const path of [
    'apps/api/src/handler.ts',
    '../src/handler.ts',
    'src/../private.ts',
    'https://attacker.example/src/handler.ts',
    'foreign/src/handler.ts',
  ]) {
    const logs = [{ level: 'error', errorInfo: [{ stack: `at handler (${path}:12:3)` }] }];
    assert.equal(extractTailEvidence({ ...item, logs }, 'koin-web', 'web'), null, path);
  }
});

function sourceMapFixture(
  t,
  { source = 'src/handler.ts', compiled, mapFile = 'assets/handler.js', duplicate = false } = {},
) {
  const code = 'function handler() {}\n//# sourceMappingURL=handler.js.map';
  const version = {
    id: '11111111-1111-1111-1111-111111111111',
    modules: [{ name: 'assets/handler.js', content_base64: Buffer.from(code).toString('base64') }],
  };
  t.mock.method(globalThis, 'fetch', async () => {
    const parts = new FormData();
    parts.set(
      'assets/handler.js',
      new Blob([compiled ?? code], { type: 'application/javascript+module' }),
      'assets/handler.js',
    );
    parts.set(
      'assets/handler.js.map',
      JSON.stringify({
        version: 3,
        file: mapFile,
        sources: [source],
        sourcesContent: ['private source content'],
        names: [],
        mappings: 'AAAA,GAEI',
      }),
    );
    if (duplicate) parts.append('assets/handler.js.map', '{}');
    return new Response(parts);
  });
  return {
    version,
    map: (frames = [{ path: 'assets/handler.js', line: 1, column: 4 }]) =>
      mappedTailFrames('koin-web', 'web', version.id, version, frames, 'scoped-read-token'),
  };
}

test('pinned bundle mapping preserves original line/column and exposes positions only', async (t) => {
  const fixture = sourceMapFixture(t);
  assert.deepEqual(await fixture.map(), [{ path: 'apps/web/src/handler.ts', line: 3, column: 5 }]);
  assert.deepEqual(
    await fixture.map([
      { path: 'assets/handler.js', line: 1, column: 1 },
      { path: 'assets/handler.js', line: 1, column: 4 },
    ]),
    [
      { path: 'apps/web/src/handler.ts', line: 1, column: 1 },
      { path: 'apps/web/src/handler.ts', line: 3, column: 5 },
    ],
  );
});

test('source mapping never uses another version, different code, duplicate maps or foreign app sources', async (t) => {
  for (const options of [
    { compiled: 'another deployment' },
    { mapFile: 'assets/other.js' },
    { duplicate: true },
    { source: 'apps/api/src/handler.ts' },
    { source: '../src/handler.ts' },
    { source: 'https://attacker.example/src/handler.ts' },
  ]) {
    await t.test(JSON.stringify(options), async (child) => {
      const fixture = sourceMapFixture(child, options);
      await assert.rejects(fixture.map());
    });
  }
  const fixture = sourceMapFixture(t);
  await assert.rejects(
    mappedTailFrames(
      'koin-web',
      'web',
      '22222222-2222-2222-2222-222222222222',
      fixture.version,
      [{ path: 'assets/handler.js', line: 1, column: 4 }],
      'scoped-read-token',
    ),
  );
});

test('Tail accepts the exact koreatech.in custom domain for koin-web only and rejects unrelated hosts', () => {
  const web = {
    scriptName: 'koin-web',
    scriptVersion: { id: '11111111-1111-1111-1111-111111111111' },
    eventTimestamp: Date.now(),
    truncated: false,
    outcome: 'exception',
    event: { request: { method: 'GET', url: 'https://koreatech.in/campus', headers: { 'cf-ray': 'a'.repeat(16) } } },
    exceptions: [{ stack: 'Error: x\\n    at handler (apps/web/src/handler.ts:12:3)', name: 'Error' }],
    logs: [],
  };
  const withUrl = (url) => ({ ...web, event: { request: { ...web.event.request, url } } });
  assert.equal(extractTailEvidence(web, 'koin-web', 'web')?.route, '/campus');
  assert.equal(
    extractTailEvidence(withUrl('https://koin-web.bcsdlab.workers.dev/campus'), 'koin-web', 'web')?.route,
    '/campus',
  );
  for (const url of [
    'https://www.koreatech.in/campus',
    'https://stage.koreatech.in/campus',
    'https://api.koreatech.in/campus',
    'https://koreatech.in:8443/campus',
    'https://user:pw@koreatech.in/campus',
    'http://koreatech.in/campus',
    'https://koreatech.in.attacker.example/campus',
  ])
    assert.equal(extractTailEvidence(withUrl(url), 'koin-web', 'web'), null, url);
  // The API Worker never serves the web custom domain.
  assert.equal(
    extractTailEvidence(
      { ...web, scriptName: 'koin-api', exceptions: [{ stack: 'at handler (apps/api/src/handler.ts:12:3)' }] },
      'koin-api',
      'api',
    ),
    null,
  );
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
  assert.equal(await installationToken(env, 'merge-evidence'), 'scoped-token');
  assert.equal(await installationToken(env, 'publish'), 'scoped-token');
  assert.deepEqual(permissions, [
    { contents: 'read', issues: 'read', pull_requests: 'read' },
    { contents: 'read', pull_requests: 'read', checks: 'read', statuses: 'read' },
    { contents: 'write', issues: 'write', pull_requests: 'write' },
  ]);
});

test('prepare verifies provider evidence with a read-only token, then deduplicates by branch without issues', async (t) => {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const env = {
    ENVIRONMENT: 'production',
    SENTRY_CLIENT_SECRET: 'webhook-secret',
    SENTRY_READ_TOKEN: 'provider-read-token',
    SENTRY_ORGANIZATION: 'bcsd',
    SENTRY_PROJECT_APPS: '{"koin-united-prod":"web","koin-united-preview":"web"}',
    SENTRY_PROJECT_HOSTS: '{"koin-united-prod":["koreatech.in"],"koin-united-preview":["stage.koreatech.in"]}',
    CLOUDFLARE_SOURCES: JSON.stringify([
      {
        accountId: 'abe06b869950de952decf9df29c6f1a3',
        policyId: '3bcbfa2a0c04416ca7e3da038f77ac37',
        workerName: 'koin-api',
        app: 'api',
      },
    ]),
    CLOUDFLARE_WEBHOOK_SECRET: 'local-cloudflare-secret-32-characters',
    CLOUDFLARE_DIAGNOSTICS_TOKEN: 'local-cloudflare-diagnostic-read-secret',
    DIAGNOSTICS_READ_TOKEN: 'd'.repeat(32),
    AUTOFIX_EXECUTOR_TOKEN: 'e'.repeat(32),
    AUTOFIX_EXECUTOR_ID: 'koin-rocky-umpc',
    ERROR_PROJECT_DOMAINS:
      '{"sentry:koin-united-prod":"공통","sentry:koin-united-preview":"공통","cloudflare:koin-api":"공통"}',
    ERROR_SOURCE_BRANCHES:
      '{"sentry:koin-united-prod":"main","sentry:koin-united-preview":"develop","cloudflare:koin-api":"main"}',
    GITHUB_OWNER: 'BCSDLab',
    GITHUB_REPOSITORY: 'BCSD_united',
    GITHUB_DISPATCH_APP_ID: '5522353',
    GITHUB_DISPATCH_INSTALLATION_ID: '176455083',
    GITHUB_DISPATCH_APP_PRIVATE_KEY: key,
    ERROR_ISSUES: {
      idFromName: (name) => name,
      get: (name) => ({
        fetch: async () => {
          const current = name === identityKey ? identity : name.startsWith('sentry/') ? preview : cloudflare;
          return Response.json({
            version: 1,
            identity: current,
            capturedAt: new Date().toISOString(),
            summary: 'error',
            details:
              current.source === 'cloudflare'
                ? {
                    alertType: 'issues',
                    timestamp: Date.now(),
                    data: {},
                    verifiedEvidence: {
                      route: '/shops/categories',
                      requestMethod: 'GET',
                      data: {
                        source: 'cloudflare',
                        issueId: current.sourceId,
                        workerName: current.project,
                        sourceFrames: [{ path: 'apps/api/src/bug.ts', line: 12, column: 1 }],
                      },
                    },
                  }
                : {},
          });
        },
      }),
    },
  };
  const preview = { ...identity, sourceId: '124', project: 'koin-united-preview' };
  const cloudflare = {
    source: 'cloudflare',
    sourceId: 'a'.repeat(32),
    project: 'koin-api',
    app: 'api',
    scope: {
      accountId: 'abe06b869950de952decf9df29c6f1a3',
      policyId: '3bcbfa2a0c04416ca7e3da038f77ac37',
      workerName: 'koin-api',
    },
  };
  const requests = [];
  let duplicate = false;
  const prUrl = 'https://github.com/BCSDLab/BCSD_united/pull/12';
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const href = String(url);
    requests.push([href, options.method ?? 'GET']);
    if (
      href === 'https://sentry.io/api/0/organizations/bcsd/issues/123/' ||
      href === 'https://sentry.io/api/0/organizations/bcsd/issues/124/'
    ) {
      const current = href.endsWith('/124/') ? preview : identity;
      return Response.json({ id: Number(current.sourceId), project: { slug: current.project }, title: 'error' });
    }
    if (href.endsWith('/events/latest/'))
      return Response.json({
        platform: 'javascript',
        sdk: { name: 'sentry.javascript.react' },
        groupID: href.includes('/124/') ? 124 : 123,
        entries: [
          {
            type: 'request',
            data: {
              url: href.includes('/124/')
                ? 'https://stage.koreatech.in/campus'
                : 'https://koreatech.in/campus?private=1',
            },
          },
          {
            type: 'exception',
            data: {
              values: [
                { type: 'TypeError', stacktrace: { frames: [{ filename: 'src/bug.ts', lineNo: 12, inApp: true }] } },
              ],
            },
          },
        ],
      });
    if (href.endsWith('/access_tokens')) {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.permissions, {
        contents: 'read',
        issues: 'read',
        pull_requests: 'read',
      });
      return Response.json({
        token: 'read-token',
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        repositories: [{ full_name: 'BCSDLab/BCSD_united' }],
        permissions: body.permissions,
      });
    }
    if (href === 'https://api.github.com/repos/BCSDLab/BCSD_united')
      return Response.json({ default_branch: 'develop', owner: { login: 'BCSDLab' } });
    if (href.endsWith('/commits/main'))
      return Response.json({ sha: job.baseSha, commit: { tree: { sha: 'b'.repeat(40) } } });
    if (href.endsWith('/commits/develop'))
      return Response.json({ sha: 'd'.repeat(40), commit: { tree: { sha: 'e'.repeat(40) } } });
    if (href.includes('/pulls?')) {
      return Response.json(duplicate ? [{ html_url: prUrl }] : []);
    }
    throw new Error(`Unexpected prepare request: ${href}`);
  });
  const prepared = await prepare(env, identity, identityKey);
  assert.equal(prepared.prUrl, null);
  assert.deepEqual(prepared.job?.branch, identityBranch);
  assert.equal(prepared.job?.baseBranch, 'main');
  assert.equal(prepared.job?.baseSha, job.baseSha);
  assert.equal(prepared.job?.targetBranch, 'develop');
  assert.equal(prepared.job?.issueNumber, undefined);
  assert.equal(prepared.job?.context.route, '/campus');
  duplicate = true;
  const repeated = await prepare(env, identity, identityKey);
  assert.deepEqual(repeated, { job: null, prUrl });
  duplicate = false;
  const previewKey = 'sentry/bcsd/koin-united-preview/124';
  const previewPrepared = await prepare(env, preview, previewKey);
  assert.equal(previewPrepared.job?.baseBranch, 'develop');
  assert.equal(previewPrepared.job?.baseSha, 'd'.repeat(40));
  assert.equal(previewPrepared.job?.targetBranch, 'develop');
  const cloudflareKey = `cloudflare/${cloudflare.scope.accountId}/${cloudflare.scope.policyId}/${cloudflare.project}/${cloudflare.sourceId}`;
  const cloudflarePrepared = await prepare(env, cloudflare, cloudflareKey);
  assert.equal(cloudflarePrepared.job?.baseBranch, 'main');
  assert.equal(cloudflarePrepared.job?.baseSha, job.baseSha);
  assert.equal(cloudflarePrepared.job?.targetBranch, 'develop');
  const configured = env.ERROR_SOURCE_BRANCHES;
  env.ERROR_SOURCE_BRANCHES = '{"sentry:koin-united-prod":"main","sentry:koin-united-preview":"develop"}';
  await assert.rejects(prepare(env, cloudflare, cloudflareKey), /Configure fixed GitHub App/);
  env.ERROR_SOURCE_BRANCHES = configured.replace('"cloudflare:koin-api":"main"', '"cloudflare:koin-api":"preview"');
  await assert.rejects(prepare(env, cloudflare, cloudflareKey), /Configure fixed GitHub App/);
  env.ERROR_SOURCE_BRANCHES = configured;
  assert.equal(
    requests.some(([url]) => url.includes('/issues') && url.startsWith('https://api.github.com/')),
    false,
  );
  assert.equal(
    requests.some(([url, method]) => method === 'POST' && !url.endsWith('/access_tokens')),
    false,
  );
});

test('publish creates a PR directly with source context and independently verified checks', async (t) => {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const env = {
    GITHUB_OWNER: 'BCSDLab',
    GITHUB_REPOSITORY: 'BCSD_united',
    GITHUB_DISPATCH_APP_ID: '5522353',
    GITHUB_DISPATCH_INSTALLATION_ID: '176455083',
    GITHUB_DISPATCH_APP_PRIVATE_KEY: key,
  };
  const writes = [];
  const url = 'https://github.com/BCSDLab/BCSD_united/pull/12';
  const proof = {
    baseSha: job.baseSha,
    verifiedManifest: manifest,
    passedChecks: checks,
    manifestSha256: digest(manifest),
  };
  let duplicate = false;
  let humanBranch = false;
  let advanced = false;
  t.mock.method(globalThis, 'fetch', async (endpoint, options = {}) => {
    const href = String(endpoint);
    if (href.endsWith('/access_tokens')) {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.permissions, { contents: 'write', issues: 'write', pull_requests: 'write' });
      return Response.json({
        token: 'write-token',
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        repositories: [{ full_name: 'BCSDLab/BCSD_united' }],
        permissions: body.permissions,
      });
    }
    const api = href.replace('https://api.github.com/repos/BCSDLab/BCSD_united', '');
    if (options.method === 'POST') writes.push(api);
    if (api === '') return Response.json({ default_branch: 'develop', owner: { login: 'BCSDLab' } });
    if (api === '/commits/main')
      return Response.json({ sha: advanced ? 'f'.repeat(40) : job.baseSha, commit: { tree: { sha: 'b'.repeat(40) } } });
    if (api.startsWith('/pulls?')) return Response.json(duplicate ? [{ html_url: url }] : []);
    if (api === '/git/blobs') return Response.json({ sha: 'c'.repeat(40) });
    if (api === '/git/trees') {
      assert.equal(JSON.parse(options.body).base_tree, 'b'.repeat(40));
      return Response.json({ sha: 'd'.repeat(40) });
    }
    if (api === '/git/commits') {
      assert.deepEqual(JSON.parse(options.body).parents, [job.baseSha]);
      return Response.json({ sha: 'e'.repeat(40) });
    }
    if (api === '/git/refs') {
      assert.deepEqual(JSON.parse(options.body), { ref: `refs/heads/${identityBranch}`, sha: 'e'.repeat(40) });
      return humanBranch ? Response.json({}, { status: 422 }) : Response.json({ ref: identityBranch });
    }
    if (api === `/git/ref/heads/${encodeURIComponent(identityBranch)}`)
      return Response.json({ object: { sha: 'f'.repeat(40) } });
    if (api === `/git/commits/${'f'.repeat(40)}`)
      return Response.json({ tree: { sha: '0'.repeat(40) }, parents: [{ sha: job.baseSha }] });
    if (api === '/pulls' && options.method === 'POST') {
      const body = JSON.parse(options.body);
      assert.equal(body.head, identityBranch);
      assert.equal(body.base, 'develop');
      assert.match(body.body, /https:\/\/bcsd\.sentry\.io\/issues\/123\//);
      assert.match(body.body, /Project: `koin-united-prod`/);
      assert.match(body.body, /App: `apps\/web`/);
      assert.match(body.body, /Verified request: `GET \/campus`/);
      assert.match(body.body, /Verified source branch: `main` at `a{40}`/);
      assert.match(body.body, /PR target branch: `develop`/);
      assert.match(body.body, /Candidate was independently verified on the source branch \(`main`\)/);
      assert.match(body.body, /PR's CI must validate develop integration/);
      assert.match(body.body, /authored by the GitHub App bot and is never eligible/);
      assert.match(body.body, /regression-fails-on-base/);
      assert.doesNotMatch(body.body, /Close #|issue : #/);
      return Response.json({ html_url: url });
    }
    throw new Error(`Unexpected publish request: ${api}`);
  });
  assert.equal(await publish(env, job, proof), url);
  assert.deepEqual(writes, ['/git/blobs', '/git/blobs', '/git/trees', '/git/commits', '/git/refs', '/pulls']);
  duplicate = true;
  await assert.rejects(publish(env, job, proof), /A PR already exists/);
  await assert.rejects(
    publish(env, { ...job, branch: 'fix/human-branch' }, proof),
    /Prepared branch identity mismatch/,
  );
  assert.equal(writes.filter((request) => request === '/pulls').length, 1);
  duplicate = false;
  humanBranch = true;
  await assert.rejects(publish(env, job, proof), /never overwrite human changes/);
  assert.equal(writes.filter((request) => request === '/pulls').length, 1);
  advanced = true;
  const beforeStale = writes.length;
  await assert.rejects(publish(env, job, proof), /Source branch advanced/);
  assert.equal(writes.length, beforeStale, 'advanced main forbids all repository writes');
});
