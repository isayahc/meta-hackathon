/** Check the agent-facing command against actual persisted CLI scenarios. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { testCapabilities } from './lib/capabilities.js';
const execute = promisify(execFile);

test('headless process, improvement and mock-OI scenarios produce retained reports', async t => {
  const root = await mkdtemp(join(tmpdir(), 'capabilities-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const id of ['process', 'improvements', 'floorplan']) {
    const out = join(root, id);
    const report = await testCapabilities(id, out);
    assert.equal(report.status, 'passed', JSON.stringify(report));
    assert.equal(report.live_inference, false);
    assert.ok(report.results[0].checks.length > 0);
    assert.deepEqual(JSON.parse(await readFile(join(out, 'report.json'), 'utf8')), report);
  }
});

test('headless command lists capabilities, refuses existing directories, and returns blocked exit code', async t => {
  const root = await mkdtemp(join(tmpdir(), 'capabilities-errors-')); t.after(() => rm(root, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL('./task-capabilities.js', import.meta.url));
  const listed = await execute(process.execPath, [cli, 'list']);
  assert.equal(JSON.parse(listed.stdout).capabilities.length, 4);
  await writeFile(join(root, 'keep.txt'), 'keep');
  await assert.rejects(() => testCapabilities('process', root), /EEXIST/);
  assert.equal(await readFile(join(root, 'keep.txt'), 'utf8'), 'keep');
  await assert.rejects(() => testCapabilities('typo', join(root, 'unused')), /Unknown capability/);
  await assert.rejects(() => testCapabilities('process', 'relative'), /absolute/);
  try {
    await execute(process.execPath, [cli, 'test', 'walkthrough', '--out', join(root, 'blocked')], { env: { ...process.env, WALKTHROUGH_PYTHON: join(root, 'missing-python') } });
    assert.fail('Missing Python must not pass');
  } catch (error) {
    const e = error as { code: number; stdout: string };
    assert.equal(e.code, 2); const report = JSON.parse(e.stdout);
    assert.equal(report.status, 'blocked'); assert.equal(report.results[0].status, 'blocked');
    assert.equal(report.results[0].checks.length, 0);
  }
});
