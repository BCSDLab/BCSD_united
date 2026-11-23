#!/usr/bin/env node
// 디자인 토큰(apps/web/src/utils/scss/tokens.scss)의 적용 현황을 세고, 토큰과 값이 정확히 같은 원시값을 토큰 참조로 바꾼다.
// - report DIR: DIR 아래 .scss의 선언을 세어 최상위 하위 디렉터리별·전체 Markdown 표로 출력한다.
// - apply DIR: 정확히 같은 토큰이 있는 원시값만 `tokens.$이름`으로 바꾸고, @use 줄이 없으면 넣는다. 다시 실행해도 결과가 같다.
// 규칙
// - 색: 대소문자를 무시하고 #rgb == #rrggbb, #rgba == #rrggbbaa로 본다. 투명도가 있는 hex는 같은 투명도의 토큰이 있을 때만
//   바꾸고, 앞 여섯 자리가 같은 불투명 토큰으로는 바꾸지 않는다.
// - font-size·font-weight·border-radius: 그 속성의 값 전체가 토큰 값 하나와 같을 때만 바꾼다(여러 값 축약형은 그대로 둔다).
// - 주석, 문자열, url(), 선택자, @include·@return 이외의 at-rule은 건드리지 않는다.
// - 사용자 지정 속성(--x)은 Sass가 값을 계산하지 않으므로 #{tokens.$이름}으로 넣는다.
// - 토큰 파일과 그 파일이 @forward하는 파일, node_modules는 대상에서 뺀다.
// - 이미 있는 @use 줄과 `palette.$이름` 같은 기존 참조는 바꾸지 않는다. report는 토큰 파일과 @forward 대상의 이름공간을
//   모두 토큰 참조로 센다.
// 한계: 컴파일 결과는 원시값의 표기가 토큰 정의와 같을 때만 바이트 단위로 같다(#FFFFFF는 #fff로 출력된다).
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const usage = 'Usage: tokens.mjs report|apply DIR';
const TOKEN_FILE = fileURLToPath(new URL('../../apps/web/src/utils/scss/tokens.scss', import.meta.url));
const TOKEN_MODULE = 'tokens';
const TOKEN_USE = '@use "src/utils/scss/tokens" as tokens;';
const CATEGORIES = [
  ['color', 'Color'],
  ['fontSize', 'Font-size'],
  ['fontWeight', 'Font-weight'],
  ['radius', 'Radius'],
];
const SCOPED = { 'font-size': 'fontSize', 'font-weight': 'fontWeight', 'border-radius': 'radius' };
const NAME_PREFIX = { 'font-size-': 'fontSize', 'font-weight-': 'fontWeight', 'radius-': 'radius' };
const RAW = { fontSize: /\dpx\b/, fontWeight: /^\d+$/, radius: /\d(?:px\b|%)/ };
const HEX = /#([0-9a-f]+)(?![\w-])/gi;
const HEX_LENGTHS = [3, 4, 6, 8];

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeHex(digits) {
  const lower = digits.toLowerCase();
  return lower.length <= 4 ? lower.replace(/./g, '$&$&') : lower;
}

function moduleName(usePath) {
  return usePath
    .split(/[/:]/)
    .pop()
    .replace(/^_/, '')
    .replace(/\.(scss|sass|css)$/, '');
}

function skipString(source, index) {
  const quote = source[index];
  for (let i = index + 1; i < source.length; i += 1) {
    if (source[i] === '\\') i += 1;
    else if (source.startsWith('#{', i)) i = skipInterpolation(source, i) - 1;
    else if (source[i] === quote) return i + 1;
    else if (source[i] === '\n') return i;
  }
  return source.length;
}

function skipInterpolation(source, index) {
  for (let i = index + 2; i < source.length; i += 1) {
    if (source[i] === '"' || source[i] === "'") i = skipString(source, i) - 1;
    else if (source.startsWith('#{', i)) i = skipInterpolation(source, i) - 1;
    else if (source[i] === '}') return i + 1;
  }
  return source.length;
}

function skipUrl(source, index) {
  let depth = 1;
  for (let i = index + 4; i < source.length; i += 1) {
    if (source[i] === '"' || source[i] === "'") i = skipString(source, i) - 1;
    else if (source[i] === '(') depth += 1;
    else if (source[i] === ')' && (depth -= 1) === 0) return i;
  }
  return source.length;
}

/** 주석, 문자열 안쪽, url() 안쪽을 공백으로 바꾼 같은 길이의 문자열을 돌려준다. 위치가 원문과 같아 치환 위치로 쓸 수 있다. */
export function maskScss(source) {
  const output = [...source];
  const blank = (from, to) => {
    for (let i = from; i < to; i += 1) if (output[i] !== '\n' && output[i] !== '\r') output[i] = ' ';
  };
  let i = 0;
  while (i < source.length) {
    let end = i + 1;
    if (source.startsWith('//', i)) {
      end = source.indexOf('\n', i);
      if (end === -1) end = source.length;
      blank(i, end);
    } else if (source.startsWith('/*', i)) {
      end = source.indexOf('*/', i + 2);
      end = end === -1 ? source.length : end + 2;
      blank(i, end);
    } else if (source[i] === '"' || source[i] === "'") {
      end = skipString(source, i);
      blank(i + 1, source[end - 1] === source[i] && end - 1 > i ? end - 1 : end);
    } else if (/^url\($/i.test(source.slice(i, i + 4)) && !/[\w-]/.test(source[i - 1] ?? '')) {
      end = skipUrl(source, i);
      blank(i + 4, end);
    }
    i = end;
  }
  return output.join('');
}

function* statements(masked) {
  let start = 0;
  let parens = 0;
  let interpolation = 0;
  let depth = 0;
  for (let i = 0; i < masked.length; i += 1) {
    const character = masked[i];
    if (character === '#' && masked[i + 1] === '{') {
      interpolation += 1;
      i += 1;
    } else if (interpolation > 0) {
      if (character === '}') interpolation -= 1;
    } else if (character === '(') parens += 1;
    else if (character === ')') parens = Math.max(0, parens - 1);
    else if (parens === 0 && (character === ';' || character === '{' || character === '}')) {
      yield { start, end: i, terminator: character, depth };
      if (character === '{') depth += 1;
      else if (character === '}') depth -= 1;
      start = i + 1;
    }
  }
  yield { start, end: masked.length, terminator: '', depth };
}

function* trimmedStatements(masked) {
  for (const { start, end, terminator, depth } of statements(masked)) {
    const text = masked.slice(start, end);
    const body = text.trim();
    if (body) yield { body, start: start + text.length - text.trimStart().length, terminator, depth };
  }
}

/** 값을 가진 구문을 { property, start, end, depth }로 돌려준다. start~end는 값의 위치이고 @include·@return은 property가 null이다. */
function* declarations(masked) {
  for (const { body, start, terminator, depth } of trimmedStatements(masked)) {
    if (body.startsWith('@')) {
      const rule = /^@(include|return)\b/.exec(body);
      if (rule) yield { property: null, start: start + rule[0].length, end: start + body.length, depth };
      continue;
    }
    const colon = body.indexOf(':');
    if (terminator === '{' || colon === -1) continue;
    yield { property: body.slice(0, colon).trim(), start: start + colon + 1, end: start + body.length, depth };
  }
}

/** `@use`·`@forward` 구문을 { target, module, namespace, end, depth }로 돌려준다. end는 세미콜론 다음 위치다. */
function moduleRules(source, masked, keyword) {
  const rules = [];
  for (const { body, start, terminator, depth } of trimmedStatements(masked)) {
    if (terminator !== ';' || !body.startsWith(`@${keyword}`)) continue;
    const match = /^@\w+\s+(["'])([^"']+)\1(?:\s+as\s+([\w-]+|\*))?/.exec(source.slice(start, start + body.length));
    if (!match) continue;
    const module = moduleName(match[2]);
    rules.push({ target: match[2], module, namespace: match[3] ?? module, end: start + body.length + 1, depth });
  }
  return rules;
}

function rawHexes(masked, start, end) {
  const found = [];
  for (const match of masked.slice(start, end).matchAll(HEX)) {
    if (!HEX_LENGTHS.includes(match[1].length)) continue;
    const from = start + match.index;
    found.push({ start: from, end: from + match[0].length, key: normalizeHex(match[1]) });
  }
  return found;
}

function scopedValue(masked, property, start, end) {
  const category = property === null ? undefined : SCOPED[property.toLowerCase()];
  if (!category) return null;
  const text = masked.slice(start, end).replace(/\s*!important\s*$/i, '');
  const value = text.trim();
  const from = start + text.length - text.trimStart().length;
  return { category, key: value.toLowerCase(), start: from, end: from + value.length };
}

/**
 * 모듈 이름 → SCSS 원문 객체에서 토큰을 읽는다. 최상위 `$이름: 값;` 가운데 hex 색과 font-size-·font-weight-·radius- 이름만 토큰이다.
 * 같은 값에 이름이 둘이면 어느 이름으로 바꿀지 정할 수 없으므로 실패한다.
 */
export function parseTokens(modules) {
  const tokens = {
    modules: Object.keys(modules),
    names: new Map(),
    color: new Map(),
    fontSize: new Map(),
    fontWeight: new Map(),
    radius: new Map(),
  };
  for (const source of Object.values(modules)) {
    const masked = maskScss(source);
    for (const { property, start, end, depth } of declarations(masked)) {
      if (depth !== 0 || !property?.startsWith('$')) continue;
      const name = property.slice(1);
      const value = masked
        .slice(start, end)
        .replace(/\s*!default\s*$/, '')
        .trim();
      const hex = /^#([0-9a-f]+)$/i.exec(value);
      const prefix = Object.keys(NAME_PREFIX).find((candidate) => name.startsWith(candidate));
      let category;
      let key;
      if (hex && HEX_LENGTHS.includes(hex[1].length)) [category, key] = ['color', normalizeHex(hex[1])];
      else if (prefix) [category, key] = [NAME_PREFIX[prefix], value.toLowerCase()];
      else continue;
      requireValue(!tokens.names.has(name), `Token $${name} is defined more than once`);
      requireValue(
        !tokens[category].has(key),
        `Tokens $${tokens[category].get(key)} and $${name} share the value ${value}. Keep one name per value.`,
      );
      tokens.names.set(name, category);
      tokens[category].set(key, name);
    }
  }
  return tokens;
}

/** 토큰 파일과 그 파일이 상대 경로로 @forward하는 파일을 읽는다. files는 report·apply 대상에서 뺄 절대 경로다. */
export async function loadTokens(file = TOKEN_FILE) {
  const modules = {};
  const files = [];
  const visit = async (target) => {
    const source = await readFile(target, 'utf8');
    modules[moduleName(path.basename(target))] = source;
    files.push(path.resolve(target));
    for (const { target: forwarded } of moduleRules(source, maskScss(source), 'forward')) {
      const directory = path.resolve(path.dirname(target), path.dirname(forwarded));
      const name = path.basename(forwarded).replace(/\.scss$/, '');
      const found = [`${name}.scss`, `_${name}.scss`]
        .map((candidate) => path.join(directory, candidate))
        .find(existsSync);
      requireValue(found, `${target} forwards "${forwarded}", which is not a .scss file next to it`);
      await visit(found);
    }
  };
  await visit(file);
  return { tokens: parseTokens(modules), files };
}

/** 정확히 같은 토큰이 있는 원시값을 토큰 참조로 바꾼 { output, replacements }를 돌려준다. 바꿀 값이 없으면 원문 그대로다. */
export function applyTokens(source, tokens) {
  const masked = maskScss(source);
  const uses = moduleRules(source, masked, 'use').filter(({ depth }) => depth === 0);
  const own = uses.find(({ module }) => module === TOKEN_MODULE);
  const namespace = own?.namespace ?? TOKEN_MODULE;
  const edits = [];
  for (const { property, start, end } of declarations(masked)) {
    const reference = (name) => {
      const variable = namespace === '*' ? `$${name}` : `${namespace}.$${name}`;
      return property?.startsWith('--') ? `#{${variable}}` : variable;
    };
    for (const hex of rawHexes(masked, start, end)) {
      const name = tokens.color.get(hex.key);
      if (name) edits.push({ start: hex.start, end: hex.end, text: reference(name) });
    }
    const scoped = scopedValue(masked, property, start, end);
    const name = scoped && tokens[scoped.category].get(scoped.key);
    if (name) edits.push({ start: scoped.start, end: scoped.end, text: reference(name) });
  }
  if (edits.length === 0) return { output: source, replacements: 0 };
  const replacements = edits.length;
  if (!own) {
    requireValue(
      !uses.some((use) => use.namespace === TOKEN_MODULE),
      `Namespace "${TOKEN_MODULE}" already belongs to another module. Rename that @use alias, then run apply again.`,
    );
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    const after = uses.at(-1)?.end;
    if (after === undefined) edits.push({ start: 0, end: 0, text: `${TOKEN_USE}${eol}${eol}` });
    else edits.push({ start: after, end: after, text: `${eol}${TOKEN_USE}` });
  }
  let output = source;
  for (const { start, end, text } of edits.toSorted((a, b) => b.start - a.start)) {
    output = output.slice(0, start) + text + output.slice(end);
  }
  return { output, replacements };
}

function emptyCounts() {
  return Object.fromEntries(CATEGORIES.map(([category]) => [category, { raw: 0, tokenizable: 0, token: 0 }]));
}

function tally(count, raw, tokenizable, token) {
  if (raw) {
    count.raw += 1;
    if (tokenizable) count.tokenizable += 1;
  } else if (token) count.token += 1;
}

/**
 * 선언 단위로 센다. raw는 원시값이 하나라도 있는 선언, tokenizable은 그 가운데 apply가 모든 원시값을 바꿀 수 있는 선언,
 * token은 원시값 없이 토큰만 참조하는 선언이다. 색은 모든 선언에서, 나머지는 해당 속성에서만 센다.
 */
export function countUsage(source, tokens) {
  const masked = maskScss(source);
  const namespaces = new Set(
    moduleRules(source, masked, 'use')
      .filter(({ module }) => tokens.modules.includes(module))
      .map(({ namespace }) => namespace),
  );
  const counts = emptyCounts();
  for (const { property, start, end } of declarations(masked)) {
    const referenced = new Set();
    for (const [, namespace = '*', name] of masked.slice(start, end).matchAll(/(?:([\w-]+)\.)?\$([\w-]+)/g)) {
      if (namespaces.has(namespace) && tokens.names.has(name)) referenced.add(tokens.names.get(name));
    }
    const hexes = rawHexes(masked, start, end);
    tally(
      counts.color,
      hexes.length > 0,
      hexes.every(({ key }) => tokens.color.has(key)),
      referenced.has('color'),
    );
    const scoped = scopedValue(masked, property, start, end);
    if (!scoped) continue;
    const { category, key } = scoped;
    tally(counts[category], RAW[category].test(key), tokens[category].has(key), referenced.has(category));
  }
  return counts;
}

async function scssFiles(directory, excluded) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.scss'))
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => !excluded.includes(path.resolve(file)) && !file.split(path.sep).includes('node_modules'))
    .map((file) => path.relative(directory, file).split(path.sep).join('/'))
    .toSorted();
}

/** directory 바로 아래 하위 디렉터리별 합계와 Total 행을 돌려준다. 바로 아래 파일은 `.` 행에 모은다. */
export async function collectUsage(directory, tokens, excluded = []) {
  const groups = new Map();
  const total = { name: 'Total', files: 0, counts: emptyCounts() };
  for (const file of await scssFiles(directory, excluded)) {
    const name = file.includes('/') ? file.split('/')[0] : '.';
    if (!groups.has(name)) groups.set(name, { name, files: 0, counts: emptyCounts() });
    const counts = countUsage(await readFile(path.join(directory, file), 'utf8'), tokens);
    for (const row of [groups.get(name), total]) {
      row.files += 1;
      for (const [category] of CATEGORIES) {
        for (const key of Object.keys(counts[category])) row.counts[category][key] += counts[category][key];
      }
    }
  }
  return [...[...groups.values()].toSorted((a, b) => a.name.localeCompare(b.name)), total];
}

/** collectUsage의 행을 Markdown 표로 만든다. Coverage는 네 범주를 합친 token / (raw + token)이다. */
export function formatReport(rows) {
  const header = ['Directory', 'Files'];
  for (const [, label] of CATEGORIES) header.push(`${label} raw (has token)`, `${label} token`);
  header.push('Coverage');
  const lines = [header, header.map((_, index) => (index === 0 ? '---' : '---:'))];
  for (const { name, files, counts } of rows) {
    const cells = [name, String(files)];
    let raw = 0;
    let token = 0;
    for (const [category] of CATEGORIES) {
      const count = counts[category];
      cells.push(`${count.raw} (${count.tokenizable})`, String(count.token));
      raw += count.raw;
      token += count.token;
    }
    cells.push(raw + token === 0 ? '-' : `${((token / (raw + token)) * 100).toFixed(1)}%`);
    lines.push(cells);
  }
  return lines.map((cells) => `| ${cells.join(' | ')} |`).join('\n');
}

async function main([command, directory, ...rest]) {
  requireValue((command === 'report' || command === 'apply') && directory && rest.length === 0, usage);
  const { tokens, files } = await loadTokens();
  if (command === 'report') {
    const rows = await collectUsage(directory, tokens, files);
    requireValue(rows.at(-1).files > 0, `No .scss files under ${directory}`);
    console.log(formatReport(rows));
    console.log(
      '\nCounts are declarations. "raw" has at least one raw value, "(has token)" is how many of those `apply` can rewrite because every raw value has an exact token, "token" references tokens only.',
    );
    return;
  }
  const targets = await scssFiles(directory, files);
  requireValue(targets.length > 0, `No .scss files under ${directory}`);
  let changed = 0;
  let total = 0;
  for (const name of targets) {
    const file = path.join(directory, name);
    const source = await readFile(file, 'utf8');
    let result;
    try {
      result = applyTokens(source, tokens);
    } catch (error) {
      throw new Error(`${name}: ${error.message}`, { cause: error });
    }
    if (result.output === source) continue;
    await writeFile(file, result.output);
    changed += 1;
    total += result.replacements;
    console.log(`${name}: ${result.replacements} raw values replaced`);
  }
  console.log(`${changed} of ${targets.length} files changed, ${total} raw values replaced with tokens`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
