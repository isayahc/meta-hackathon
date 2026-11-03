// task-process CLI tests: offline build/show/correct/list against a temp
// project root. No network, no API key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addEvent } from './lib/events.js';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'task-process.js');

async function runCli(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...argv]);
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

const SCAN_PAYLOAD = {
  observed_task: 'Spread mulch under the north fence',
  stage: 'half the run is covered',
  per_frame: ['bare soil', 'wheelbarrow with mulch'],
  suggested_next_steps: ['Finish spreading the remaining run', 'Water the mulch in'],
  confidence: 'medium',
  unknowns: ['mulch depth unknown'],
  recorded_at: '2026-10-28T09:00:00Z',
  video_duration_s: 30,
};

test('build/show/list/correct round-trips a scan event to a corrected process', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'task-proc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const event = await addEvent(root, { title: 'Mulch scan', date: '2026-10-28', kind: 'scan', payload: SCAN_PAYLOAD, media: 'clip.mp4' });

  const built = await runCli(['build', '--root', root, '--event', event.id, '--id', 'proc-mulch']);
  assert.equal(built.code, 0, built.stderr);
  const buildOut = JSON.parse(built.stdout) as { ok: boolean; id: string; rev: number; steps: number };
  assert.equal(buildOut.ok, true);
  assert.equal(buildOut.rev, 1);
  assert.equal(buildOut.steps, 2);

  const shown = await runCli(['show', '--root', root, '--id', 'proc-mulch']);
  assert.equal(shown.code, 0, shown.stderr);
  const showOut = JSON.parse(shown.stdout) as { process: { title: string; provenance: { source_event_id: string }; steps: Array<{ claim: string; execution: string }> } };
  assert.equal(showOut.process.title, 'Spread mulch under the north fence');
  assert.equal(showOut.process.provenance.source_event_id, event.id);
  assert.ok(showOut.process.steps.every((s) => s.execution === 'not_started'));

  const listed = await runCli(['list', '--root', root]);
  assert.equal(listed.code, 0, listed.stderr);
  const listOut = JSON.parse(listed.stdout) as { processes: Array<{ process_id: string; rev: number }> };
  assert.deepEqual(listOut.processes.map((p) => [p.process_id, p.rev]), [['proc-mulch', 1]]);

  const patchFile = join(root, 'patch.json');
  await writeFile(patchFile, JSON.stringify({ steps: { 'proc-mulch-s0': { label: 'Finish by hand' } } }));
  const fixed = await runCli(['correct', '--root', root, '--id', 'proc-mulch', '--set', `@${patchFile}`, '--rationale', 'No barrow access.']);
  assert.equal(fixed.code, 0, fixed.stderr);
  const fixOut = JSON.parse(fixed.stdout) as { ok: boolean; rev: number; staleDocs: string[] };
  assert.equal(fixOut.ok, true);
  assert.equal(fixOut.rev, 2);
  assert.deepEqual(fixOut.staleDocs, []);

  const rev1 = await runCli(['show', '--root', root, '--id', 'proc-mulch', '--rev', '1']);
  assert.equal(rev1.code, 0, rev1.stderr);
  assert.equal((JSON.parse(rev1.stdout) as { process: { steps: Array<{ label: string }> } }).process.steps[0]?.label, 'Finish spreading the remaining run');
});

test('correct rejects a cycling patch and reports usage errors as JSON-safe failures', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'task-proc-err-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const event = await addEvent(root, { title: 'Scan', date: '2026-10-28', kind: 'scan', payload: { suggested_next_steps: ['A', 'B'] } });
  const built = await runCli(['build', '--root', root, '--event', event.id, '--id', 'p']);
  assert.equal(built.code, 0, built.stderr);

  const cycled = await runCli(['correct', '--root', root, '--id', 'p', '--set', JSON.stringify({ steps: { 'p-s0': { requires: ['p-s1'] }, 'p-s1': { requires: ['p-s0'] } } }), '--rationale', 'x']);
  assert.equal(cycled.code, 1);
  assert.match(cycled.stderr, /PROC_CYCLE/);

  const missing = await runCli(['show', '--root', root, '--id', 'nope']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /No process/);

  const noArgs = await runCli(['build', '--root', root]);
  assert.equal(noArgs.code, 1);
  assert.match(noArgs.stderr, /--event/);
});
