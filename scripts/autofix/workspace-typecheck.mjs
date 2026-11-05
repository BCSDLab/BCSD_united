import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const manifest = JSON.parse(await readFile('package.json', 'utf8'));
if (typeof manifest.scripts?.typecheck === 'string') {
  // Preserve each workspace's preparation/typecheck script, but never write its
  // incremental cache into the read-only source tree or another workspace's cache.
  const identity = createHash('sha256').update(process.cwd()).digest('hex');
  const cache = join(tmpdir(), `koin-typecheck-${identity}.tsbuildinfo`);
  const result = spawnSync('pnpm', ['run', 'typecheck', '--incremental', 'true', '--tsBuildInfoFile', cache], {
    stdio: 'inherit',
    timeout: 600_000,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
