#!/usr/bin/env node
// 기존 SSH 자격으로 API만 localhost에 연결한다. 키·SSH 설정·WARP를 설치하거나 변경하지 않는다.
import { execFile, spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { parseArgs, promisify } from 'node:util';

const execute = promisify(execFile);
const ssh =
  process.platform === 'win32'
    ? path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'OpenSSH', 'ssh.exe')
    : 'ssh';
const { values } = parseArgs({
  options: {
    server: { type: 'string', default: 'rocky-desktop' },
    mac: { type: 'string', default: 'butler' },
    'local-port': { type: 'string', default: '18480' },
    'mac-port': { type: 'string', default: '18480' },
    'api-port': { type: 'string', default: '18080' },
    check: { type: 'boolean', default: false },
  },
});
const children = [];
const options = [
  '-NT',
  '-v',
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=yes',
  '-o',
  'ForwardAgent=no',
  '-o',
  'ExitOnForwardFailure=yes',
  '-o',
  'ServerAliveInterval=20',
  '-o',
  'ServerAliveCountMax=3',
  '-S',
  'none',
];

function port(value) {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) throw new Error(`Invalid TCP port: ${value}`);
  return Number(value);
}

async function ensureFree(localPort) {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(localPort, '127.0.0.1', resolve);
  });
  await new Promise((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
}

function start(args, ready) {
  const child = spawn(ssh, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  children.push(child);
  return new Promise((resolve, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(new Error(`SSH forwarding did not become ready: ${log}`)), 20000);
    const done = (error) => {
      clearTimeout(timer);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error) => done(error);
    const onExit = (code) => done(new Error(`SSH exited ${code}: ${log}`));
    child.once('error', onError);
    child.once('exit', onExit);
    child.stderr.on('data', (data) => {
      log = (log + data.toString()).slice(-8000);
      if (ready.test(log)) done();
    });
  });
}

async function stop() {
  for (const child of [...children].reverse()) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
  }
}

try {
  for (const target of [values.server, values.mac]) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.@-]*$/.test(target)) throw new Error('Use a configured SSH alias or user@host');
  }
  const localPort = port(values['local-port']);
  const macPort = port(values['mac-port']);
  const apiPort = port(values['api-port']);
  await ensureFree(localPort);
  await start(
    [...options, '-L', `127.0.0.1:${localPort}:127.0.0.1:${apiPort}`, values.server],
    new RegExp(`Local forwarding listening on 127\\.0\\.0\\.1 port ${localPort}\\b`),
  );
  await start([...options, '-R', `127.0.0.1:${macPort}:127.0.0.1:${localPort}`, values.mac], /remote forward success/);
  // iOS ATS의 IP 직접 연결 제한을 피한다. 앱의 보안 설정은 바꾸지 않는다.
  const url = `http://localhost:${macPort}`;
  const { stdout } = await execute(
    ssh,
    [
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'ForwardAgent=no',
      values.mac,
      'curl',
      '--fail',
      '--silent',
      '--show-error',
      '--max-time',
      '10',
      `${url}/actuator/health`,
    ],
    { timeout: 20000, windowsHide: true },
  );
  if (JSON.parse(stdout).status !== 'UP') throw new Error('Mac endpoint did not return healthy API status');
  console.log(`Mac API ready: ${url} (session-only; no keys copied)`);
  if (!values.check) {
    console.log('Keep this terminal open; Ctrl-C closes both SSH connections.');
    await new Promise((resolve, reject) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
      for (const child of children) child.once('exit', (code) => reject(new Error(`SSH bridge closed: ${code}`)));
    });
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await stop();
}
