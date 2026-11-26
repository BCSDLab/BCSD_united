#!/usr/bin/env node
// 문서가 가리키는 저장소 경로가 실제로 있는지 검사한다. 문서가 코드보다 늦게 고쳐져 낡는 것을 잡는다.
// - 상대 경로 Markdown 링크: 문서 위치 기준으로 해석한다.
// - 저장소 루트에서 시작하는 코드 표기(`apps/...`, `scripts/...` 등): 루트 기준으로 해석한다.
// 외부 URL, 앵커, 자리표시자가 든 경로(`*`, `<`, `{`, `$`, `…`)는 검사하지 않는다.
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOTS = ['apps/', 'packages/', 'scripts/', 'docs/', '.github/', '.agents/'];
const PLACEHOLDER = /[*<>{}$…]|\.\.\./;

/** `exists(repoRelativePath)`로 확인해 없는 참조를 { line, target, kind }로 돌려준다. 코드 블록 안은 건너뛴다. */
export function findBrokenReferences(markdown, file, exists) {
  const broken = [];
  const directory = path.posix.dirname(file);
  let fenced = false;
  for (const [index, text] of markdown.split('\n').entries()) {
    if (/^\s*(```|~~~)/.test(text)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const check = (target, kind) => {
      if (!exists(target)) broken.push({ line: index + 1, target, kind });
    };
    for (const [, href] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = decodeURI(href.split('#')[0]);
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(href) || PLACEHOLDER.test(target)) continue;
      const resolved = path.posix.normalize(path.posix.join(directory, target));
      if (!resolved.startsWith('..')) check(resolved.replace(/\/$/, ''), 'link');
    }
    for (const [, code] of text.matchAll(/`([^`\s]+)`/g)) {
      if (!ROOTS.some((root) => code.startsWith(root)) || PLACEHOLDER.test(code)) continue;
      // `파일:줄` 표기는 파일까지만 확인하고, 커밋하지 않는 로컬 파일(.env.local, .dev.vars 등)은 건너뛴다.
      const target = code.replace(/:\d[\d,-]*$/, '').replace(/\/$/, '');
      if (path.posix.basename(target).startsWith('.')) continue;
      check(target, 'path');
    }
  }
  return broken;
}

async function main(files) {
  if (files.length === 0)
    throw new Error('Usage: docs-check.mjs FILE.md [FILE.md ...] (paths relative to the repository root)');
  let count = 0;
  for (const file of files) {
    const name = file.replaceAll('\\', '/');
    for (const { line, target, kind } of findBrokenReferences(await readFile(name, 'utf8'), name, existsSync)) {
      count += 1;
      console.error(
        `${name}:${line} ${kind} points to missing "${target}". Update the reference to the current location, or remove the sentence if the thing no longer exists.`,
      );
    }
  }
  if (count > 0) process.exitCode = 1;
  else console.log(`${files.length} documents: every repository reference exists`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
