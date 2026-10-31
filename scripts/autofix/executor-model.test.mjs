import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceTools } from './executor-model.mjs';

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
  const tools = sourceTools(root, 'web', new Set(['tests/autofix/existing.test.mjs']));
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
