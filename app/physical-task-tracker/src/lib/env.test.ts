// .env loader tests. No network, no API key.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv, loadEnvFile } from './env.js';

test('parseEnv reads values, skips comments and junk', () => {
  const parsed = parseEnv(
    '# comment\n' +
      'META_API_KEY=abc123\n' +
      'QUOTED="hello world"\n' +
      "SINGLE='it works'\n" +
      'export EXPORTED=yes\n' +
      'TRAILING=no # kept?\n' +
      'not-a-line\n' +
      '9BAD=no\n'
  );
  assert.equal(parsed.META_API_KEY, 'abc123');
  assert.equal(parsed.QUOTED, 'hello world');
  assert.equal(parsed.SINGLE, 'it works');
  assert.equal(parsed.EXPORTED, 'yes');
  assert.equal(parsed.TRAILING, 'no');
  assert.ok(!('9BAD' in parsed));
});

test('loadEnvFile never overrides real environment', async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), 'env-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, '.env');
  await writeFile(file, 'ENV_TEST_A=file-value\nENV_TEST_B=file-value\n');
  process.env.ENV_TEST_B = 'real-value';
  t.after(() => {
    delete process.env.ENV_TEST_A;
    delete process.env.ENV_TEST_B;
  });
  const set = loadEnvFile(file);
  assert.deepEqual(set, ['ENV_TEST_A']);
  assert.equal(process.env.ENV_TEST_A, 'file-value');
  assert.equal(process.env.ENV_TEST_B, 'real-value');
});

test('loadEnvFile on a missing file is a no-op', () => {
  assert.deepEqual(loadEnvFile(join(tmpdir(), 'definitely-not-a-real-env-12345')), []);
});
