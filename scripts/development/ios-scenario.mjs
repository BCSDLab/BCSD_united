#!/usr/bin/env node
// macOS 실행 호스트 전용: KOIN_iOS를 Simulator용으로 빌드하거나, 빌드된 앱에서 Maestro 흐름을 실행한다.
// 비밀 파일(Koin/Core/Configuration/Debug.xcconfig, GoogleService-Info-Stage.plist)은 운영자가 체크아웃에
// 미리 둔다. 두 파일과 build/는 KOIN_iOS .gitignore 대상이라 하니스의 깨끗한 체크아웃 조건을 깨지 않는다.
// 산출물은 모두 build/harness/ 아래에 쓴다. 코드 서명·스토어 자격은 사용하지 않는다.
import { spawn } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { readIosDeviceCatalog, resolveIosDevice } from './ios-devices.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    checkout: { type: 'string' },
    flow: { type: 'string' },
    out: { type: 'string' },
    device: { type: 'string', default: 'iPhone 17 Pro' },
    display: { type: 'string', default: 'primary' },
    scheme: { type: 'string', default: 'koin-stage' },
    bundle: { type: 'string', default: 'com.bcsdlab.koin.stage' },
  },
});
const mode = positionals[0];
const DERIVED = 'build/harness/DerivedData';
const PACKAGES = 'build/harness/SourcePackages';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function run(program, args, options = {}) {
  return new Promise((done, reject) => {
    const child = spawn(program, args, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code) => done(code ?? 1));
  });
}

if (process.platform !== 'darwin') fail('iOS Simulator 실행은 macOS 호스트에서만 가능하다');
if (!['build', 'scenario'].includes(mode) || !values.checkout) {
  fail('usage: ios-scenario.mjs build --checkout DIR | scenario --checkout DIR --flow FILE --out build/harness/<name>');
}
const checkout = resolve(values.checkout);
const device = resolveIosDevice(await readIosDeviceCatalog(), values.device);

if (mode === 'build') {
  const code = await run(
    'xcodebuild',
    [
      'build',
      '-project',
      'koin.xcodeproj',
      '-scheme',
      values.scheme,
      '-configuration',
      'Debug',
      '-destination',
      `platform=iOS Simulator,id=${device.udid}`,
      '-derivedDataPath',
      DERIVED,
      '-clonedSourcePackagesDirPath',
      PACKAGES,
      'CODE_SIGNING_ALLOWED=NO',
    ],
    { cwd: checkout },
  );
  process.exit(code);
}

if (!values.flow || !values.out) fail('scenario에는 --flow와 --out이 필요하다');
if (isAbsolute(values.out) || values.out.split(/[\\/]/).includes('..') || !values.out.startsWith('build/harness/')) {
  fail('--out은 build/harness/ 아래의 상대 경로여야 한다');
}
const out = resolve(checkout, values.out);
if (!out.startsWith(`${checkout}${sep}`)) fail('--out이 체크아웃을 벗어난다');
await mkdir(out, { recursive: true });

const products = join(checkout, DERIVED, 'Build', 'Products', 'Debug-iphonesimulator');
const app = (await readdir(products).catch(() => [])).find((name) => name.endsWith('.app'));
if (!app) fail('빌드된 Simulator 앱이 없다. 먼저 build를 실행한다');

// 이미 부팅된 기기는 boot가 실패하므로 종료 코드를 보지 않고 bootstatus로 준비를 확인한다.
await run('xcrun', ['simctl', 'boot', device.udid]);
if ((await run('xcrun', ['simctl', 'bootstatus', device.udid, '-b'])) !== 0) fail('Simulator 부팅에 실패했다');
if ((await run('xcrun', ['simctl', 'install', device.udid, join(products, app)])) !== 0) fail('앱 설치에 실패했다');

const recorder = spawn(
  'xcrun',
  ['simctl', 'io', device.udid, 'recordVideo', `--display=${values.display}`, '--force', join(out, 'recording.mp4')],
  {
    stdio: 'ignore',
  },
);
let code = 1;
try {
  code = await run(
    'maestro',
    [
      '--device',
      device.udid,
      'test',
      resolve(values.flow),
      '--format',
      'junit',
      '--output',
      join(out, 'junit.xml'),
      '--test-output-dir',
      out,
    ],
    { cwd: checkout, env: { ...process.env, MAESTRO_APP_ID: values.bundle } },
  );
} finally {
  // recordVideo는 SIGINT를 받아야 파일을 마무리한다.
  recorder.kill('SIGINT');
  await new Promise((done) => recorder.on('exit', done));
  await run('xcrun', ['simctl', 'terminate', device.udid, values.bundle]);
}
process.exit(code);
