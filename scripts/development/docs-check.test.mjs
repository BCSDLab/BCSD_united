import assert from 'node:assert/strict';
import test from 'node:test';
import { findBrokenReferences } from './docs-check.mjs';

const present = new Set(['docs/guide/setup.md', 'scripts/development/cli.mjs', 'apps/web/src', 'README.md']);
const check = (markdown, file = 'docs/guide/README.md') =>
  findBrokenReferences(markdown, file, (target) => present.has(target));

test('relative links resolve from the document and root-style code paths from the repository root', () => {
  const markdown = [
    '[ok](./setup.md#install) [up](../../README.md) [gone](./missing.md)',
    '`scripts/development/cli.mjs` `apps/web/src/` `scripts/development/removed.mjs`',
  ].join('\n');
  assert.deepEqual(check(markdown), [
    { line: 1, target: 'docs/guide/missing.md', kind: 'link' },
    { line: 2, target: 'scripts/development/removed.mjs', kind: 'path' },
  ]);
});

test('external links, anchors, placeholders, other code spans, and fenced blocks are not checked', () => {
  const markdown = [
    '[site](https://example.com/x.md) [mail](mailto:a@b.c) [here](#section)',
    '`scripts/development/*.test.mjs` `apps/<name>/README.md` `profiles/web.example.json` `pnpm test`',
    '```sh',
    'node scripts/development/removed.mjs  # `scripts/development/removed.mjs`',
    '```',
  ].join('\n');
  assert.deepEqual(check(markdown), []);
});

test('links that leave the repository are ignored rather than reported', () => {
  assert.deepEqual(check('[outside](../../../elsewhere.md)'), []);
});
