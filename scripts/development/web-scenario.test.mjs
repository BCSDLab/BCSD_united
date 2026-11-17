import assert from 'node:assert/strict';
import test from 'node:test';
import { publicFailures } from './web-scenario.mjs';

test('a healthy home redirect cannot stand in for the requested screen', () => {
  const visit = {
    state: { ready: true, hydrated: true, url: 'http://localhost:3000/' },
    record: { documentStatus: 200, exceptions: [], consoleErrors: [], failedRequests: [] },
  };
  assert.deepEqual(publicFailures({ path: '/profile' }, 'http://localhost:3000', visit), [
    'requested screen redirected to home; target screen was not verified',
  ]);
  assert.deepEqual(publicFailures({ path: '/' }, 'http://localhost:3000', visit), []);
});
