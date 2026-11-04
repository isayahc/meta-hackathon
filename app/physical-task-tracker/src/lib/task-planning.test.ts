/** Scheduling invariants: preserve evidence, task identity, goals and accepted human choices. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTask, editTask, configurePlanning, saveCommitment, proposePlan, decidePlan, planningView, planningCalendar, recordWork, changeBlock, planningCommand } from './task-planning.js';
import { zonedInstant, localParts } from './planning-time.js';
import { addGoal, listGoals } from './goals.js';
import { addEvent } from './events.js';
import { syncActions, setActionStatus } from './actions.js';

const day = '2026-10-20', at = (time: string): string => `${day}T${time}:00.000Z`, now = at('08:00');
async function fixture(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'human-plan-')); t.after(() => rm(root, { recursive: true, force: true }));
  await configurePlanning(root, 1, { timezone: 'UTC', person: 'operator', max_minutes: 480, resources: { scoop: 'available' }, availability: [{ start: at('09:00'), end: at('12:00') }] });
  return root;
}
const ready = (text = 'Fill trays', duration = 30) => ({ text, active_minutes: duration, estimate_source: 'Operator estimate', completion_criteria: 'All specified trays filled', review: 'confirmed', resources: ['scoop'] });

test('shared goal links persist, unlinks retain task history, task completion leaves outcomes open', async t => {
  const root = await fixture(t), a = await addGoal(root, { text: '50 trays', success_criteria: '50 trays pass inspection' }), b = await addGoal(root, { text: 'Prepare delivery' });
  const links = [a, b].map(g => ({ goal_id: g.id, explanation: 'Tray preparation contributes to this outcome', origin: 'human', review: 'confirmed' }));
  let task = await createTask(root, { ...ready(), links }, 'shared');
  assert.equal((await createTask(root, { ...ready(), links }, 'shared')).id, task.id);
  const plan = await proposePlan(root, day, now); assert.equal(plan.blocks.length, 1); assert.equal(plan.scheduled_minutes, 30);
  assert.equal(plan.explanations[0].goals.length, 2);
  assert.equal((await planningView(root)).goal_progress[0].total, 1);
  task = (await editTask(root, task.id, task.revision, { links: [links[0]], execution: 'done' }, 'Second association removed; task completed'));
  assert.equal((await planningView(root)).tasks.length, 1); assert.ok(task.history.length >= 2);
  assert.ok((await listGoals(root)).every(g => g.status === 'open'));
  assert.equal((await planningView(root)).latest_plan?.stale, true);
  await assert.rejects(async () => (await editTask(root, task.id, task.revision - 1, {}, 'stale')), /Stale/);
  await assert.rejects(async () => (await editTask(root, task.id, task.revision, { links: [{ ...links[0], goal_id: 'missing' }] }, 'bad')), /Unknown goal/);
});

test('proposed/rejected links do not increase priority and unassigned work remains schedulable', async t => {
  const root = await fixture(t), goal = await addGoal(root, { text: 'High priority', weight: 5 });
  const task = await createTask(root, { ...ready(), links: [{ goal_id: goal.id, explanation: 'Unreviewed model claim', origin: 'model', review: 'proposed' }] }, 'proposal');
  const p = await proposePlan(root, day, now); assert.deepEqual(p.explanations[0].goals, []); assert.match(p.explanations[0].reason, /Priority 0/);
  const link = { ...task.links[0], review: 'rejected' };
  await editTask(root, task.id, task.revision, { links: [link] }, 'Incorrect goal association');
  assert.equal((await planningView(root)).goal_progress[0].total, 0);
});

test('legacy action IDs, checklist state and media survive migration into the same task store', async t => {
  const root = await fixture(t), event = await addEvent(root, { title: 'Video', date: day, kind: 'scan', media: 'clip.mp4' });
  const [action] = await syncActions(root, event.id, ['Fill trays']);
  assert.equal((await planningView(root)).tasks[0].id, action.id);
  await setActionStatus(root, action.id, 'done'); assert.equal((await planningView(root)).tasks[0].execution, 'done');
  await setActionStatus(root, action.id, 'open'); assert.equal((await planningView(root)).tasks[0].execution, 'open');
  assert.equal((await syncActions(root, event.id, ['Fill trays'])).length, 1);
});

test('dependencies, fixed commitments and passive waits constrain blocks without blocking the operator during waiting', async t => {
  const root = await fixture(t);
  const stage = await createTask(root, { ...ready('Stage', 30), passive_minutes: 20 }, 'stage');
  const fill = await createTask(root, { ...ready('Fill', 30), dependencies: [stage.id] }, 'fill');
  await createTask(root, { ...ready('Other', 10), resources: [] }, 'other');
  await saveCommitment(root, { id: 'break', title: 'Break', start: at('10:00'), end: at('10:15'), blocking: true, resources: [] });
  const plan = await proposePlan(root, day, now), stageBlock = plan.blocks.find(b => b.task_id === stage.id)!, fillBlock = plan.blocks.find(b => b.task_id === fill.id)!;
  assert.ok(fillBlock.start >= stageBlock.passive_end);
  assert.ok(plan.blocks.every(b => !(b.start < at('10:15') && at('10:00') < b.end)));
  assert.equal(plan.blocks.length, 3);
  await assert.rejects(async () => (await editTask(root, stage.id, stage.revision, { dependencies: [fill.id] }, 'cycle')), /cycle/);
});

test('unknown duration, missing resources, unconfirmed task and infeasible windows explain unscheduled work', async t => {
  const root = await fixture(t);
  await createTask(root, { text: 'Unknown', completion_criteria: 'Inspect' }, 'unknown');
  await createTask(root, { ...ready('Missing tool'), resources: ['unknown-tool'] }, 'tool');
  await createTask(root, { ...ready('Model suggestion'), review: 'proposed' }, 'model');
  await createTask(root, ready('Too long', 500), 'long');
  const plan = await proposePlan(root, day, now); assert.equal(plan.blocks.length, 0); assert.equal(plan.deferred.length, 4);
  assert.equal(plan.next.action, 'inspect');
});

test('single-person capacity, resource reservations and split permission are deterministic', async t => {
  const root = await fixture(t);
  await saveCommitment(root, { id: 'tool-booked', title: 'Tool maintenance', start: at('09:00'), end: at('09:30'), blocking: false, resources: ['scoop'] });
  await saveCommitment(root, { id: 'meeting', title: 'Meeting', start: at('10:00'), end: at('11:00'), blocking: true, resources: [] });
  const task = await createTask(root, { ...ready('Split work', 90), splittable: true }, 'split');
  const p = await proposePlan(root, day, now); assert.equal(p.blocks.length, 2); assert.equal(p.scheduled_minutes, 90); assert.equal(p.blocks[0].start, at('09:30'));
  assert.equal((await proposePlan(root, day, now)).id, p.id);
  await editTask(root, task.id, task.revision, { splittable: false }, 'Cannot interrupt this task');
  assert.equal((await proposePlan(root, day, now)).blocks.length, 0);
});

test('accepted plans are atomic/idempotent and pinned blocks persist across repeated replans', async t => {
  const root = await fixture(t); await createTask(root, ready(), 'task');
  const p = await proposePlan(root, day, now), accepted = await decidePlan(root, p.id, 'accepted', 'Use this plan', now);
  assert.equal((await decidePlan(root, p.id, 'accepted', 'Retry', now)).blocks.length, 1);
  const pinned = await changeBlock(root, accepted.blocks[0].id, accepted.revision, 'pin', 'Fixed time');
  const next = await proposePlan(root, day, now); assert.equal(next.blocks.length, 0); assert.equal(next.preserved.length, 1); assert.equal(next.preserved[0].pinned, true);
  assert.equal((await planningCalendar(root)).filter(e => e.kind === 'task').length, 1);
  assert.equal(pinned.blocks[0].start, accepted.blocks[0].start);
});

test('changed inputs prevent stale acceptance and rejection records no execution', async t => {
  const root = await fixture(t), task = await createTask(root, ready(), 'task'); const p = await proposePlan(root, day, now);
  await editTask(root, task.id, task.revision, { remaining_minutes: 40 }, 'Revised duration');
  await assert.rejects(async () => (await decidePlan(root, p.id, 'accepted', 'stale', now)), /Stale/);
  const p2 = await proposePlan(root, day, now); await decidePlan(root, p2.id, 'rejected', 'Try tomorrow', now);
  assert.equal((await planningView(root)).tasks[0].execution, 'open'); assert.equal((await planningCalendar(root)).length, 0);
});

test('partial actual work retains original estimate/history and releases only its own unpinned reservation', async t => {
  const root = await fixture(t), task = await createTask(root, { ...ready(), quantity: { total: 50, remaining: 50, unit: 'tray' } }, 'task');
  const p = await proposePlan(root, day, now); await decidePlan(root, p.id, 'accepted', 'Start', now);
  const log = { id: 'work-1', start: at('09:00'), end: at('09:40'), outcome: 'Overrun: 20 trays completed', quantity: 20, remaining_minutes: 30, done: false };
  let updated = await recordWork(root, task.id, task.revision, log);
  assert.equal(updated.actuals.length, 1); assert.equal(updated.quantity?.remaining, 30); assert.equal(updated.original_minutes, 30);
  assert.equal((await recordWork(root, task.id, task.revision, log)).actuals.length, 1);
  assert.equal((await planningView(root)).schedule.blocks[0].status, 'released');
  updated = (await editTask(root, updated.id, updated.revision, { execution: 'open' }, 'Resume remaining trays'));
  const p2 = await proposePlan(root, day, at('09:40')); assert.equal(p2.scheduled_minutes, 30); assert.ok(p2.blocks[0].start >= at('09:40'));
  assert.equal(updated.actuals[0].end, at('09:40'));
});

test('date-only deadlines do not reserve capacity; DST gaps/folds are explicit', async t => {
  const root = await fixture(t); await addGoal(root, { text: 'Due today', deadline: day });
  await addEvent(root, { title: 'Historical scan', date: day, time: '09:00', kind: 'scan' });
  await createTask(root, ready(), 'task'); assert.equal((await proposePlan(root, day, now)).blocks[0].start, at('09:00'));
  assert.throws(() => zonedInstant('2026-03-08T02:30', 'America/New_York'), /does not exist/);
  assert.throws(() => zonedInstant('2026-11-01T01:30', 'America/New_York'), /occurs twice/);
  const early = zonedInstant('2026-11-01T01:30', 'America/New_York', 'earlier'), late = zonedInstant('2026-11-01T01:30', 'America/New_York', 'later');
  assert.equal(Date.parse(late) - Date.parse(early), 3600000); assert.equal(localParts(late, 'America/New_York').time, '01:30');
});

test('elapsed reservations cannot establish completion or unlock dependent work', async t => {
  const root = await fixture(t), first = await createTask(root, ready('Stage', 30), 'stage');
  await createTask(root, { ...ready('Fill'), dependencies: [first.id] }, 'fill');
  const p = await proposePlan(root, day, now); await decidePlan(root, p.id, 'accepted', 'Try this order', now);
  const later = await proposePlan(root, day, at('09:35'));
  assert.ok(later.deferred.some(d => d.task_id === first.id && /elapsed/.test(d.reason)));
  assert.ok(later.conflicts.some(c => /prerequisites/.test(c)));
  assert.equal((await planningView(root)).tasks.find(t => t.id === first.id)?.execution, 'open');
});

test('changed availability and resource reservations conflict with accepted blocks instead of moving them', async t => {
  const root = await fixture(t); await createTask(root, ready(), 'work'); const p = await proposePlan(root, day, now);
  await decidePlan(root, p.id, 'accepted', 'Accept', now);
  await saveCommitment(root, { id: 'tool', title: 'Unexpected tool use', start: at('09:00'), end: at('10:00'), resources: ['scoop'], blocking: false });
  const next = await proposePlan(root, day, now); assert.ok(next.conflicts.some(c => /resources/.test(c))); assert.equal(next.preserved[0].start, p.blocks[0].start);
});

test('goal priority corrections preserve historical plan inputs and invalidate the current recommendation', async t => {
  const root = await fixture(t), goal = await addGoal(root, { text: 'Seed trays', weight: 2 });
  await createTask(root, { ...ready(), links: [{ goal_id: goal.id, explanation: 'Fills trays for seeding', origin: 'human', review: 'confirmed' }] }, 'task');
  const plan = await proposePlan(root, day, now), current = (await planningView(root)).goals[0];
  await decidePlan(root, plan.id, 'accepted', 'Original plan accepted', now);
  await planningCommand(root, { command: 'goal', id: goal.id, expected: current, patch: { weight: 5, deadline: '2026-10-19', success_criteria: '50 trays inspected' }, reason: 'Deadline moved closer' });
  assert.equal((await planningView(root)).latest_plan?.stale, true);
  const historical = (await planningCommand(root, { command: 'plan', id: plan.id })) as typeof plan;
  assert.equal(historical.input_snapshot.goals[0].weight, 2);
  assert.equal((await planningView(root)).goals[0].weight, 5);
  assert.ok((await proposePlan(root, day, now)).conflicts.some(c => /deadline/.test(c)));
  await assert.rejects(async () => (await planningCommand(root, { command: 'goal', id: goal.id, expected: current, patch: { weight: 1 }, reason: 'stale' })), /Stale/);
});

