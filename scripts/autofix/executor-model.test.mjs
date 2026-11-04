import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { errorToolScope, pullRequestToolScope, sourceTools } from './executor-model.mjs';

test('source-only model tools keep edits inside the observed app and new regression files', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'autofix-source-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'apps/web/src'), { recursive: true });
  await mkdir(join(root, 'apps/api/src'), { recursive: true });
  await mkdir(join(root, 'tests/autofix'), { recursive: true });
  await writeFile(join(root, 'apps/web/src/page.ts'), 'export const before = 1;\n');
  await writeFile(join(root, 'tests/autofix/existing.test.mjs'), 'existing');
  await writeFile(join(root, 'private.txt'), 'not for model');
  await writeFile(join(root, 'apps/web/src/.secret'), 'hidden-value');
  await symlink(join(root, 'private.txt'), join(root, 'apps/web/src/escape.ts'));
  const tools = sourceTools(root, errorToolScope('web'), new Set(['tests/autofix/existing.test.mjs']));
  assert.match(await tools.apply('Read', { path: 'apps/web/src/page.ts:1-1' }), /before = 1/);
  assert.equal(
    await tools.apply('Edit', {
      path: 'apps/web/src/page.ts',
      oldText: 'before = 1',
      newText: 'after = 2',
    }),
    'Updated apps/web/src/page.ts',
  );
  assert.equal(await readFile(join(root, 'apps/web/src/page.ts'), 'utf8'), 'export const after = 2;\n');
  assert.equal(
    await tools.apply('Write', {
      path: 'tests/autofix/regression.test.mjs',
      content: 'import assert from "node:assert";\nassert.ok(true);',
    }),
    'Updated tests/autofix/regression.test.mjs',
  );
  assert.match(await tools.apply('Glob', { path: 'apps/web/src' }), /apps\/web\/src\/page\.ts/);
  assert.match(await tools.apply('Grep', { path: 'apps/web/src', pattern: 'after' }), /page\.ts:1/);
  assert.doesNotMatch(await tools.apply('Glob', { path: 'apps/web/src' }), /\.secret/);
  assert.equal(await tools.apply('Grep', { path: 'apps/web/src', pattern: 'hidden-value' }), '');
  for (const [tool, input] of [
    ['Read', { path: 'private.txt' }],
    ['Read', { path: '../private.txt' }],
    ['Read', { path: 'apps/web/src/escape.ts' }],
    ['Write', { path: 'apps/api/src/other.ts', content: 'unsafe' }],
    ['Write', { path: 'tests/autofix/existing.test.mjs', content: 'weaken' }],
    ['Write', { path: 'scripts/autofix/verify.mjs', content: 'unsafe' }],
    ['Write', { path: 'apps/api/src/db/schema.ts', content: 'unsafe' }],
    ['Bash', { command: 'echo unsafe' }],
    ['Edit', { path: 'apps/web/src/page.ts', oldText: 'missing', newText: 'bad' }],
  ])
    await assert.rejects(tools.apply(tool, input));
  assert.equal(await readFile(join(root, 'tests/autofix/existing.test.mjs'), 'utf8'), 'existing');
});

test('pull-request tools read related trees, review inputs and public config but write only policy paths', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'autofix-pr-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of [
    'apps/web/src',
    'apps/api/src',
    'packages/telemetry/src',
    'pr-input',
    'tests/autofix',
    '.github/workflows',
  ])
    await mkdir(join(root, directory), { recursive: true });
  await writeFile(join(root, 'apps/web/src/page.ts'), 'export const before = 1;\n');
  await writeFile(join(root, 'apps/web/package.json'), '{"name":"@koin/web"}\n');
  await writeFile(join(root, 'apps/web/.dev.vars'), 'SECRET=1\n');
  await writeFile(join(root, 'apps/api/src/other.ts'), 'export const api = 1;\n');
  await writeFile(join(root, 'packages/telemetry/src/index.ts'), 'export const t = 1;\n');
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await writeFile(join(root, 'pr-input/review.json'), '{"pullNumber":7}');
  await writeFile(join(root, 'pr-input/diff.patch'), 'diff --git a/x b/x');
  await writeFile(join(root, '.github/workflows/ci.yml'), 'on: push\n');
  const changed = ['apps/web/src/page.ts', 'apps/web/package.json', 'pnpm-lock.yaml', '.github/workflows/ci.yml'];
  const tools = sourceTools(root, pullRequestToolScope(changed), new Set());
  assert.match(await tools.apply('Read', { path: 'pr-input/review.json' }), /pullNumber/);
  assert.match(await tools.apply('Read', { path: 'pr-input/diff.patch' }), /diff --git/);
  assert.match(await tools.apply('Read', { path: 'pnpm-lock.yaml:1-1' }), /lockfileVersion/);
  assert.match(await tools.apply('Read', { path: 'apps/web/package.json' }), /@koin\/web/);
  assert.match(await tools.apply('Glob', { path: 'apps/web' }), /apps\/web\/src\/page\.ts/);
  assert.doesNotMatch(await tools.apply('Glob', { path: 'apps/web' }), /dev\.vars/);
  assert.equal(await tools.apply('Grep', { path: 'apps/web', pattern: 'SECRET' }), '');
  assert.equal(
    await tools.apply('Edit', { path: 'apps/web/src/page.ts', oldText: 'before = 1', newText: 'after = 2' }),
    'Updated apps/web/src/page.ts',
  );
  assert.equal(
    await tools.apply('Write', { path: 'apps/web/src/page.test.ts', content: 'import assert from "node:assert";' }),
    'Updated apps/web/src/page.test.ts',
  );
  assert.equal(
    await tools.apply('Write', { path: 'apps/web/README.md', content: '# web' }),
    'Updated apps/web/README.md',
  );
  for (const [tool, input] of [
    ['Read', { path: 'apps/api/src/other.ts' }],
    ['Read', { path: 'packages/telemetry/src/index.ts' }],
    ['Read', { path: 'apps/web/.dev.vars' }],
    ['Read', { path: '.github/workflows/ci.yml' }],
    ['Glob', { path: 'apps/api' }],
    ['Write', { path: 'apps/web/package.json', content: '{}' }],
    ['Write', { path: 'pnpm-lock.yaml', content: '' }],
    ['Write', { path: 'apps/web/wrangler.jsonc', content: '{}' }],
    ['Write', { path: 'apps/web/vite.config.ts', content: '' }],
    ['Write', { path: 'apps/api/src/other.ts', content: 'unrelated' }],
    ['Write', { path: 'tests/autofix/regression.test.mjs', content: 'x' }],
    ['Write', { path: 'scripts/autofix/verify.mjs', content: 'x' }],
    ['Write', { path: 'apps/web/src/escape.sh', content: 'x' }],
    ['Write', { path: 'pr-input/review.json', content: '{}' }],
    ['Bash', { command: 'echo unsafe' }],
  ])
    await assert.rejects(tools.apply(tool, input), undefined, `${tool} ${input.path ?? input.command}`);
  assert.equal(await readFile(join(root, 'pnpm-lock.yaml'), 'utf8'), 'lockfileVersion: 9\n');
});
