import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateTask } from './model.mjs';
import { buildSuite, INVENTORY, validateInventory } from './web-suite.mjs';

const SHA = 'a'.repeat(40);
const SCREENS = [
  { id: 'home', route: 'index.tsx', path: '/', access: 'public' },
  { id: 'store-detail', route: 'store.$id.index.tsx', path: '/store/7', access: 'public' },
  { id: 'not-found', route: '404.index.tsx', path: '/404', access: 'public', expect: 'not-found' },
  { id: 'team-profile', route: 'team.profile.index.tsx', path: '/team/profile', access: 'login' },
  { id: 'order-home', route: 'order.index.tsx', path: '/order', access: 'disabled', reason: 'order is off' },
];
const suite = (overrides = {}) =>
  buildSuite({
    screens: SCREENS,
    sha: SHA,
    checkout: '/work/BCSD_united',
    reviewer: 'web-reviewer',
    script: '/harness/web-scenario.mjs',
    ...overrides,
  });

test('the generated task is valid and has one scenario per public screen only', () => {
  const { task } = suite();
  assert.equal(validateTask(task), task);
  assert.deepEqual(
    task.scenarios.map(({ id }) => id),
    ['home', 'store-detail', 'not-found'],
  );
  assert.deepEqual(task.targets, {
    web: { repository: 'BCSDLab/BCSD_united', baseSha: SHA, reviewer: 'web-reviewer' },
  });
});

test('the profile builds, sweeps every screen once, and attributes the result per public screen', () => {
  const { profile } = suite();
  assert.deepEqual(
    profile.steps.map(({ id, kind }) => [id, kind]),
    [
      ['typecheck', 'build'],
      ['screens-sweep', 'build'],
      ['home', 'scenario'],
      ['store-detail', 'scenario'],
      ['not-found', 'scenario'],
    ],
  );
  assert.deepEqual(profile.steps[0].command, ['corepack', 'pnpm', '--filter', '@koin/web', 'typecheck']);
  const sweep = profile.steps[1].command;
  assert.deepEqual(sweep.slice(0, 2), ['node', '/harness/web-scenario.mjs']);
  assert.equal(sweep[sweep.indexOf('--scenario') + 1], 'screens');
  assert.ok(sweep.includes('--all'));
  for (const id of ['home', 'store-detail', 'not-found']) {
    const steps = profile.steps.filter((step) => step.scenarioId === id);
    assert.equal(steps.length, 1);
    const { command } = steps[0];
    assert.equal(command[command.indexOf('--scenario') + 1], `result:${id}`);
    assert.equal(command[command.indexOf('--checkout') + 1], '/work/BCSD_united');
    assert.equal(command[command.indexOf('--out') + 1], sweep[sweep.indexOf('--out') + 1]);
  }
  const out = sweep[sweep.indexOf('--out') + 1];
  assert.deepEqual(profile.artifacts, [
    `${out}/result.json`,
    ...['home', 'store-detail', 'not-found'].flatMap((id) => [`${out}/${id}-desktop.png`, `${out}/${id}-mobile.png`]),
  ]);
  assert.ok(!JSON.stringify(profile).includes('team-profile') && !JSON.stringify(profile).includes('order-home'));
});

test('--node pins the node binary and runs pnpm through its bundled corepack', () => {
  const { profile } = suite({ node: '/opt/node/node' });
  assert.equal(profile.steps[0].command[0], '/opt/node/node');
  assert.match(profile.steps[0].command[1], /node_modules[\\/]corepack[\\/]dist[\\/]corepack\.js$/);
  assert.deepEqual(profile.steps[0].command.slice(2), ['pnpm', '--filter', '@koin/web', 'typecheck']);
  assert.ok(profile.steps.slice(1).every(({ command }) => command[0] === '/opt/node/node'));
});

test('inventories with bad ids, duplicate ids, placeholder paths, or unexplained disabled screens are refused', () => {
  const screen = SCREENS[0];
  assert.throws(() => validateInventory({ screens: [] }), /at least one screen/);
  assert.throws(() => validateInventory({ screens: [{ ...screen, id: 'Home' }] }), /kebab-case/);
  assert.throws(() => validateInventory({ screens: [screen, screen] }), /Duplicate screen id/);
  assert.throws(() => validateInventory({ screens: [{ ...screen, path: '/store/$id' }] }), /concrete URL path/);
  assert.throws(() => validateInventory({ screens: [{ ...screen, route: undefined }] }), /route file/);
  assert.throws(() => validateInventory({ screens: [{ ...screen, access: 'private' }] }), /unknown access/);
  assert.throws(() => validateInventory({ screens: [{ ...screen, access: 'disabled' }] }), /state its reason/);
  assert.throws(() => validateInventory({ screens: [{ ...screen, expect: 'error' }] }), /unknown expect/);
  assert.throws(() => suite({ screens: SCREENS.slice(3) }), /no target screen/);
});

test('the bundled inventory is valid and names each route file once', async () => {
  const screens = validateInventory(JSON.parse(await readFile(INVENTORY, 'utf8')));
  const routes = screens.map(({ route }) => route);
  assert.equal(new Set(routes).size, routes.length);
  assert.equal(
    validateTask(suite({ screens }).task).scenarios.length,
    screens.filter(({ access }) => access === 'public' || access === 'authenticated').length,
  );
});

test('authenticated mobile targets retain a mandatory scenario and separate desktop guard evidence', async () => {
  const screens = validateInventory(JSON.parse(await readFile(INVENTORY, 'utf8')));
  const callvan = screens.find((screen) => screen.id === 'callvan-postid-report-userid');
  assert.equal(callvan.access, 'authenticated');
  assert.equal(callvan.desktopGuard, '/');
  assert.equal(callvan.path, '/callvan/:postId/report/:userId');
  const { task, profile } = suite({ screens: [callvan] });
  assert.equal(task.scenarios[0].id, callvan.id);
  assert.equal(profile.artifacts.filter((file) => file.endsWith('.png')).length, 2);
  assert.throws(() => validateInventory({ screens: [{ ...callvan, targetText: undefined }] }), /rendered target/);
  assert.throws(() => validateInventory({ screens: [{ ...callvan, path: '/callvan/:guess' }] }), /concrete URL path/);
});
