import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { cloudDashboard } from './cloud-dashboard.mjs';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);

// 기존 TypeScript 로더로 실제 LAN 템플릿을 먼저 렌더한다.
// 구조 검사가 실패해도 완성되지 않은 HTML이 게시되지 않도록 임시 파일을 사용한다.
export async function buildViewer(output = resolve(app, '.wrangler/viewer/dashboard.html')) {
  const temporary = await mkdtemp(join(tmpdir(), 'attendance-cloud-'));
  const pending = output + '.pending';
  try {
    const lanOutput = join(temporary, 'dashboard.html');
    await execute(
      process.execPath,
      ['--import', 'tsx', resolve(app, 'lan/render-dashboard.mjs'), resolve(app, 'src/dashboard.ts'), lanOutput],
      { cwd: app },
    );
    const html = cloudDashboard(await readFile(lanOutput, 'utf8'));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(pending, html, { encoding: 'utf8', mode: 0o644 });
    await rename(pending, output);
    return output;
  } finally {
    await rm(temporary, { recursive: true, force: true });
    await rm(pending, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildViewer();
}
