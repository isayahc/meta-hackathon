/** Offline acceptance tests for evidence, arithmetic, constraints, OI boundaries and farmer decisions. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProcessFromScan, saveRevision, applyCorrection, readProcess, type BuildProcessInput } from './processes.js';
import { addGoal } from './goals.js';
import { openDb } from './db.js';
import { OiMockTransport, type OiSpaceIrDoc } from './oi-connector.js';
import { assessImprovements, compareMeasurements, decideImprovement, emptyWorkflowContext, improvementPlan,
  listImprovementReviews, parseCandidates, parseWorkflowContext, readImprovementReview, writeWorkflowContext, saveImprovementReview,
  type WorkflowContext, type ImprovementCandidate } from './improvements.js';

interface Fixture { scan: BuildProcessInput; context: WorkflowContext; candidates: ImprovementCandidate[] }
async function setup(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'improvements-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = JSON.parse(await readFile(new URL('../samples/workflow-improvements.json', import.meta.url), 'utf8')) as Fixture;
  const original = buildProcessFromScan(fixture.scan);
  await saveRevision(root, original);
  const { doc } = await applyCorrection(root, original.id, { steps: Object.fromEntries(original.steps.map((s) => [s.id, { requires_unknown: false }])) }, 'Synthetic farmer review: no prerequisites for these steps.');
  return { root, doc, context: fixture.context, candidates: fixture.candidates };
}

test('evidence-backed intervention has transparent projection and unknown metrics', async (t) => {
  const { root, doc, context, candidates } = await setup(t);
  const [a] = await assessImprovements(root, [doc], [], context, candidates);
  assert.equal(a.evidence.status, 'farmer_confirmed');
  assert.equal(a.feasibility, 'eligible');
  assert.equal(a.actionable, false);
  assert.match(a.candidate.verification.action, /count separate trips/);
  const c = a.comparisons[0];
  assert.equal(c.unit, 'min/tray');
  assert.equal(c.baseline_per_unit, 2);
  assert.equal(c.proposed_per_unit, 1.2);
  assert.equal(c.reduction_per_unit, 0.8);
  assert.equal(c.reduction_percent, 40);
  assert.equal(c.status, 'projection');
  assert.match(c.calculation, /20 min × 1.*10 tray/);
  assert.equal(c.baseline.kind, 'measured');
  assert.equal(c.proposed.kind, 'estimated');
  assert.ok(a.unknown_metrics.includes('water'));
  assert.ok(a.unknown_metrics.includes('distance'));
});

test('normalization converts seconds, preserves assumptions and avoids incomparable arithmetic', async (t) => {
  const { context } = await setup(t);
  const b = context.measurements[2], p = context.measurements[3];
  b.unit = 's'; b.value = 1200;
  assert.equal(compareMeasurements(b, p).baseline_per_unit, 2);
  p.kind = 'assumed'; assert.equal(compareMeasurements(b, p).status, 'projection');
  b.value = 0; assert.equal(compareMeasurements(b, p).reduction_percent, null);
  p.value = null; p.kind = 'unknown';
  assert.equal(compareMeasurements(b, p).reduction_per_unit, null);
  assert.equal(compareMeasurements(b, p).status, 'unknown');
  p.value = 10; p.kind = 'measured'; p.workload!.context = 'different tray size';
  assert.match(compareMeasurements(b, p).unknowns.join(' '), /contexts differ/);
  p.workload = null; assert.match(compareMeasurements(b, p).unknowns.join(' '), /denominators/);
});

test('invalid numbers, units, zero workloads and duplicate input IDs are rejected', async (t) => {
  const { context } = await setup(t);
  for (const bad of [NaN, Infinity, -1]) {
    const c = structuredClone(context); c.measurements[0].value = bad;
    assert.throws(() => parseWorkflowContext(c), /nonnegative/);
  }
  const zero = structuredClone(context); zero.measurements[2].workload!.amount = 0;
  assert.throws(() => parseWorkflowContext(zero), /positive/);
  const units = structuredClone(context); units.measurements[2].unit = 'feet';
  assert.throws(() => parseWorkflowContext(units), /unit/);
  const dup = structuredClone(context); dup.measurements.push(dup.measurements[0]);
  assert.throws(() => parseWorkflowContext(dup), /Duplicate/);
  assert.throws(() => parseCandidates({ improvements: [] }), /array/);
});

test('budget, staffing, access/quality conditions, and forbidden changes override narrative', async (t) => {
  const { root, doc, context, candidates } = await setup(t);
  context.measurements[0].value = 100;
  context.measurements[1].value = 2;
  context.conditions[0].status = 'not_met';
  candidates[0].change_tags.push('move-bench');
  const spoof = { ...candidates[0], feasibility: 'eligible', decision: 'accepted', priority: 999 };
  const [a] = await assessImprovements(root, [doc], [], context, [spoof]);
  assert.equal(a.feasibility, 'blocked');
  assert.equal(a.decision, 'proposed');
  assert.equal(a.priority, 1);
  assert.equal(a.blocked.length, 4);
  assert.match(a.blocked.join(' '), /budget.*staffing.*maintain-fill-depth.*move-bench/);
});

test('ranking keeps eligible alternatives ahead of high-priority infeasible alternatives', async (t) => {
  const { root, doc, context, candidates } = await setup(t);
  const goal = await addGoal(root, { text: 'Finish trays today', weight: 5 });
  const blocked = structuredClone(candidates[0]); blocked.id = 'blocked'; blocked.goal_ids = [goal.id]; blocked.change_tags = ['move-bench'];
  const [first, last] = await assessImprovements(root, [doc], [goal], context, [blocked, candidates[0]]);
  assert.equal(first.candidate.id, candidates[0].id);
  assert.equal(last.priority, 5);
  assert.equal(last.feasibility, 'blocked');
});

test('unknown constraints, estimated requirements and process prerequisites defer proposals', async (t) => {
  const { root, doc, context, candidates } = await setup(t);
  context.constraints.available_people = null;
  context.measurements[0].kind = 'estimated';
  context.constraints.notes = ['Keep the path clear for deliveries'];
  doc.steps[0].requires_unknown = true;
  doc.steps[0].preconditions = ['soil-dry'];
  doc.steps[0].requires = [doc.steps[1].id];
  const [a] = await assessImprovements(root, [doc], [], context, candidates);
  assert.equal(a.feasibility, 'deferred');
  assert.match(a.unvalidated.join(' '), /budget.*staffing.*deliveries.*prerequisites.*not complete.*soil-dry/);
});

test('unverified diagnosis stays a hypothesis even when model labels it observed', async (t) => {
  const { root, doc, context, candidates } = await setup(t);
  candidates[0].diagnosis.observation_ids = [];
  const [a] = await assessImprovements(root, [doc], [], context, candidates);
  assert.equal(a.evidence.status, 'hypothesis');
  assert.equal(a.feasibility, 'deferred');
  assert.match(a.evidence.requests.join(' '), /separate trips/);
  context.observations[0].rev = 1;
  candidates[0].diagnosis.observation_ids = ['scoop-trips'];
  assert.equal((await assessImprovements(root, [doc], [], context, candidates))[0].evidence.status, 'hypothesis');
});

test('observed friction requires present media and matching source frames', async (t) => {
  const { root, doc, context, candidates } = await setup(t);
  context.observations[0].basis = 'observed';
  for (const step of doc.steps) { step.claim = 'observed'; step.evidence.media = 'clip.mp4'; }
  assert.equal((await assessImprovements(root, [doc], [], context, candidates))[0].evidence.status, 'hypothesis');
  await mkdir(join(root, 'media'));
  await writeFile(join(root, 'media', 'clip.mp4'), 'synthetic fixture bytes');
  assert.equal((await assessImprovements(root, [doc], [], context, candidates))[0].evidence.status, 'observed');
  doc.steps[2].evidence.spans[0].frame = 0;
  assert.equal((await assessImprovements(root, [doc], [], context, candidates))[0].evidence.status, 'hypothesis');
});

test('fabricated process, step, measurement, goal and observation references fail closed', async (t) => {
  const { root, doc, context, candidates } = await setup(t);
  for (const edit of [
    (p: ImprovementCandidate) => { p.process_rev = 99; },
    (p: ImprovementCandidate) => { p.diagnosis.step_ids = ['missing']; },
    (p: ImprovementCandidate) => { p.requirements.cost_id = 'fabricated'; },
    (p: ImprovementCandidate) => { p.goal_ids = ['invented']; },
    (p: ImprovementCandidate) => { p.diagnosis.observation_ids = ['invented']; },
  ]) {
    const candidate = structuredClone(candidates[0]); edit(candidate);
    await assert.rejects(() => assessImprovements(root, [doc], [], context, [candidate]), /Unknown|not supplied/);
  }
});

test('quality loss is blocked and increased reported effort requires farmer review', async (t) => {
  const { root, doc, context, candidates } = await setup(t);
  for (const metric of ['quality', 'effort'] as const) {
    const c = structuredClone(context);
    c.measurements[2].metric = metric; c.measurements[2].unit = 'score'; c.measurements[2].value = 8;
    c.measurements[3].metric = metric; c.measurements[3].unit = 'score'; c.measurements[3].value = metric === 'quality' ? 5 : 10;
    const [a] = await assessImprovements(root, [doc], [], c, candidates);
    assert.equal(a.feasibility, metric === 'quality' ? 'blocked' : 'deferred');
  }
});

function addSpatial(context: WorkflowContext, candidate: ImprovementCandidate): void {
  candidate.spatial_change = true;
  candidate.spatial_option_id = 'layout';
  context.spatial_options.push({ id: 'layout', scene_id: 'scene-1', revision: 1, entity_ids: ['bench'],
    space_ir: { schema_id: 'mapped-assembly.space-ir', schema_version: '0.1.0', id: 'alternative', revision: '1', site: null,
      frames: [], regions: [], boundaries: [], portals: [], occupancies: [], spatial_relations: [], constraints: [], evidence: [], unresolved: ['Unscaled fixture'] } satisfies OiSpaceIrDoc });
}

test('spatial changes without references/runtime are unvalidated', async (t) => {
  const { root, doc, context, candidates } = await setup(t);
  candidates[0].spatial_change = true;
  assert.equal((await assessImprovements(root, [doc], [], context, candidates))[0].feasibility, 'deferred');
  addSpatial(context, candidates[0]);
  const [a] = await assessImprovements(root, [doc], [], context, candidates);
  assert.equal(a.spatial.status, 'unvalidated');
  assert.match(JSON.stringify(a.spatial.findings), /unavailable/);
});

test('OI validates alternatives without compile/commit; validity does not prove physical feasibility', async (t) => {
  const { root, doc, context, candidates } = await setup(t);
  addSpatial(context, candidates[0]);
  const oi = new OiMockTransport({ validate: () => ({ valid: true, findings: [] }) });
  const [a] = await assessImprovements(root, [doc], [], context, candidates, oi);
  assert.deepEqual(oi.calls.map((c) => c.op), ['head', 'validate']);
  assert.equal(a.spatial.status, 'checked');
  assert.equal(a.feasibility, 'deferred');
  assert.match(a.unvalidated.join(' '), /clearance, access/);
  const mock = new OiMockTransport();
  assert.equal((await assessImprovements(root, [doc], [], context, candidates, mock))[0].spatial.status, 'unvalidated');
});

test('stale OI scene, rejected alternative and runtime failure remain explicit', async (t) => {
  const { root, doc, context, candidates } = await setup(t);
  addSpatial(context, candidates[0]);
  const stale = new OiMockTransport({ head: () => ({ scene_id: 'scene-1', revision: 2, name: 'changed' }) });
  assert.equal((await assessImprovements(root, [doc], [], context, candidates, stale))[0].feasibility, 'blocked');
  assert.deepEqual(stale.calls.map((c) => c.op), ['head']);
  const invalid = new OiMockTransport({ validate: () => ({ valid: false, findings: [{ code: 'BAD_REF', path: '$', message: 'Missing entity', severity: 'error' }] }) });
  assert.equal((await assessImprovements(root, [doc], [], context, candidates, invalid))[0].feasibility, 'blocked');
  const failed = new OiMockTransport({ validate: () => { throw new Error('offline'); } });
  assert.equal((await assessImprovements(root, [doc], [], context, candidates, failed))[0].spatial.status, 'unvalidated');
});

test('decisions and rationales survive reopening; stale accepted advice is not actionable', async (t) => {
  const { root, doc, context, candidates } = await setup(t);
  const review = await saveImprovementReview(root, [doc], [], context, candidates, 'replay');
  await assert.rejects(async () => (await decideImprovement(root, review.id, candidates[0].id, 'accepted', ' ')), /nonempty/);
  await assert.rejects(async () => (await decideImprovement(root, review.id, candidates[0].id, 'done', 'x')), /Decision/);
  const accepted = await decideImprovement(root, review.id, candidates[0].id, 'accepted', 'Try it for ten trays.');
  assert.equal(accepted.assessments[0].actionable, true);
  openDb(root).close();
  assert.equal((await listImprovementReviews(root))[0].assessments[0].decisions[0].rationale, 'Try it for ten trays.');
  await applyCorrection(root, doc.id, { title: 'Corrected workflow' }, 'New process review.');
  const stale = await readImprovementReview(root, review.id);
  assert.equal(stale.stale, true);
  assert.equal(stale.assessments[0].actionable, false);
  assert.equal(stale.assessments[0].decision, 'accepted'); // Historical decision is preserved.
  assert.equal((await improvementPlan(stale)).ranked_actions.length, 0);
  await assert.rejects(async () => (await decideImprovement(root, review.id, candidates[0].id, 'accepted', 'Again')), /Stale/);
  const rejected = await decideImprovement(root, review.id, candidates[0].id, 'rejected', 'Process changed.');
  assert.equal(rejected.assessments[0].decisions.length, 2);
});

test('blocked/deferred proposals cannot be accepted, but farmer rejection/defer is retained', async (t) => {
  const { root, doc, context, candidates } = await setup(t);
  context.constraints.budget_usd = 0; context.measurements[0].value = 5;
  const review = await saveImprovementReview(root, [doc], [], context, candidates, 'replay');
  await assert.rejects(async () => (await decideImprovement(root, review.id, candidates[0].id, 'accepted', 'Ignore budget')), /Blocked/);
  const deferred = await decideImprovement(root, review.id, candidates[0].id, 'deferred', 'Wait for budget.');
  assert.equal(deferred.assessments[0].decision, 'deferred');
  assert.equal((await improvementPlan(deferred)).ranked_actions.length, 0);
});

test('correction during OI validation makes the newly saved review stale', async (t) => {
  const { root, doc, context, candidates } = await setup(t);
  addSpatial(context, candidates[0]);
  const transport = { async request<T>(op: string): Promise<T> {
    if (op === 'head') return { scene_id: 'scene-1', revision: 1 } as T;
    await applyCorrection(root, doc.id, { title: 'Updated mid-generation' }, 'New observation.');
    return { valid: true, findings: [] } as T;
  } };
  const review = await saveImprovementReview(root, [doc], [], context, candidates, 'replay', transport);
  assert.equal(review.stale, true);
  assert.equal(review.process_basis[0].rev, 2);
  assert.equal((await readProcess(root, doc.id)).rev, 3);
});

test('missing measurements remain unknown instead of inventing savings', async (t) => {
  const { root, doc, candidates } = await setup(t);
  const context = emptyWorkflowContext();
  candidates[0].requirements.cost_id = null;
  candidates[0].requirements.labor_id = null;
  candidates[0].diagnosis.observation_ids = [];
  candidates[0].comparisons = [];
  const [a] = await assessImprovements(root, [doc], [], context, candidates);
  assert.deepEqual(a.comparisons, []);
  assert.equal(a.feasibility, 'deferred');
  assert.ok(a.unknown_metrics.includes('time'));
});

test('changed farmer constraints invalidate historical acceptance and cannot be overridden', async (t) => {
  const { root, doc, context, candidates } = await setup(t);
  const review = await saveImprovementReview(root, [doc], [], context, candidates, 'replay');
  await decideImprovement(root, review.id, candidates[0].id, 'accepted', 'Ready for a trial.');
  context.constraints.available_people = 0;
  await writeWorkflowContext(root, context);
  const updated = await readImprovementReview(root, review.id);
  assert.equal(updated.stale, true);
  assert.equal(updated.assessments[0].actionable, false);
  await assert.rejects(async () => (await decideImprovement(root, review.id, candidates[0].id, 'accepted', 'Again')), /constraints or evidence changed/);
});

test('missing structured proposals never turn model narrative into checked actions', async (t) => {
  const { root, doc, context } = await setup(t);
  const review = await saveImprovementReview(root, [doc], [], context, [], 'model');
  const plan = await improvementPlan(review);
  assert.deepEqual(plan.ranked_actions, []);
  assert.match(plan.deferred[0].why, /No structured improvement proposals/);
});

test('intervention review consumes read-only route checks, retains unknowns and never manufactures distance savings', async t => {
  const {root,doc,context,candidates}=await setup(t);addSpatial(context,candidates[0]);
  const option=context.spatial_options[0];option.entity_ids=['bench','supplies'];
  option.route_assessment={schema:'oi-route-assessment/1',scene_id:option.scene_id,revision:1,frame:'oi-world-m-Y-up',station_ids:['bench','supplies'],route:[[0,0,0],[1,0,0]],
    profile:{kind:'person',width_m:.6,margin_m:.1,source:'mock-fixture'},evidence:[],scale:{predicted_m_per_unit:null,calibration:null,holdout:null,holdout_independence:'not-established'},
    environment:{coverage:'partial',source:'mock-fixture',unknowns:[]},space:{document:option.space_ir as unknown as Record<string,unknown>,sha256:'0'.repeat(64),from_region:'a',to_region:'b',source:'mock-fixture'},alternative:null};
  const calls:Array<{op:string;payload:Record<string,unknown>}>=[];
  let blocked=false;
  const transport={async request<T>(op:string,payload:Record<string,unknown>):Promise<T>{
    calls.push({op,payload});return {schema:'oi-route-assessment/1',scene_id:option.scene_id,revision:1,head_revision:1,input_digest:'a'.repeat(64),result_digest:'b'.repeat(64),
      geometric_path_length_m:8,validated_walkable_route_length_m:null,checks:[{id:'obstruction',status:blocked?'failed':'passed',reason:'Explicit mock test response'},
        {id:'physical-traversability',status:'unsupported',reason:'Not supported'}],traversability:blocked?'failed':'unknown',stale:false,mutations:0,mock:true} as T;
  }};
  const [a]=await assessImprovements(root,[doc],[],context,candidates,transport);
  assert.equal(a.spatial.route_assessment?.geometric_path_length_m,8);assert.equal(a.spatial.route_assessment?.mock,true);
  assert.equal(a.feasibility,'deferred');assert.ok(a.unknown_metrics.includes('distance'));
  assert.deepEqual(calls.map(c=>c.op),['route-assessment']);assert.equal(calls[0].payload.action,'assess');assert.ok(calls[0].payload.dataDir);
  blocked=true;assert.equal((await assessImprovements(root,[doc],[],context,candidates,transport))[0].feasibility,'blocked');
  option.route_assessment.revision=2;const count=calls.length;
  assert.equal((await assessImprovements(root,[doc],[],context,candidates,transport))[0].spatial.status,'unvalidated');assert.equal(calls.length,count);
});

