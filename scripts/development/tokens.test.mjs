import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyTokens, collectUsage, countUsage, formatReport, loadTokens, maskScss, parseTokens } from './tokens.mjs';

const USE = '@use "src/utils/scss/tokens" as tokens;';
const PALETTE_USE = '@use "src/utils/scss/order-palette" as palette;';
const tokens = parseTokens({
  tokens: [
    '// 단일 진입점: #fff는 주석이라 토큰이 아니다',
    '@forward "order-palette";',
    '$white: #fff;',
    '$blue-500: #175c8e;',
    '$black-alpha-8: #00000014;',
    '$font-size-14: 14px;',
    '$font-weight-medium: 500;',
    '$radius-8: 8px;',
    '$radius-circle: 50%;',
    '.not-top-level { $nested: #123456; }',
  ].join('\n'),
  'order-palette': [
    '$primary-500: #b611f5;',
    '$shadow-1:',
    '  0 1px 1px rgb(0 0 0 / 2%),',
    '  0 2px 4px rgb(0 0 0 / 4%);',
  ].join('\n'),
});
const apply = (source) => applyTokens(source, tokens).output;
const rule = (...declarations) => `.a {\n${declarations.map((declaration) => `  ${declaration}\n`).join('')}}\n`;

test('parseTokens classifies top-level hex colors and prefixed names and ignores everything else', () => {
  assert.deepEqual(tokens.modules, ['tokens', 'order-palette']);
  assert.deepEqual(
    [...tokens.color],
    [
      ['ffffff', 'white'],
      ['175c8e', 'blue-500'],
      ['00000014', 'black-alpha-8'],
      ['b611f5', 'primary-500'],
    ],
  );
  assert.deepEqual([...tokens.fontSize], [['14px', 'font-size-14']]);
  assert.deepEqual([...tokens.fontWeight], [['500', 'font-weight-medium']]);
  assert.deepEqual(
    [...tokens.radius],
    [
      ['8px', 'radius-8'],
      ['50%', 'radius-circle'],
    ],
  );
  assert.equal(tokens.names.has('shadow-1'), false);
  assert.equal(tokens.names.has('nested'), false);
});

test('parseTokens rejects two names for one value, including 3- and 6-digit spellings of the same color', () => {
  assert.throws(
    () => parseTokens({ tokens: '$white: #fff;', palette: '$snow: #FFFFFF;' }),
    /\$white and \$snow share the value #FFFFFF/,
  );
  assert.throws(() => parseTokens({ tokens: '$radius-8: 8px;\n$radius-md: 8px;' }), /\$radius-8 and \$radius-md/);
});

test('the real token file loads with its forwarded palette and has one name per value', async () => {
  const { tokens: real, files } = await loadTokens();
  assert.deepEqual(
    files.map((file) => path.basename(file)),
    ['tokens.scss', 'order-palette.scss'],
  );
  assert.equal(real.color.get('ffffff'), 'white');
  assert.equal(real.color.get('175c8e'), 'blue-500');
  assert.equal(real.color.get('b611f5'), 'primary-500');
  assert.equal(real.color.get('d9d9d9'), 'star-empty');
  assert.equal(real.fontSize.get('14px'), 'font-size-14');
  assert.equal(real.fontWeight.get('600'), 'font-weight-semibold');
  assert.equal(real.radius.get('9999px'), 'radius-full');
  assert.equal(real.radius.get('50%'), 'radius-circle');
});

test('hex colors match case-insensitively and 3-digit equals 6-digit', () => {
  assert.equal(
    apply(rule('color: #FFFFFF;', 'background: #ffffff;', 'border: 1px solid #FFF;', 'outline-color: #175C8E;')),
    `${USE}\n\n${rule(
      'color: tokens.$white;',
      'background: tokens.$white;',
      'border: 1px solid tokens.$white;',
      'outline-color: tokens.$blue-500;',
    )}`,
  );
});

test('px and weight values are replaced only as the whole value of their own property', () => {
  const source = rule(
    'padding: 14px;',
    'line-height: 14px;',
    'border-top-left-radius: 8px;',
    'z-index: 500;',
    'font-size: 14px;',
    'font-weight: 500;',
    'border-radius: 8px;',
    'border-radius: 50% !important;',
    'border-radius: 8px 8px 0 0;',
    'border-radius: 999px;',
    'font-size: calc(14px + 1vw);',
    'font-size: 13px;',
    'font-weight: bold;',
    'font: 500 14px/1.5 sans-serif;',
  );
  assert.equal(
    apply(source),
    `${USE}\n\n${rule(
      'padding: 14px;',
      'line-height: 14px;',
      'border-top-left-radius: 8px;',
      'z-index: 500;',
      'font-size: tokens.$font-size-14;',
      'font-weight: tokens.$font-weight-medium;',
      'border-radius: tokens.$radius-8;',
      'border-radius: tokens.$radius-circle !important;',
      'border-radius: 8px 8px 0 0;',
      'border-radius: 999px;',
      'font-size: calc(14px + 1vw);',
      'font-size: 13px;',
      'font-weight: bold;',
      'font: 500 14px/1.5 sans-serif;',
    )}`,
  );
});

test('comments, strings, url(), selectors, and conditions are left alone', () => {
  const source = [
    '// color: #fff;',
    '/* background: #fff;',
    '   font-size: 14px; */',
    '#fff:hover,',
    '.b:not(#fff) {',
    '  content: "#fff";',
    "  font-family: '#fff';",
    '  mask: url(#fff);',
    '  background: url(data:image/svg+xml,%3Csvg fill=#fff%3E//x) no-repeat; // #fff',
    '  cursor: url("#fff.cur"), auto;',
    '  width: calc(100% - #{$gap});',
    '',
    '  @if $tone == #fff {',
    '    color: red;',
    '  }',
    '}',
    '',
    '@media (min-width: 14px) {',
    '  .c {',
    '    color: #abc;',
    '  }',
    '}',
    '',
  ].join('\n');
  assert.deepEqual(applyTokens(source, tokens), { output: source, replacements: 0 });
});

test('masking keeps offsets so a value after a comment, string, or url() is still replaced', () => {
  const source = '.a { content: "}"; background: url(a;b.png) #fff; /* ; */ color: #fff }\n';
  assert.equal(maskScss(source).length, source.length);
  assert.equal(
    apply(source),
    `${USE}\n\n.a { content: "}"; background: url(a;b.png) tokens.$white; /* ; */ color: tokens.$white }\n`,
  );
});

test('alpha hex never matches the opaque token and is replaced only by a token with the same alpha', () => {
  const source = rule(
    'color: #ffffff80;',
    'background: #fff8;',
    'border-color: #175c8e1a;',
    'box-shadow: 0 8px 32px 0 #00000014;',
    'outline-color: #0001;',
  );
  assert.equal(
    apply(source),
    `${USE}\n\n${rule(
      'color: #ffffff80;',
      'background: #fff8;',
      'border-color: #175c8e1a;',
      'box-shadow: 0 8px 32px 0 tokens.$black-alpha-8;',
      'outline-color: #0001;',
    )}`,
  );
});

test('values inside @include, @return, variables, and functions are replaced; custom properties are interpolated', () => {
  const source = [
    '$local: #fff;',
    '',
    '@function tone() {',
    '  @return #175c8e;',
    '}',
    '',
    '.a {',
    '  --surface: #fff;',
    '  background: linear-gradient(#fff, rgba(#175c8e, 0.5));',
    '',
    '  @include scrollbar(8px, #fff);',
    '  @include theme(#fff) {',
    '    color: #fff;',
    '  }',
    '}',
    '',
  ].join('\n');
  assert.equal(
    apply(source),
    [
      USE,
      '',
      '$local: tokens.$white;',
      '',
      '@function tone() {',
      '  @return tokens.$blue-500;',
      '}',
      '',
      '.a {',
      '  --surface: #{tokens.$white};',
      '  background: linear-gradient(tokens.$white, rgba(tokens.$blue-500, 0.5));',
      '',
      '  @include scrollbar(8px, tokens.$white);',
      '  @include theme(tokens.$white) {',
      '    color: tokens.$white;',
      '  }',
      '}',
      '',
    ].join('\n'),
  );
});

test('a file that uses order-palette keeps that line and its palette references', () => {
  const source = `@use "sass:math";\n${PALETTE_USE}\n\n${rule(
    'border-color: palette.$primary-500;',
    'box-shadow: palette.$shadow-1;',
    'background-color: #b611f5;',
    'color: #fff;',
  )}`;
  assert.equal(
    apply(source),
    `@use "sass:math";\n${PALETTE_USE}\n${USE}\n\n${rule(
      'border-color: palette.$primary-500;',
      'box-shadow: palette.$shadow-1;',
      'background-color: tokens.$primary-500;',
      'color: tokens.$white;',
    )}`,
  );
});

test('an existing tokens @use is reused with its namespace and line endings are preserved', () => {
  assert.equal(
    apply(`@use "utils/scss/tokens.scss" as t;\n\n${rule('color: #fff;')}`),
    `@use "utils/scss/tokens.scss" as t;\n\n${rule('color: t.$white;')}`,
  );
  assert.equal(
    apply(`@use "src/utils/scss/tokens" as *;\n\n${rule('color: #fff;')}`),
    `@use "src/utils/scss/tokens" as *;\n\n${rule('color: $white;')}`,
  );
  assert.equal(
    apply('@use "src/utils/scss/media" as media;\r\n\r\n.a {\r\n  color: #fff;\r\n}\r\n'),
    `@use "src/utils/scss/media" as media;\r\n${USE}\r\n\r\n.a {\r\n  color: tokens.$white;\r\n}\r\n`,
  );
  assert.equal(apply('.a {\r\n  color: #fff;\r\n}\r\n'), `${USE}\r\n\r\n.a {\r\n  color: tokens.$white;\r\n}\r\n`);
});

test('a tokens namespace owned by another module stops the file instead of producing broken references', () => {
  assert.throws(
    () => apply(`@use "src/utils/scss/media" as tokens;\n\n${rule('color: #fff;')}`),
    /Namespace "tokens" already belongs to another module/,
  );
});

test('apply is idempotent and does not add @use to a file with nothing to replace', () => {
  const source = `${PALETTE_USE}\n\n${rule(
    'color: #FFF;',
    'font-size: 14px;',
    'font-weight: 500;',
    'border-radius: 8px;',
    'background: #123456;',
    'box-shadow: 0 0 0 1px #00000014;',
  )}`;
  const once = applyTokens(source, tokens);
  assert.equal(once.replacements, 5);
  assert.deepEqual(applyTokens(once.output, tokens), { output: once.output, replacements: 0 });
  const untouched = rule('color: #123456;', 'padding: 14px;', 'border-radius: 8px 8px 0 0;');
  assert.deepEqual(applyTokens(untouched, tokens), { output: untouched, replacements: 0 });
});

test('countUsage counts declarations as raw, raw with an exact token, or token-only', () => {
  const source = [
    PALETTE_USE,
    USE,
    '@use "src/utils/scss/media" as media;',
    '',
    '$local: #fff;',
    '',
    '#fff .a {',
    '  color: #fff;',
    '  background: linear-gradient(#fff, #123456);',
    '  border: 1px solid #ffffff80;',
    '  border-color: palette.$primary-500;',
    '  outline-color: tokens.$white;',
    '  caret-color: media.$white;',
    '  box-shadow: palette.$shadow-1;',
    '  fill: red; // #fff',
    '  font-size: 14px;',
    '  font-size: 13px;',
    '  font-size: tokens.$font-size-14;',
    '  font-size: inherit;',
    '  font-weight: 500;',
    '  font-weight: 800;',
    '  font-weight: bold;',
    '  font-weight: tokens.$font-weight-medium;',
    '  border-radius: 8px;',
    '  border-radius: 50%;',
    '  border-radius: 8px 8px 0 0;',
    '  border-radius: tokens.$radius-8;',
    '  border-radius: 0;',
    '  padding: 14px;',
    '}',
    '',
  ].join('\n');
  assert.deepEqual(countUsage(source, tokens), {
    color: { raw: 4, tokenizable: 2, token: 2 },
    fontSize: { raw: 2, tokenizable: 1, token: 1 },
    fontWeight: { raw: 2, tokenizable: 1, token: 1 },
    radius: { raw: 3, tokenizable: 2, token: 1 },
  });
  const applied = countUsage(apply(source), tokens);
  assert.deepEqual(applied.color, { raw: 2, tokenizable: 0, token: 4 });
  assert.deepEqual(applied.fontSize, { raw: 1, tokenizable: 0, token: 2 });
  assert.deepEqual(applied.fontWeight, { raw: 1, tokenizable: 0, token: 2 });
  assert.deepEqual(applied.radius, { raw: 1, tokenizable: 0, token: 3 });
});

test('collectUsage groups by top-level directory, skips excluded files, and formatReport prints a Markdown table', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'development-tokens-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    'global.scss': rule('color: #fff;'),
    'components/ui/Button.module.scss': `${USE}\n\n${rule('color: tokens.$white;', 'font-size: 14px;')}`,
    'components/Card.module.scss': rule('color: #123456;'),
    'pages/Home.module.scss': `${USE}\n\n${rule('font-weight: tokens.$font-weight-medium;')}`,
    'pages/readme.md': 'color: #fff;',
    'utils/scss/tokens.scss': '$white: #fff;\n',
    'node_modules/pkg/index.scss': rule('color: #fff;'),
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  const rows = await collectUsage(root, tokens, [path.join(root, 'utils', 'scss', 'tokens.scss')]);
  assert.deepEqual(
    rows.map(({ name, files: count }) => [name, count]),
    [
      ['.', 1],
      ['components', 2],
      ['pages', 1],
      ['Total', 4],
    ],
  );
  assert.deepEqual(rows.at(-1).counts, {
    color: { raw: 2, tokenizable: 1, token: 1 },
    fontSize: { raw: 1, tokenizable: 1, token: 0 },
    fontWeight: { raw: 0, tokenizable: 0, token: 1 },
    radius: { raw: 0, tokenizable: 0, token: 0 },
  });
  assert.equal(
    formatReport(rows),
    [
      '| Directory | Files | Color raw (has token) | Color token | Font-size raw (has token) | Font-size token | Font-weight raw (has token) | Font-weight token | Radius raw (has token) | Radius token | Coverage |',
      '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
      '| . | 1 | 1 (1) | 0 | 0 (0) | 0 | 0 (0) | 0 | 0 (0) | 0 | 0.0% |',
      '| components | 2 | 1 (0) | 1 | 1 (1) | 0 | 0 (0) | 0 | 0 (0) | 0 | 33.3% |',
      '| pages | 1 | 0 (0) | 0 | 0 (0) | 0 | 0 (0) | 1 | 0 (0) | 0 | 100.0% |',
      '| Total | 4 | 2 (1) | 1 | 1 (1) | 0 | 0 (0) | 1 | 0 (0) | 0 | 40.0% |',
    ].join('\n'),
  );
});
