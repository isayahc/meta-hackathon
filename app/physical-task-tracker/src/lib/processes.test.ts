// Process model tests: builder discipline, validation, revisions,
// corrections, and staleness. No network, no API key.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.js';
import { getDoc, setDoc } from './db.js';
import {
  buildProcessFromScan,
  validateProcess,
  normalizeProcess,
  occurrencesOf,
  saveRevision,
  readProcess,
  listProcesses,
  applyCorrection,
  markDependentStale,
  ProcessError,
  type ProcessDoc,
} from './processes.js';

async function freshRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'proc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const SCAN = {
  observed_task: 'Spread mulch under the north fence',
  stage: 'half the run is covered',
  per_frame: ['bare soil along the fence', 'wheelbarrow with mulch', 'mulch spread halfway'],
  suggested_next_steps: ['Finish spreading the remaining run', 'Water the mulch in'],
  confidence: 'medium',
  unknowns: ['mulch depth cannot be told from these frames'],
};

async function assertProcError(fn: () => unknown, code: string): Promise<ProcessError> {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof ProcessError, `want ProcessError, got ${String(e)}`);
    assert.equal(e.code, code);
    return e;
  }
  assert.fail(`want ProcessError ${code}, nothing thrown`);
}

test('a video scan yields an inspectable process, not just a task array', async () => {
  const doc = buildProcessFromScan({ id: 'proc-1', analysis: SCAN, media: 'clip.mp4', eventId: 'e-1', model: 'm', promptVersion: 'v1', duration_s: 30 });
  assert.equal(doc.schema, 'farm-process/1');
  assert.equal(doc.goals.length, 1);
  assert.equal(doc.goals[0]?.label, 'Spread mulch under the north fence');
  assert.deepEqual(doc.goals[0]?.step_ids, ['proc-1-s0', 'proc-1-s1']);
  assert.equal(doc.steps.length, 2);
  assert.equal(doc.steps[0]?.label, 'Finish spreading the remaining run');
  // Unknown discipline: inferred, not started, no invented precedence/order.
  for (const s of doc.steps) {
    assert.equal(s.claim, 'unknown'); // no footage supports these future steps
    assert.equal(s.execution, 'not_started');
    assert.equal(s.requires_unknown, true);
    assert.equal(s.observed_order, null);
    assert.equal(s.location, null);
  }
  assert.equal(doc.coverage.total_s, 30);
  assert.equal(doc.coverage.observed_spans.length, 3);
  assert.deepEqual(doc.unknowns, ['mulch depth cannot be told from these frames']);
  assert.equal(doc.confidence, 'medium');
  const badConf = buildProcessFromScan({ id: 'proc-2', analysis: { suggested_next_steps: ['x'], confidence: 'extreme' } });
  assert.equal(badConf.confidence, null);
  await assertProcError(() => validateProcess({ ...structuredClone(badConf), confidence: 'extreme' }), 'PROC_BAD_STATUS');
  assert.ok(doc.gaps.some((g) => g.includes('no supporting footage')));
  assert.equal(doc.provenance.source_event_id, 'e-1');
  assert.equal(doc.provenance.model, 'm');
});

test('unsupported details stay unknown and partial footage caps completion', async (t: TestContext) => {
  const root = await freshRoot(t);
  const doc = buildProcessFromScan({ id: 'proc-1', analysis: SCAN, eventId: 'e-1' });
  // Builder never claims complete from partial footage.
  assert.ok(doc.steps.every((s) => s.execution !== 'complete'));
  assert.ok(doc.goals.every((g) => g.execution !== 'complete'));
  await saveRevision(root, doc);
  // Hand-asserted completion without evidence is rejected, not stored.
  const bad = structuredClone(doc);
  bad.steps[0]!.execution = 'complete';
  await assertProcError(() => saveRevision(root, bad), 'PROC_UNEVIDENCED_COMPLETION');
  const badGoal = structuredClone(doc);
  badGoal.goals[0]!.execution = 'complete';
  await assertProcError(() => saveRevision(root, badGoal), 'PROC_UNEVIDENCED_COMPLETION');
  // What survived on disk is still rev 1, nothing complete.
  assert.equal((await readProcess(root, 'proc-1')).rev, 1);
});

test('invalid timestamps are rejected', async () => {
  const base = buildProcessFromScan({ id: 'p', analysis: { suggested_next_steps: ['Do it'] }, duration_s: 10 });
  const endBeforeStart = structuredClone(base);
  endBeforeStart.steps[0]!.evidence.spans = [{ start_s: 5, end_s: 2 }];
  await assertProcError(() => validateProcess(endBeforeStart), 'PROC_BAD_TIMESTAMP');
  const notFinite = structuredClone(base);
  notFinite.steps[0]!.evidence.spans = [{ start_s: NaN, end_s: 2 }];
  await assertProcError(() => validateProcess(notFinite), 'PROC_BAD_TIMESTAMP');
  const beyondFootage = structuredClone(base);
  beyondFootage.steps[0]!.evidence.spans = [{ start_s: 1, end_s: 11 }];
  await assertProcError(() => validateProcess(beyondFootage), 'PROC_BAD_TIMESTAMP');
  const negative = structuredClone(base);
  negative.steps[0]!.evidence.spans = [{ start_s: -1, end_s: 2 }];
  await assertProcError(() => validateProcess(negative), 'PROC_BAD_TIMESTAMP');
});

test('unknown references and required cycles are rejected with a path', async () => {
  const base = buildProcessFromScan({ id: 'p', analysis: { suggested_next_steps: ['A', 'B', 'C'] } });
  const dangling = structuredClone(base);
  dangling.steps[0]!.requires = ['p-nope'];
  await assertProcError(() => validateProcess(dangling), 'PROC_UNKNOWN_REQUIRE');
  const cyclic = structuredClone(base);
  cyclic.steps[0]!.requires = ['p-s1'];
  cyclic.steps[1]!.requires = ['p-s2'];
  cyclic.steps[2]!.requires = ['p-s0'];
  const err = await assertProcError(() => validateProcess(cyclic), 'PROC_CYCLE');
  assert.match(err.message, /p-s0 -> p-s1 -> p-s2 -> p-s0/);
  const selfLoop = structuredClone(base);
  selfLoop.steps[0]!.requires = ['p-s0'];
  await assertProcError(() => validateProcess(selfLoop), 'PROC_CYCLE');
});

test('ambiguous observed order is surfaced while precedence still validates', async () => {
  const doc = buildProcessFromScan({ id: 'p', analysis: { suggested_next_steps: ['A', 'B'] } });
  doc.steps[0]!.observed_order = 2;
  doc.steps[1]!.observed_order = 2;
  doc.steps[1]!.requires = ['p-s0'];
  doc.steps[1]!.requires_unknown = false;
  const clean = normalizeProcess(validateProcess(doc));
  assert.ok(clean.order_notes.some((n) => n.includes('share observed order 2')));
  // Precedence is untouched by the tie: no cycle, requires intact.
  assert.deepEqual(clean.steps[1]?.requires, ['p-s0']);
});

test('repeated steps validate and report occurrences', async () => {
  const doc = buildProcessFromScan({ id: 'p', analysis: { suggested_next_steps: ['Water each row', 'Watch for runoff'] } });
  assert.equal(occurrencesOf(doc.steps[0]!), 1);
  doc.steps[0]!.repeat = { times: 3 };
  doc.steps[1]!.repeat = { until: 'soil is damp 5cm down' };
  validateProcess(doc);
  assert.equal(occurrencesOf(doc.steps[0]!), 3);
  assert.equal(occurrencesOf(doc.steps[1]!), null);
  const bad = structuredClone(doc);
  bad.steps[0]!.repeat = { times: 0 };
  await assertProcError(() => validateProcess(bad), 'PROC_BAD_REPEAT');
});

test('farmer corrections persist as revisions with originals retained', async (t: TestContext) => {
  const root = await freshRoot(t);
  await saveRevision(root, buildProcessFromScan({ id: 'p', analysis: SCAN, eventId: 'e-1' }));
  const { doc } = await applyCorrection(
    root,
    'p',
    { steps: { 'p-s0': { label: 'Finish spreading the remaining run by hand', requires_unknown: false } } },
    'The wheelbarrow cannot reach the far run.'
  );
  assert.equal(doc.rev, 2);
  assert.equal(doc.steps[0]?.label, 'Finish spreading the remaining run by hand');
  assert.equal(doc.steps[0]?.claim, 'corrected');
  assert.equal(doc.corrections.length, 1);
  assert.match(doc.corrections[0]?.rationale ?? '', /wheelbarrow/);
  // Original claims retained under rev 1.
  const original = await readProcess(root, 'p', 1);
  assert.equal(original.steps[0]?.label, 'Finish spreading the remaining run');
  assert.equal(original.steps[0]?.claim, 'unknown');
  // Correction without rationale is refused.
  await assertProcError(() => applyCorrection(root, 'p', { title: 'x' }, '  '), 'PROC_CORRECTION');
});

test('corrections persist across reopen and read back current', async (t: TestContext) => {
  const root = await freshRoot(t);
  await saveRevision(root, buildProcessFromScan({ id: 'p', analysis: SCAN }));
  await applyCorrection(root, 'p', { title: 'Mulch the north fence' }, 'Clearer title.');
  openDb(root).close(); // explicit reopen
  openDb(root).close();
  const current = await readProcess(root, 'p');
  assert.equal(current.rev, 2);
  assert.equal(current.title, 'Mulch the north fence');
  assert.deepEqual(await listProcesses(root), [
    { process_id: 'p', rev: 2, title: 'Mulch the north fence', updated_at: current.updated_at },
  ]);
});

test('a contradicting correction that cycles is rejected and rev is unchanged', async (t: TestContext) => {
  const root = await freshRoot(t);
  await saveRevision(root, buildProcessFromScan({ id: 'p', analysis: { suggested_next_steps: ['A', 'B'] } }));
  await applyCorrection(root, 'p', { steps: { 'p-s1': { requires: ['p-s0'], requires_unknown: false } } }, 'B needs A first.');
  await assertProcError(
    () => applyCorrection(root, 'p', { steps: { 'p-s0': { requires: ['p-s1'], requires_unknown: false } } }, 'Actually A needs B.'),
    'PROC_CYCLE'
  );
  assert.equal((await readProcess(root, 'p')).rev, 2);
  // Observed-before-prerequisite is surfaced as a note, not a rejection.
  const { doc } = await applyCorrection(
    root,
    'p',
    { steps: { 'p-s0': { observed_order: 5 }, 'p-s1': { observed_order: 1 } } },
    'Footage shows B handled before A finished.'
  );
  assert.equal(doc.rev, 3);
  assert.ok(doc.order_notes.some((n) => n.includes('observed before its prerequisite')));
});

test('downstream analysis uses the corrected version; older recommendations go stale', async (t: TestContext) => {
  const root = await freshRoot(t);
  await saveRevision(root, buildProcessFromScan({ id: 'p', analysis: SCAN }));
  setDoc(root, 'plan', { plan: { ranked_actions: ['old advice'] }, process_basis: [{ process_id: 'p', rev: 1 }], stale: false });
  const { doc, staleDocs } = await applyCorrection(root, 'p', { title: 'Corrected title' }, 'Title fix.');
  assert.equal(doc.title, 'Corrected title');
  assert.deepEqual(staleDocs, ['plan']);
  const plan = getDoc(root, 'plan') as { stale: boolean; stale_reason: string };
  assert.equal(plan.stale, true);
  assert.match(plan.stale_reason, /rev 2/);
  // Current reads always serve the corrected revision.
  assert.equal((await readProcess(root, 'p')).title, 'Corrected title');
  // Docs already built from the new rev, or with no basis, are left alone.
  setDoc(root, 'plan', { plan: {}, process_basis: [{ process_id: 'p', rev: 2 }], stale: false });
  assert.deepEqual(await markDependentStale(root, 'p', 2), []);
  assert.equal((getDoc(root, 'plan') as { stale: boolean }).stale, false);
  setDoc(root, 'plan', { plan: {} });
  assert.deepEqual(await markDependentStale(root, 'p', 3), []);
});

test('evidenced completion validates end to end', async () => {
  const doc = buildProcessFromScan({ id: 'p', analysis: { suggested_next_steps: ['Spread the run'] }, duration_s: 60 });
  const step = doc.steps[0]!;
  step.completion_criteria = ['full run covered'];
  step.criteria_evidence = { 'full run covered': [{ start_s: 50, end_s: 60 }] };
  step.evidence.spans = [{ start_s: 0, end_s: 60 }];
  step.execution = 'complete';
  step.claim = 'observed';
  doc.goals[0]!.execution = 'complete';
  const clean = normalizeProcess(validateProcess(doc));
  assert.equal(clean.steps[0]?.execution, 'complete');
  assert.equal(clean.goals[0]?.execution, 'complete');
});
