#!/usr/bin/env node
// 웹 화면 목록(screens/web.json) 전체를 하니스 작업 파일과 프로필로 만든다.
// - access가 public인 화면마다 시나리오 하나를 만든다. login·disabled 화면은 시나리오로 넣지 않는다.
// - 프로필은 개발 서버를 한 번만 띄우는 순회 단계 하나와, 그 결과(result.json)에서 화면별 통과 여부만 읽는 단계들로 이뤄진다.
// - 읽기 전용이다. 화면을 실행하지 않는다. 통과 여부는 하니스 실행이 판정한다.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export const INVENTORY = fileURLToPath(new URL('./screens/web.json', import.meta.url));
const REPOSITORY = 'BCSDLab/BCSD_united';
const ACCESS = ['public', 'login', 'disabled'];
const OUT = 'apps/web/.wrangler/harness/screens';
const usage =
  'Usage: web-suite.mjs --sha FULL_SHA --checkout ABSOLUTE_DIR --reviewer NAME --work DIR [--node ABSOLUTE_NODE]';

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

/** 화면 목록의 형식을 확인하고 화면 배열을 돌려준다. id는 겹치면 안 되고, path는 실제로 열 수 있는 구체 경로여야 한다. */
export function validateInventory(inventory) {
  const screens = inventory?.screens;
  requireValue(Array.isArray(screens) && screens.length > 0, 'Inventory must list at least one screen');
  const ids = new Set();
  for (const screen of screens) {
    requireValue(
      typeof screen?.id === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(screen.id),
      `Screen id must be kebab-case: ${JSON.stringify(screen?.id)}`,
    );
    requireValue(!ids.has(screen.id), `Duplicate screen id: ${screen.id}`);
    ids.add(screen.id);
    requireValue(
      typeof screen.route === 'string' && /^[A-Za-z0-9_.$-]+\.tsx$/.test(screen.route),
      `Screen ${screen.id} must name its route file`,
    );
    requireValue(
      typeof screen.path === 'string' && /^\/[^\s$:*]*$/.test(screen.path),
      `Screen ${screen.id} must have a concrete URL path`,
    );
    requireValue(ACCESS.includes(screen.access), `Screen ${screen.id} has an unknown access: ${screen.access}`);
    requireValue(
      screen.access !== 'disabled' || (typeof screen.reason === 'string' && screen.reason.length > 0),
      `Disabled screen ${screen.id} must state its reason`,
    );
    requireValue(
      screen.expect === undefined || (screen.expect === 'not-found' && screen.access === 'public'),
      `Screen ${screen.id} has an unknown expect: ${screen.expect}`,
    );
  }
  return screens;
}

export function buildSuite({ screens, sha, checkout, reviewer, node, script }) {
  const publicScreens = validateInventory({ screens }).filter(({ access }) => access === 'public');
  requireValue(publicScreens.length > 0, 'Inventory has no public screen');
  const scenario = (name, extra = []) => [
    node ?? 'node',
    script,
    '--checkout',
    checkout,
    '--scenario',
    name,
    ...extra,
    '--out',
    OUT,
  ];
  const pnpm = node
    ? [node, path.join(path.dirname(node), 'node_modules', 'corepack', 'dist', 'corepack.js')]
    : ['corepack'];
  return {
    task: {
      schemaVersion: 1,
      id: `web-screens-${sha.slice(0, 7)}`,
      kind: 'feature',
      goal: `BCSD_united ${sha.slice(0, 7)} 웹 앱의 공개 화면 전체가 데스크톱과 모바일에서 렌더링되는지 실행 증거로 확인한다`,
      scenarios: publicScreens.map((screen) => ({
        id: screen.id,
        expected:
          screen.expect === 'not-found'
            ? `${screen.path} 화면이 데스크톱(1440x900)과 모바일(390x844)에서 오류 없이 안내 화면(NotFound)을 표시한다`
            : `${screen.path} 화면이 데스크톱(1440x900)과 모바일(390x844)에서 오류 없이 렌더링된다`,
      })),
      targets: { web: { repository: REPOSITORY, baseSha: sha, reviewer } },
      dependencies: [],
      feature: {
        acceptance:
          '모든 공개 화면이 두 뷰포트에서 문서 오류·NotFound·오류 경계·콘솔 오류·API 5xx 없이 열리고 화면별 캡처와 결과가 남는다',
      },
    },
    profile: {
      checkout,
      repository: REPOSITORY,
      timeoutMs: 3_600_000,
      steps: [
        { id: 'typecheck', kind: 'build', command: [...pnpm, 'pnpm', '--filter', '@koin/web', 'typecheck'] },
        // 순회는 특정 시나리오에 속하지 않으므로 build 단계로 둔다. 실패한 화면이 있으면 이 단계도 실패한다.
        { id: 'screens-sweep', kind: 'build', command: scenario('screens', ['--all']) },
        ...publicScreens.map((screen) => ({
          id: screen.id,
          kind: 'scenario',
          scenarioId: screen.id,
          command: scenario(`result:${screen.id}`),
        })),
      ],
      artifacts: [
        `${OUT}/result.json`,
        ...publicScreens.flatMap(({ id }) => [`${OUT}/${id}-desktop.png`, `${OUT}/${id}-mobile.png`]),
      ],
    },
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      sha: { type: 'string' },
      checkout: { type: 'string' },
      reviewer: { type: 'string' },
      work: { type: 'string' },
      node: { type: 'string' },
    },
  });
  requireValue(values.sha && values.checkout && values.reviewer && values.work, usage);
  requireValue(/^[a-f0-9]{40}$/.test(values.sha), '--sha must be a full lowercase commit hash');
  requireValue(path.isAbsolute(values.checkout), '--checkout must be an absolute path');
  requireValue(values.node === undefined || path.isAbsolute(values.node), '--node must be an absolute path');
  const suite = buildSuite({
    screens: JSON.parse(await readFile(INVENTORY, 'utf8')).screens,
    sha: values.sha,
    checkout: values.checkout,
    reviewer: values.reviewer,
    node: values.node,
    script: fileURLToPath(new URL('./web-scenario.mjs', import.meta.url)),
  });
  await mkdir(values.work, { recursive: true });
  await writeFile(path.join(values.work, 'web.task.json'), `${JSON.stringify(suite.task, null, 2)}\n`);
  await writeFile(path.join(values.work, 'web.profile.json'), `${JSON.stringify(suite.profile, null, 2)}\n`);
  console.log(`${suite.task.scenarios.length} screens: ${suite.task.scenarios.map(({ id }) => id).join(', ')}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
