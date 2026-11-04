// Exercise the optimizer CLI with a fetch stub: no sockets or API calls.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { addGoal } from './lib/goals.js';
import { getDoc } from './lib/records.js';
import { applyCorrection, buildProcessFromScan, readProcess, saveRevision } from './lib/processes.js';

const CLI = fileURLToPath(new URL('./task-optimize.js', import.meta.url));

/** Run the real CLI with a deterministic, entirely offline model response. */
async function runCli(root: string, correctDuringRequest = false): Promise<{
  code: number; stdout: string; stderr: string; captured: { url: string; body: string };
}> {
  const stub = join(root, 'fetch-stub.mjs');
  const capture = join(root, 'request.json');
  await writeFile(stub, `
    import { writeFile } from 'node:fs/promises';
    import { applyCorrection } from ${JSON.stringify(new URL('./lib/processes.js', import.meta.url).href)};
    globalThis.fetch = async (url, init) => {
      await writeFile(${JSON.stringify(capture)}, JSON.stringify({ url: String(url), body: init.body }));
      ${correctDuringRequest ? `await applyCorrection(${JSON.stringify(root)}, 'p', { title: 'Mid-flight retitle' }, 'Changed while generating.');` : ''}
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"ranked_actions":[],"deferred":[],"goal_effects":[]}' }, finish_reason: 'stop' }],
        usage: {},
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
  `);
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, ['--import', pathToFileURL(stub).href, CLI, root], {
      cwd: root,
      env: { ...process.env, META_API_BASE: 'https://optimizer.invalid', META_API_KEY: 'test-key' },
    }, (err, stdout, stderr) => resolve({ code: err ? 1 : 0, stdout: String(stdout), stderr: String(stderr) }));
  });
  assert.equal(result.code, 0, result.stderr);
  return { ...result, captured: JSON.parse(await readFile(capture, 'utf8')) as { url: string; body: string } };
}

/** Seed an original process and a farmer revision with operational corrections. */
async function seedProcess(root: string): Promise<void> {
  await addGoal(root, { text: 'Mulch the north fence' });
  await saveRevision(root, buildProcessFromScan({ id: 'p', analysis: { suggested_next_steps: ['Spread the run'] } }));
  await applyCorrection(root, 'p', { steps: { 'p-s0': {
    label: 'CORRECTED spread the run by hand',
    inputs: ['uncovered north run'], outputs: ['covered north run'],
    tools: ['hand rake'], materials: ['aged wood chips'], actors: ['two workers'],
    preconditions: ['Wait until the soil is dry'],
    completion_criteria: ['Mulch is 5 cm deep'],
    repeat: { until: 'the whole run is covered' }, location: 'north fence',
    unknowns: ['remaining mulch volume'],
  } } }, 'No barrow access.');
}

test('optimizer request contains the complete corrected process at its exact revision', async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), 'task-opt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedProcess(root);
  const { captured } = await runCli(root);
  assert.match(captured.url, /\/chat\/completions$/);
  const request = JSON.parse(captured.body) as { messages: Array<{ content: Array<{ type: string; text?: string }> }> };
  const prompt = request.messages.flatMap((m) => m.content.map((part) => part.text ?? '')).join('\n');
  assert.ok(prompt.includes(JSON.stringify(await readProcess(root, 'p'))));
  assert.match(prompt, /CORRECTED spread the run by hand/);
  assert.match(prompt, /\(rev 2\)/);
  assert.match(prompt, /\[p-s0\].*requires=unknown/);
  const plan = (await getDoc(root, 'plan')) as { process_basis: Array<{ process_id: string; rev: number }>; stale: boolean };
  assert.deepEqual(plan.process_basis, [{ process_id: 'p', rev: 2 }]);
  assert.equal(plan.stale, false);
});

test('a correction landing mid-generation saves stale, never current', async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), 'task-opt-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await seedProcess(root);
  await runCli(root, true);
  const plan = (await getDoc(root, 'plan')) as { process_basis: Array<{ process_id: string; rev: number }>; stale: boolean; stale_reason: string };
  assert.deepEqual(plan.process_basis, [{ process_id: 'p', rev: 2 }]);
  assert.equal(plan.stale, true);
  assert.match(plan.stale_reason, /changed during generation/);
});

