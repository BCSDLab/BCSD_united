import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { proveRequestRegression, REQUEST_CHECKS, requestRegressionPath } from './common.mjs';

// 실제 신뢰 이미지와 Docker가 필요하며 이미지가 없으면 증거를 생략하지 않고 실패한다.
test(
  'request regression proves native assertion failure on base before source changes',
  { timeout: 180_000 },
  async () => {
    const image = spawnSync('docker', ['image', 'inspect', 'koin-error-verifier'], { encoding: 'utf8' });
    assert.equal(
      image.status,
      0,
      `Build the trusted scripts/autofix/Dockerfile image as koin-error-verifier first: ${image.stderr}`,
    );
    assert.equal(REQUEST_CHECKS[1], 'request-regression-fails-on-base');
    const root = await mkdtemp(resolve(tmpdir(), 'request-regression-'));
    try {
      await chmod(root, 0o755);
      await mkdir(resolve(root, 'apps/api/scripts'), { recursive: true });
      await mkdir(resolve(root, 'apps/api/src'), { recursive: true });
      await writeFile(resolve(root, 'package.json'), JSON.stringify({ private: true }));
      await writeFile(resolve(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
      await writeFile(
        resolve(root, 'apps/api/package.json'),
        JSON.stringify({
          name: '@koin/api',
          private: true,
          type: 'module',
          scripts: { test: 'node --test scripts/*.test.mjs' },
        }),
      );
      const source = resolve(root, 'apps/api/src/consumer.js');
      const regression = resolve(root, 'apps/api/scripts/consumer.test.mjs');
      assert.ok(requestRegressionPath('apps/api/scripts/consumer.test.mjs'));
      const native = () =>
        spawnSync(
          'docker',
          [
            'run',
            '--rm',
            '--network=none',
            '--read-only',
            '--cap-drop=ALL',
            '--security-opt=no-new-privileges',
            '--pids-limit=128',
            '--memory=512m',
            '--cpus=1',
            '--user',
            '1000:1000',
            '--tmpfs',
            '/tmp:rw,nosuid,nodev,size=64m',
            '-e',
            'HOME=/tmp',
            '-e',
            'CI=true',
            '-v',
            `${root}:/work:ro`,
            '-w',
            '/work',
            'koin-error-verifier',
            'pnpm',
            '-r',
            '--workspace-concurrency=1',
            '--filter',
            '@koin/api...',
            '--if-present',
            'test',
          ],
          { encoding: 'utf8', timeout: 30_000, maxBuffer: 1_000_000 },
        );
      const pinnedTest =
        "import assert from 'node:assert/strict';\nimport { consume } from '../src/consumer.js';\nassert.equal(typeof consume, 'function');\n";
      for (const [name, candidate, expected] of [
        ['passing bypass', `${pinnedTest}assert.equal(1, 1);\n`, /must fail with an assertion/],
        ['loader failure', "import '../src/missing.js';\n", /must fail with an assertion/],
        // Vitest 계열은 Node 오류 코드 없이 AssertionError로 실패를 보고한다.
        [
          'native harness AssertionError',
          `${pinnedTest}try { assert.equal(consume('request'), 'REQUEST'); } catch (error) { delete error.code; throw error; }\n`,
          null,
        ],
        ['meaningful consumer assertion', `${pinnedTest}assert.equal(consume('request'), 'REQUEST');\n`, null],
      ]) {
        await writeFile(source, 'export const consume = (value) => value;\n');
        await writeFile(regression, pinnedTest);
        let sourceApplied = false;
        const proof = proveRequestRegression({
          runNativeTests: native,
          applyRegression: () => writeFile(regression, candidate),
          applySource: async () => {
            sourceApplied = true;
            await writeFile(source, 'export const consume = (value) => value.toUpperCase();\n');
          },
        });
        if (expected) {
          await assert.rejects(proof, expected, name);
          assert.equal(sourceApplied, false, name);
        } else {
          await proof;
          assert.equal(sourceApplied, true, name);
          const after = native();
          assert.equal(after.status, 0, `${name}: ${after.stdout}${after.stderr}`);
        }
      }
      await writeFile(regression, "import assert from 'node:assert/strict'; assert.fail('broken pinned fixture');\n");
      await assert.rejects(
        proveRequestRegression({
          runNativeTests: native,
          applyRegression: () => assert.fail('must check pinned fixtures first'),
          applySource: () => assert.fail('must not apply source on broken baseline'),
        }),
        /Untouched base native fixture tests failed/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
