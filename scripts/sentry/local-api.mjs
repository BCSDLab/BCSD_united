import { spawn, spawnSync } from 'node:child_process';

export function stopProcess(child) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
}

export async function startLocalApi() {
  const migration = spawnSync('pnpm', ['--filter', '@koin/api', 'db:migrate:local'], {
    encoding: 'utf8', timeout: 180000, maxBuffer: 4_000_000,
  });
  if (migration.error || migration.status !== 0) {
    process.stderr.write((migration.stdout ?? '').slice(-8000) + (migration.stderr ?? '').slice(-8000));
    throw new Error('Local-only API database migration failed');
  }
  const child = spawn('pnpm', ['--filter', '@koin/api', 'dev', '--local', '--ip', '127.0.0.1', '--port', '4174'], {
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let log = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { log = (log + chunk.toString()).slice(-16000); });
  try {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (child.exitCode !== null) throw new Error('Local API Worker exited during startup');
      try {
        const response = await fetch('http://127.0.0.1:4174/health', { signal: AbortSignal.timeout(1000), redirect: 'error' });
        if (response.ok) return { child, assertHealthy: () => { if (/\[ERROR\]|uncaught|unhandled rejection/i.test(log)) throw new Error('Local API emitted runtime errors'); } };
      } catch {}
      await new Promise((done) => setTimeout(done, 500));
    }
    throw new Error('Local API /health did not become ready');
  } catch (error) {
    stopProcess(child);
    process.stderr.write(log);
    throw error;
  }
}
