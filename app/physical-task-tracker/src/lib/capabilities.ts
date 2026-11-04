/** Headless capability scenarios using the same persisted services and CLIs as the app. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addEvent } from './events.js';
import type { ImprovementReview } from './improvements.js';
import type { WalkthroughRun } from './walkthrough.js';

const execute = promisify(execFile);
const dist = fileURLToPath(new URL('../', import.meta.url));
const scripts = fileURLToPath(new URL('../../scripts/', import.meta.url));
export const CAPABILITIES = [
  { id: 'process', mode: 'synthetic replay', requires: ['Node 22+'], checks: ['scan event → process', 'correction persists', 'original revision retained'] },
  { id: 'improvements', mode: 'synthetic replay', requires: ['Node 22+'], checks: ['optimizer → comparison', 'decision persists', 'process correction makes review stale'] },
  { id: 'floorplan', mode: 'fixture replay with mock OI', requires: ['Node 22+'], checks: ['scaled and unscaled fixtures', 'connector evidence export'], limitation: 'Does not test real OI or model understanding.' },
  { id: 'walkthrough', mode: 'capture plus synthetic perception replay', requires: ['Node 22+', 'Python with NumPy and Pillow'], checks: ['real image preparation', 'replay import', 'review persists', 'stale edit rejected', 'dynamic station rejected'], limitation: 'Does not run MapAnything/SAM or import into OI.' },
] as const;
export type CapabilityId = typeof CAPABILITIES[number]['id'];
interface ScenarioResult { capability: CapabilityId; status: 'passed' | 'failed' | 'blocked'; mode: string; directory: string; checks: string[]; reason?: string }
export interface CapabilityReport { schema: 'fieldops-capability-test/1'; status: 'passed' | 'failed' | 'blocked'; started_at: string; node: string; directory: string; live_inference: false; results: ScenarioResult[] }
class Blocked extends Error {}

/** Execute isolated CLI steps, retaining exact outputs and checking exit status. */
class Scenario {
  private sequence = 0;
  readonly checks: string[] = [];
  constructor(readonly directory: string) {}
  async json(name: string, value: unknown): Promise<string> {
    const path = join(this.directory, name);
    await writeFile(path, JSON.stringify(value, null, 2)); return path;
  }
  async command<T>(file: string, args: string[], label: string, expectedFailure = false): Promise<T> {
    const prefix = join(this.directory, `${String(++this.sequence).padStart(2, '0')}-${label}`);
    let stdout = '', stderr = '', failed = false;
    try {
      ({ stdout, stderr } = await execute(file, args, { cwd: this.directory, timeout: 180000, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, META_API_KEY: '', META_API_BASE: 'https://offline-capability-test.invalid', OI_ROOT: '', OI_SCENE_DATA_DIR: '', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } }));
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; message: string };
      stdout = e.stdout ?? ''; stderr = e.stderr || e.message; failed = true;
    }
    await writeFile(`${prefix}.stdout.txt`, stdout); await writeFile(`${prefix}.stderr.txt`, stderr);
    await this.json(`${String(this.sequence).padStart(2, '0')}-${label}.command.json`, { executable: file, args, failed, expectedFailure });
    if (expectedFailure) {
      assert.ok(failed, `${label}: expected rejection`);
      return { stdout, stderr } as T;
    }
    assert.ok(!failed, `${label} failed; inspect ${prefix}.stderr.txt`);
    const value = JSON.parse(stdout) as T;
    await this.json(`${String(this.sequence).padStart(2, '0')}-${label}.json`, value); return value;
  }
  cli<T>(name: string, args: string[], label: string, expectedFailure = false): Promise<T> {
    return this.command<T>(process.execPath, [join(dist, `${name}.js`), ...args], label, expectedFailure);
  }
}

/** Check actual process CLI persistence, including an unchanged earlier revision. */
async function processScenario(s: Scenario): Promise<void> {
  const root = join(s.directory, 'project');
  const event = await addEvent(root, { title: 'Synthetic tray test', date: '2026-01-01', kind: 'scan',
    payload: { observed_task: 'Prepare trays', suggested_next_steps: ['Fill tray'], video_duration_s: 30 } });
  await s.json('synthetic-event.json', event);
  const built = await s.cli<{ rev: number }>('task-process', ['build', '--root', root, '--event', event.id, '--id', 'headless-trays'], 'build');
  assert.equal(built.rev, 1); s.checks.push('Stored synthetic scan builds process revision 1');
  const patch = await s.json('correction.json', { steps: { 'headless-trays-s0': { label: 'Fill tray with existing scoop' } } });
  await s.cli('task-process', ['correct', '--root', root, '--id', 'headless-trays', '--set', `@${patch}`, '--rationale', 'Synthetic operator correction'], 'correct');
  const current = await s.cli<{ process: { rev: number; steps: Array<{ label: string }> } }>('task-process', ['show', '--root', root, '--id', 'headless-trays'], 'reopen');
  assert.equal(current.process.rev, 2); assert.ok(current.process.steps.some(x => x.label === 'Fill tray with existing scoop'));
  s.checks.push('Correction survives a separate CLI process');
  const original = await s.cli<typeof current>('task-process', ['show', '--root', root, '--id', 'headless-trays', '--rev', '1'], 'original');
  assert.ok(original.process.steps.some(x => x.label === 'Fill tray')); s.checks.push('Original revision remains unchanged');
}

/** Check a proposed improvement, decision, and correction-driven invalidation. */
async function improvementsScenario(s: Scenario): Promise<void> {
  const root = join(s.directory, 'project');
  const result = await s.command<{ improvements: ImprovementReview }>(process.execPath, [join(scripts, 'replay-improvements.mjs'), root], 'optimize');
  const review = result.improvements;
  assert.equal(review.source, 'replay'); assert.equal(review.stale, false);
  assert.equal(review.assessments[0].comparisons[0].status, 'projection');
  s.checks.push('Synthetic inputs produce a projection, not measured savings');
  await s.cli('task-improvements', ['decide', '--root', root, '--id', review.id, '--candidate', 'keep-scoop-at-station', '--status', 'accepted', '--rationale', 'Synthetic ten-tray trial'], 'decide');
  const saved = await s.cli<ImprovementReview>('task-improvements', ['show', '--root', root, '--id', review.id], 'reopen');
  assert.equal(saved.assessments[0].decisions[0].rationale, 'Synthetic ten-tray trial'); s.checks.push('Decision persists');
  const patch = await s.json('correction.json', { steps: { 'trays-o0': { label: 'Corrected synthetic observation' } } });
  await s.cli('task-process', ['correct', '--root', root, '--id', 'trays', '--set', `@${patch}`, '--rationale', 'Synthetic evidence correction'], 'correct-process');
  const stale = await s.cli<ImprovementReview>('task-improvements', ['show', '--root', root, '--id', review.id], 'stale-review');
  assert.equal(stale.stale, true); s.checks.push('Process correction invalidates the earlier comparison');
}

/** Exercise the connector fixture benchmark without OI or model execution. */
async function floorplanScenario(s: Scenario): Promise<void> {
  const report = await s.cli<{ ok: boolean; mock: boolean; fixtures: Array<{ understanding: { scaled: boolean }; evidence: string }> }>(
    'task-floorplan', ['--benchmark', '--mock-oi', '--root', join(s.directory, 'project')], 'benchmark');
  assert.equal(report.ok, true); assert.equal(report.mock, true);
  assert.ok(report.fixtures.some(f => f.understanding.scaled)); assert.ok(report.fixtures.some(f => !f.understanding.scaled));
  for (const f of report.fixtures) JSON.parse(await readFile(join(f.evidence, 'space-ir.json'), 'utf8'));
  s.checks.push('Scaled and unscaled fixtures produce inspectable evidence through mock OI');
}

/** Prepare real image files and test explicit synthetic segmentation replay/review. */
async function walkthroughScenario(s: Scenario): Promise<void> {
  const python = process.env.WALKTHROUGH_PYTHON || 'python3';
  try { await s.command(python, ['-c', 'import numpy, PIL; print("{}")'], 'python-check'); }
  catch { throw new Blocked('Python with NumPy and Pillow is required. Set WALKTHROUGH_PYTHON; see python-check stderr.'); }
  const bundle = join(s.directory, 'bundle'), root = join(s.directory, 'project');
  await s.command(python, [join(scripts, 'replay-walkthrough.py'), bundle], 'make-synthetic-bundle');
  const capture = await s.cli<WalkthroughRun>('task-walkthrough', ['capture', '--root', root, '--image', join(bundle, 'candidate-0.png'), '--image', join(bundle, 'candidate-1.png')], 'capture');
  assert.equal(capture.report.status, 'captured'); assert.equal(capture.report.observations.length, 0);
  s.checks.push('Image capture preserves views without inventing model observations');
  const replay = await s.cli<WalkthroughRun>('task-walkthrough', ['replay', '--root', root, '--manifest', join(bundle, 'run.json')], 'replay');
  assert.equal(replay.report.source, 'replay');
  const patch = await s.json('review.json', { observation_id: 'observation-0', decision: 'confirmed', station: 'Synthetic bench', static_confirmed: true, rationale: 'Synthetic operator confirmation' });
  const args = ['review', '--root', root, '--id', replay.id, '--revision', '1', '--patch', patch];
  await s.cli('task-walkthrough', args, 'review');
  const reopened = await s.cli<WalkthroughRun>('task-walkthrough', ['show', '--root', root, '--id', replay.id], 'reopen');
  assert.equal(reopened.reviews[0].station, 'Synthetic bench'); s.checks.push('Station review persists');
  const stale = await s.cli<{ stderr: string }>('task-walkthrough', args, 'reject-stale', true);
  assert.match(stale.stderr, /Stale review/); s.checks.push('Stale review is rejected');
  const person = await s.json('person-review.json', { observation_id: 'observation-1', decision: 'confirmed', station: 'Person', static_confirmed: true, rationale: 'Synthetic negative test' });
  const dynamic = await s.cli<{ stderr: string }>('task-walkthrough', ['review', '--root', root, '--id', replay.id, '--revision', '2', '--patch', person], 'reject-dynamic', true);
  assert.match(dynamic.stderr, /Dynamic/); s.checks.push('Person cannot become a station');
  const handoff = await s.cli<{ status: string; scale_status: string; stations: unknown[] }>('task-walkthrough', ['handoff', '--root', root, '--id', replay.id], 'handoff');
  assert.equal(handoff.status, 'awaiting_oi_contract'); assert.equal(handoff.scale_status, 'unverified'); assert.equal(handoff.stations.length, 1);
  s.checks.push('Handoff keeps scale unverified and OI integration pending');
}

/** Run selected scenarios in a new artifact directory; never overwrite user projects. */
export async function testCapabilities(selection: string, directory: string): Promise<CapabilityReport> {
  const selected = CAPABILITIES.filter(c => selection === 'all' || c.id === selection);
  if (!selected.length) throw new Error(`Unknown capability: ${selection}. Use list.`);
  if (!isAbsolute(directory)) throw new Error('--out must be an absolute path to a new directory.');
  await mkdir(directory); // Deliberately refuse an existing directory, even if empty.
  const report: CapabilityReport = { schema: 'fieldops-capability-test/1', status: 'passed', started_at: new Date().toISOString(), node: process.version, directory, live_inference: false, results: [] };
  const scenarios = { process: processScenario, improvements: improvementsScenario, floorplan: floorplanScenario, walkthrough: walkthroughScenario };
  for (const capability of selected) {
    const folder = join(directory, capability.id); await mkdir(folder);
    const scenario = new Scenario(folder);
    const result: ScenarioResult = { capability: capability.id, status: 'passed', mode: capability.mode, directory: folder, checks: scenario.checks };
    try { await scenarios[capability.id](scenario); }
    catch (error) { result.status = error instanceof Blocked ? 'blocked' : 'failed'; result.reason = (error as Error).message; }
    report.results.push(result);
    report.status = report.results.some(r => r.status === 'failed') ? 'failed' : report.results.some(r => r.status === 'blocked') ? 'blocked' : 'passed';
    await writeFile(join(directory, 'report.json'), JSON.stringify(report, null, 2));
  }
  return report;
}
