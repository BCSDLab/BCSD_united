import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { offlineApiVars, prepareWebApi } from './local-api.mjs';

const configuration = await readFile(new URL('../../apps/api/wrangler.jsonc', import.meta.url), 'utf8');

test('offline runtime selects real legacy handlers independently of the API gate', () => {
  assert.deepEqual(offlineApiVars(configuration), { KOIN_DB_ENABLED: 'false', API_ENABLED: 'true' });
  assert.deepEqual(offlineApiVars(configuration, { gate: 'disabled' }), { KOIN_DB_ENABLED: 'false' });
  assert.deepEqual(offlineApiVars('{}'), { KOIN_DB_ENABLED: 'false', API_ENABLED: 'true' });
  assert.throws(() => offlineApiVars('{}', { gate: 'disabled' }), /no API_ENABLED gate/);
});

test('offline runtime rejects unfamiliar gateway configuration rather than reaching AWS', () => {
  for (const settings of [['true'], ['true', 'false', 'false'], ['TRUE', 'false'], [true, false], [null, 'false']]) {
    const candidate = settings.map((value) => `"KOIN_DB_ENABLED": ${JSON.stringify(value)}`).join(', ');
    assert.throws(() => offlineApiVars(`{${candidate}}`), /KOIN_DB_ENABLED configuration changed/);
  }
  assert.deepEqual(offlineApiVars('{"KOIN_DB_ENABLED": "false", "KOIN_DB_ENABLED": "false"}'), {
    KOIN_DB_ENABLED: 'false',
    API_ENABLED: 'true',
  });
});

test('web auxiliary copy uses the same offline vars without changing the deployment configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'autofix-api-test-'));
  const cwd = process.cwd();
  try {
    const api = join(directory, 'apps/api');
    await mkdir(api, { recursive: true });
    await writeFile(join(api, 'wrangler.jsonc'), configuration);
    process.chdir(directory);
    await prepareWebApi();
    const auxiliary = await readFile(join(api, '.wrangler/autofix-api/wrangler.jsonc'), 'utf8');
    const vars = offlineApiVars(configuration);
    for (const [name, value] of Object.entries(vars)) {
      assert.equal([...auxiliary.matchAll(new RegExp(`"${name}": "${value}"`, 'g'))].length, 2);
    }
    assert.doesNotMatch(auxiliary, /"KOIN_DB_ENABLED": "true"|"API_ENABLED": "false"/);
    assert.equal(await readFile(join(api, 'wrangler.jsonc'), 'utf8'), configuration);
  } finally {
    process.chdir(cwd);
    await rm(directory, { recursive: true, force: true });
  }
});
