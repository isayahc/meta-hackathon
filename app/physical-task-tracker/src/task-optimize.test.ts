// task-optimize process tests: the optimizer request carries corrected
// process content, and mid-generation corrections save stale, never
// current. A localhost stub answers the model call: no network, no key.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addGoal } from './lib/goals.js';
import { getDoc } from './lib/db.js';
import { applyCorrection, buildProcessFromScan, saveRevision } from './lib/processes.js';

const CLI = fileURLToPath(new URL('./task-optimize.js', import.meta.url));

interface Captured {
  url: string;
  body: string;
}

async function startStub(t: TestContext, delayMs = 0): Promise<{ port: number; captured: Captured[] }> {
  const captured: Captured[] = [];
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      captured.push({ url: req.url ?? '', body });
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: '{"ranked_actions":[],"deferred":[],"goal_effects":[]}' }, finish_reason: 'stop' }],
          usage: {},
        }));
      }, delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { port: (server.address() as AddressInfo).port, captured };
}

function runCli(root: string, port: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, root],
      { cwd: root, env: { ...process.env, META_API_BASE: `http://127.0.0.1:${port}`, META_API_KEY: 'test-key' } },
      (err, stdout, stderr) => resolve({ code: err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) })
    );
  });
}

async function seedProcess(root: string): Promise<void> {
  await addGoal(root, { text: 'Mulch the north fence' });
  await saveRevision(root, buildProcessFromScan({ id: 'p', analysis: { suggested_next_steps: ['Spread the run'] } }));
  await applyCorrection(root, 'p', { steps: { 'p-s0': { label: 'CORRECTED spread the run by hand' } } }, 'No barrow access.');
}

test('optimizer request contains the corrected process at its exact revision', async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), 'task-opt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedProcess(root);
  const { port, captured } = await startStub(t);
  const r = await runCli(root, port);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(captured.length, 1);
  assert.match(captured[0]?.url ?? '', /\/chat\/completions$/);
  assert.match(captured[0]?.body ?? '', /CORRECTED spread the run by hand/);
  assert.match(captured[0]?.body ?? '', /\(rev 2\)/);
  const plan = getDoc(root, 'plan') as { process_basis: Array<{ process_id: string; rev: number }>; stale: boolean };
  assert.deepEqual(plan.process_basis, [{ process_id: 'p', rev: 2 }]);
  assert.equal(plan.stale, false);
});

test('a correction landing mid-generation saves stale, never current', async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), 'task-opt-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedProcess(root);
  const { port, captured } = await startStub(t, 1500);
  const pending = runCli(root, port);
  // Wait until the request is in flight, then correct before it answers.
  for (let i = 0; i < 100 && !captured.length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(captured.length, 1);
  await applyCorrection(root, 'p', { title: 'Mid-flight retitle' }, 'Changed while generating.');
  const r = await pending;
  assert.equal(r.code, 0, r.stderr);
  const plan = getDoc(root, 'plan') as { process_basis: Array<{ process_id: string; rev: number }>; stale: boolean; stale_reason: string };
  assert.deepEqual(plan.process_basis, [{ process_id: 'p', rev: 2 }]);
  assert.equal(plan.stale, true);
  assert.match(plan.stale_reason, /changed during generation/);
});
