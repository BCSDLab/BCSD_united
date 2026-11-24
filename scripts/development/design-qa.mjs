#!/usr/bin/env node
// 계약: KOIN_DESIGN_QA_AGENT(`koin-qa`)를 하니스 프로필의 한 단계로 실행한다.
// - `--` 뒤의 인자를 `koin-qa`에 그대로 넘기고 `--output`만 --out으로 고정한다.
// - `koin-qa`는 --out 아래에 실행마다 새 폴더를 만든다. 이 실행이 만든 폴더의 report.json·report.md를
//   --out 바로 아래로 복사해 프로필의 artifacts가 고정 경로로 가리킬 수 있게 한다.
// - 종료 코드는 `koin-qa`의 것을 그대로 돌려준다(0 발견 없음, 1 발견·기준 미달, 2 설정·API·장치 오류나 미완료).
// - FIGMA_TOKEN·OPENAI_API_KEY는 실행하는 사람의 환경 변수로만 전달한다. 이 스크립트는 값을 읽거나 기록하지 않는다.
// 한계: 캡처·Figma 문서·AI 원문 전체는 실행 폴더에 남고 복사하지 않는다. 비공개 디자인과 개인정보가 들어 있다.
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const usage = 'Usage: design-qa.mjs --out RELATIVE_DIR [--koin-qa EXECUTABLE] -- <koin-qa arguments without --output>';

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

async function runFolders(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
}

async function main() {
  const { values, positionals } = parseArgs({
    options: { out: { type: 'string' }, 'koin-qa': { type: 'string', default: 'koin-qa' } },
    allowPositionals: true,
  });
  requireValue(values.out && positionals.length > 0, usage);
  requireValue(
    !positionals.some((argument) => argument === '--output' || argument.startsWith('--output=')),
    'Pass the output directory with --out, not --output',
  );
  const cwd = await realpath(process.cwd());
  const out = path.resolve(cwd, values.out);
  requireValue(
    !path.isAbsolute(values.out) && out.startsWith(cwd + path.sep),
    '--out must be a relative path inside the working directory',
  );
  await mkdir(out, { recursive: true });
  const before = await runFolders(out);

  const result = spawnSync(values['koin-qa'], [...positionals, '--output', out], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw new Error(`koin-qa could not be started: ${result.error.message}`);

  const created = [...(await runFolders(out))].filter((name) => !before.has(name));
  requireValue(created.length === 1, `Expected one new koin-qa run folder in --out, found ${created.length}`);
  for (const name of ['report.json', 'report.md']) {
    await copyFile(path.join(out, created[0], name), path.join(out, name));
  }
  console.error(`[design-qa] run folder: ${path.join(out, created[0])}`);
  return result.status ?? 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`[design-qa] ${error.message}`);
    process.exitCode = 2;
  },
);
