import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('dashboard entry point executes on the current platform without opening a port', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./serve-dashboard.js', import.meta.url))], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: node dist\/serve-dashboard.js/);
});
