/** Single-person task planning over the existing actions/events/goals store. */
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { withDb } from './db.js';
import { instant, localParts, validDay, validZone, zonedInstant } from './planning-time.js';

export class PlanningError extends Error {}
export type Execution = 'open' | 'in_progress' | 'paused' | 'blocked' | 'done' | 'cancelled';
export interface GoalLink { goal_id: string; explanation: string; origin: 'human' | 'model'; review: 'proposed' | 'confirmed' | 'rejected'; revision: number }
export interface Interval { start: string; end: string }
export interface WorkLog extends Interval { id: string; outcome: string; quantity: number | null }
export interface Task {
  id: string; event_id: string; text: string; revision: number; execution: Execution;
  review: 'proposed' | 'confirmed' | 'rejected'; links: GoalLink[]; dependencies: string[];
  active_minutes: number | null; remaining_minutes: number | null; original_minutes: number | null;
  setup_minutes: number; travel_minutes: number; passive_minutes: number; estimate_source: string;
  splittable: boolean; resources: string[]; preconditions: Array<{ text: string; status: 'met' | 'unmet' | 'unknown' }>;
  person: string; location: string; completion_criteria: string; deadline: string | null; window: Interval | null;
  process: { id: string; revision: number; step_id: string } | null;
  quantity: { total: number; remaining: number; unit: string } | null;
  defer_until: string | null; actuals: WorkLog[]; history: Array<{ at: string; reason: string; before: unknown }>;
}
export interface PlanningConfig { timezone: string; availability: Interval[]; resources: Record<string, 'available' | 'unavailable' | 'unknown'>; max_minutes: number; person: string }
export interface TaskBlock extends Interval { id: string; task_id: string; task_revision: number; active_minutes: number; passive_end: string; resources: string[]; status: 'accepted' | 'released'; pinned: boolean; plan_id: string }
export interface Schedule { revision: number; config: PlanningConfig; blocks: TaskBlock[]; decisions: Array<{ plan_id: string; decision: 'accepted' | 'rejected' | 'released' | 'pinned'; reason: string; at: string }> }
export interface GoalRow { id: string; text: string; weight: number; deadline: string | null; status: string; success_criteria: string }
export interface TimedEvent { id: string; title: string; timing: (Interval & { blocking: boolean; resources: string[] }) | null }
export interface Snapshot { tasks: Task[]; goals: GoalRow[]; events: TimedEvent[]; schedule: Schedule; process_revisions: Record<string, number>; superseded_process_ids: string[] }
export interface TaskPlan {
  schema: 'human-plan/1'; id: string; policy: 'single-person-greedy/1'; input_digest: string; now: string; day: string;
  timezone: string; blocks: TaskBlock[]; preserved: TaskBlock[]; deferred: Array<{ task_id: string; reason: string }>;
  input_snapshot: Snapshot;
  conflicts: string[]; explanations: Array<{ task_id: string; goals: string[]; reason: string }>;
  next: { action: 'work' | 'wait' | 'inspect' | 'defer'; task_id: string | null; reason: string };
  available_minutes: number; scheduled_minutes: number; stale?: boolean;
}
const defaultSchedule = (): Schedule => ({ revision: 1, config: { timezone: 'UTC', availability: [], resources: {}, max_minutes: 480, person: 'operator' }, blocks: [], decisions: [] });
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new PlanningError(message); }
function object(value: unknown): Record<string, unknown> { check(value && typeof value === 'object' && !Array.isArray(value), 'Expected an object.'); return value as Record<string, unknown>; }
function words(value: unknown, label: string, empty = false): asserts value is string { check(typeof value === 'string' && (empty || !!value.trim()) && value.length <= 2000, `${label} is required and must be short text.`); }
function minutes(n: unknown, nullable = false): void { check(nullable && n === null || typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100000, 'Minutes must be finite and nonnegative.'); }
function uniqueStrings(value: unknown): asserts value is string[] { check(Array.isArray(value) && value.length <= 100 && value.every(v => typeof v === 'string' && !!v.trim() && v.length <= 200) && new Set(value).size === value.length, 'Expected unique short identifiers.'); }
function interval(raw: unknown): Interval { const r = object(raw); const start = instant(r.start as string), end = instant(r.end as string); check(start < end, 'Interval end must follow start.'); return { start, end }; }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function doc<T>(db: DatabaseSync, key: string, fallback: T): T { const row = db.prepare('SELECT body FROM docs WHERE key=?').get(key) as { body: string } | undefined; return row ? JSON.parse(row.body) as T : fallback; }
function saveDoc(db: DatabaseSync, key: string, value: unknown): void { db.prepare('INSERT INTO docs VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at').run(key, JSON.stringify(value), new Date().toISOString()); }
function atomic<T>(root: string, fn: (db: DatabaseSync) => T): T {
  return withDb(root, db => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(db); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } });
}
/** Extend old checklist rows lazily without changing IDs, media or done state. */
/** Read canonical tasks on an existing transaction for evidence reconciliation. */
export function tasks(db: DatabaseSync): Task[] {
  return (db.prepare('SELECT * FROM actions ORDER BY id').all() as unknown as Array<{ id: string; event_id: string; text: string; status: string; task_rev: number; task_json: string | null }>).map(row => {
    const base: Task = { id: row.id, event_id: row.event_id, text: row.text, revision: row.task_rev, execution: row.status === 'done' ? 'done' : 'open',
      review: row.status === 'done' ? 'confirmed' : 'proposed', links: [], dependencies: [], active_minutes: null, remaining_minutes: null, original_minutes: null,
      setup_minutes: 0, travel_minutes: 0, passive_minutes: 0, estimate_source: '', splittable: false, resources: [], preconditions: [], person: 'operator', location: '', completion_criteria: '', deadline: null, window: null, process: null, quantity: null, defer_until: null, actuals: [], history: [] };
    const t = row.task_json ? { ...base, ...JSON.parse(row.task_json), id: row.id, event_id: row.event_id, text: row.text, revision: row.task_rev } as Task : base;
    if (row.status === 'done') t.execution = 'done'; else if (t.execution === 'done') t.execution = 'open';
    return t;
  });
}
function snapshot(db: DatabaseSync): Snapshot {
  const events = (db.prepare('SELECT id,title,timing_json FROM events WHERE timing_json IS NOT NULL ORDER BY id').all() as unknown as Array<{ id: string; title: string; timing_json: string | null }>).map(e => ({ id: e.id, title: e.title, timing: e.timing_json ? JSON.parse(e.timing_json) : null }));
  return { tasks: tasks(db), goals: db.prepare('SELECT id,text,weight,deadline,status,success_criteria FROM goals ORDER BY id').all() as unknown as GoalRow[], events,
    schedule: doc(db, 'human-schedule', defaultSchedule()), superseded_process_ids: (db.prepare("SELECT key FROM docs WHERE key LIKE 'superseded-process:%' ORDER BY key").all() as unknown as {key:string}[]).map(r=>r.key.slice('superseded-process:'.length)), process_revisions: Object.fromEntries((db.prepare('SELECT id,MAX(rev) as rev FROM processes GROUP BY id ORDER BY id').all() as unknown as Array<{ id: string; rev: number }>).map(p => [p.id, p.rev])) };
}
function saveTask(db: DatabaseSync, task: Task): void { db.prepare('UPDATE actions SET text=?,status=?,task_json=?,task_rev=?,updated_at=? WHERE id=?').run(task.text, task.execution === 'done' ? 'done' : 'open', JSON.stringify(task), task.revision, new Date().toISOString(), task.id); }
function validateTask(db: DatabaseSync, task: Task, all: Task[]): void {
  words(task.text, 'Task title'); words(task.completion_criteria, 'Completion criteria', true); words(task.estimate_source, 'Estimate source', true); words(task.person, 'Person'); words(task.location, 'Location', true);
  check(['open', 'in_progress', 'paused', 'blocked', 'done', 'cancelled'].includes(task.execution), 'Invalid execution state.');
  check(['proposed', 'confirmed', 'rejected'].includes(task.review), 'Invalid task review.');
  for (const key of ['active_minutes', 'remaining_minutes', 'original_minutes'] as const) minutes(task[key], true);
  for (const key of ['setup_minutes', 'travel_minutes', 'passive_minutes'] as const) minutes(task[key]);
  if (task.active_minutes !== null || task.remaining_minutes !== null) words(task.estimate_source, 'Estimate source');
  check(typeof task.splittable === 'boolean', 'Splittable must be true or false.');
  uniqueStrings(task.resources); uniqueStrings(task.dependencies);
  check(task.dependencies.every(id => id !== task.id && all.some(t => t.id === id)), 'Unknown or self dependency.');
  if (task.deadline !== null) validDay(task.deadline);
  if (task.window !== null) task.window = interval(task.window);
  if (task.defer_until !== null) task.defer_until = instant(task.defer_until);
  check(Array.isArray(task.links), 'Goal links must be an array.');
  const goals = new Set((db.prepare('SELECT id FROM goals').all() as unknown as Array<{ id: string }>).map(g => g.id));
  uniqueStrings(task.links.map(l => l.goal_id));
  for (const l of task.links) { check(goals.has(l.goal_id), 'Unknown goal reference.'); words(l.explanation, 'Goal contribution'); check(['human', 'model'].includes(l.origin) && ['proposed', 'confirmed', 'rejected'].includes(l.review), 'Invalid goal link review.'); }
  check(Array.isArray(task.preconditions) && task.preconditions.length <= 100, 'Invalid preconditions.');
  for (const p of task.preconditions) { words(p.text, 'Precondition'); check(['met', 'unmet', 'unknown'].includes(p.status), 'Invalid precondition state.'); }
  if (task.quantity !== null) { const q = task.quantity; check(Number.isFinite(q.total) && q.total > 0 && Number.isFinite(q.remaining) && q.remaining >= 0 && q.remaining <= q.total, 'Invalid quantity.'); words(q.unit, 'Quantity unit'); }
  if (task.process !== null) {
    const p = task.process; const row = db.prepare('SELECT body FROM processes WHERE id=? AND rev=?').get(p.id, p.revision) as { body: string } | undefined;
    check(row && JSON.parse(row.body).steps.some((s: { id: string }) => s.id === p.step_id), 'Unknown process revision or step.');
  }
  const edges = new Map(all.map(t => [t.id, t.id === task.id ? task.dependencies : t.dependencies])); edges.set(task.id, task.dependencies);
  const visit = (id: string, stack: Set<string>, done: Set<string>): void => { check(!stack.has(id), 'Task dependency cycle.'); if (done.has(id)) return; stack.add(id); for (const d of edges.get(id) ?? []) visit(d, stack, done); stack.delete(id); done.add(id); };
  const done = new Set<string>(); for (const id of edges.keys()) visit(id, new Set(), done);
}
const EDITABLE = new Set(['text', 'execution', 'review', 'links', 'dependencies', 'active_minutes', 'remaining_minutes', 'setup_minutes', 'travel_minutes', 'passive_minutes', 'estimate_source', 'splittable', 'resources', 'preconditions', 'person', 'location', 'completion_criteria', 'deadline', 'window', 'process', 'quantity', 'defer_until']);
/** Apply a validated task patch within the caller’s transaction. */
export function update(db: DatabaseSync, task: Task, raw: unknown, reason: string): Task {
  const patch = object(raw); check(Object.keys(patch).every(k => EDITABLE.has(k)), 'Unknown or immutable task field.'); words(reason, 'Change reason');
  const next = { ...task, ...patch, revision: task.revision + 1 } as Task;
  if (task.original_minutes === null && next.active_minutes !== null) next.original_minutes = next.active_minutes;
  if ('active_minutes' in patch && !('remaining_minutes' in patch) && task.remaining_minutes === null) next.remaining_minutes = next.active_minutes;
  if ('links' in patch) { check(Array.isArray(next.links), 'Invalid links.'); next.links = next.links.map(l => ({ ...l, revision: next.revision })); }
  next.history = [...task.history, { at: new Date().toISOString(), reason, before: Object.fromEntries(Object.keys(patch).map(k => [k, (task as unknown as Record<string, unknown>)[k]])) }];
  validateTask(db, next, tasks(db)); saveTask(db, next); return next;
}
/** Create one manual/reviewed proposal in the existing action table; a caller key makes retries idempotent. */
export function createTask(root: string, raw: unknown, requestId: string): Task {
  return atomic(root, db => createTaskInDb(db, raw, requestId));
}
/** Create a canonical task inside an enclosing workflow transaction. */
export function createTaskInDb(db: DatabaseSync, raw: unknown, requestId: string): Task {
  words(requestId, 'Request ID'); const patch = object(raw);
  const key = `task-create:${hash(requestId)}`, prior = doc<{ id: string; digest: string } | null>(db, key, null);
  if (prior) { check(prior.digest === hash(patch), 'Request ID already used with different task input.'); return tasks(db).find(t => t.id === prior.id)!; }
  const id = randomUUID(), now = new Date().toISOString(), eventId = `manual-${id}`;
  db.prepare('INSERT INTO events(id,title,date,kind,created_at) VALUES(?,?,?,?,?)').run(eventId, 'Manual task', now.slice(0, 10), 'note', now);
  db.prepare('INSERT INTO actions(id,event_id,idx,text,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id, eventId, 0, String(patch.text ?? ''), 'open', now, now);
  const initial = tasks(db).find(t => t.id === id)!; initial.review = 'confirmed';
  const task = update(db, initial, patch, 'Task created'); saveDoc(db, key, { id, digest: hash(patch) }); return task;
}

/** Revision-checked correction; links never create duplicate task records. */
export function editTask(root: string, id: string, revision: number, patch: unknown, reason: string): Task {
  return atomic(root, db => { const task = tasks(db).find(t => t.id === id); check(task, 'Task not found.'); check(task.revision === revision, 'Stale task revision.'); return update(db, task, patch, reason); });
}
/** Append actual work once, record explicit remaining estimates, and retire this task's unpinned future reservations. */
export function recordWork(root: string, id: string, revision: number, raw: unknown): Task {
  return atomic(root, db => {
    const task = tasks(db).find(t => t.id === id); check(task, 'Task not found.'); const input = object(raw); words(input.id, 'Work log ID');
    const entry: WorkLog = { ...interval(input), id: input.id, outcome: String(input.outcome ?? ''), quantity: input.quantity === undefined ? null : input.quantity as number };
    words(entry.outcome, 'Work outcome'); if (entry.quantity !== null) check(Number.isFinite(entry.quantity) && entry.quantity >= 0, 'Invalid completed quantity.');
    const prior = task.actuals.find(a => a.id === entry.id);
    if (prior) { check(hash(prior) === hash(entry), 'Work log ID reused with different evidence.'); return task; }
    check(task.revision === revision, 'Stale task revision.');
    check(!tasks(db).some(t => t.actuals.some(a => a.start < entry.end && entry.start < a.end)), 'Actual work intervals overlap for the single operator.');
    check(Date.parse(entry.end) <= Date.now(), 'Actual work cannot end in the future.');
    minutes(input.remaining_minutes); check(typeof input.done === 'boolean', 'Specify whether work is done.');
    check(!input.done || input.remaining_minutes === 0, 'Done work must have zero remaining minutes.');
    const patch: Record<string, unknown> = { remaining_minutes: input.remaining_minutes, execution: input.done ? 'done' : 'paused' };
    if (task.quantity && entry.quantity !== null) patch.quantity = { ...task.quantity, remaining: Math.max(0, task.quantity.remaining - entry.quantity) };
    const next = update(db, task, patch, entry.outcome); next.actuals.push(entry); saveTask(db, next);
    const schedule = doc(db, 'human-schedule', defaultSchedule());
    for (const block of schedule.blocks) if (block.task_id === id && block.status === 'accepted' && !block.pinned && block.end > entry.start) block.status = 'released';
    schedule.revision++; saveDoc(db, 'human-schedule', schedule); return next;
  });
}
/** Replace explicitly supplied work windows/preferences with optimistic concurrency. */
export function configurePlanning(root: string, revision: number, raw: unknown): Schedule {
  return atomic(root, db => {
    const schedule = doc(db, 'human-schedule', defaultSchedule()); check(schedule.revision === revision, 'Stale schedule revision.');
    const v = object(raw); words(v.timezone, 'Timezone'); validZone(v.timezone); words(v.person, 'Person'); minutes(v.max_minutes); check((v.max_minutes as number) > 0, 'Work limit must be positive.');
    check(Array.isArray(v.availability) && v.availability.length <= 100, 'Provide up to 100 working intervals.');
    const availability = v.availability.map(interval).sort((a, b) => a.start.localeCompare(b.start));
    check(availability.every((a, i) => !i || availability[i - 1].end <= a.start), 'Working intervals overlap.');
    const resources = object(v.resources); check(Object.values(resources).every(s => ['available', 'unavailable', 'unknown'].includes(String(s))), 'Invalid resource availability.');
    schedule.config = { timezone: v.timezone, person: v.person, max_minutes: v.max_minutes as number, availability, resources: resources as PlanningConfig['resources'] };
    schedule.revision++; saveDoc(db, 'human-schedule', schedule); return schedule;
  });
}
/** Store fixed commitments/breaks as timed versions of existing calendar events. */
export function saveCommitment(root: string, raw: unknown): TimedEvent {
  const v = object(raw); words(v.id, 'Commitment ID'); words(v.title, 'Commitment title'); check(typeof v.blocking === 'boolean', 'Blocking must be true or false.'); uniqueStrings(v.resources ?? []);
  const timing = { ...interval(v), blocking: v.blocking, resources: (v.resources ?? []) as string[] };
  return atomic(root, db => {
    const id = `commitment-${v.id}`, schedule = doc(db, 'human-schedule', defaultSchedule()); const p = localParts(timing.start, schedule.config.timezone);
    db.prepare('INSERT INTO events(id,title,date,time,kind,created_at,timing_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,date=excluded.date,time=excluded.time,timing_json=excluded.timing_json').run(id, v.title as string, p.day, p.time, 'note', new Date().toISOString(), JSON.stringify(timing));
    return { id, title: v.title as string, timing };
  });
}

const ms = (t: string): number => Date.parse(t);
const iso = (t: number): string => new Date(t).toISOString();
const overlap = (a: Interval, b: Interval): boolean => a.start < b.end && b.start < a.end;
/** Greedy, reproducible plan: maximum confirmed goal weight, earliest deadline, dependents unlocked, setup/travel cost, ID. */
function calculate(s: Snapshot, day: string, now: string): TaskPlan {
  validDay(day); now = instant(now); const zone = s.schedule.config.timezone;
  const begin = zonedInstant(`${day}T00:00`, zone), nextDate = new Date(`${day}T00:00Z`); nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  const end = zonedInstant(`${nextDate.toISOString().slice(0, 10)}T00:00`, zone);
  const windows = s.schedule.config.availability.map(w => ({ start: iso(Math.max(ms(w.start), ms(begin), ms(now))), end: iso(Math.min(ms(w.end), ms(end))) })).filter(w => w.start < w.end);
  const input = hash(s), id = hash({ input, day, now });
  const preserved = s.schedule.blocks.filter(b => b.status === 'accepted' && b.passive_end > now && b.start < end);
  const plan: TaskPlan = { schema: 'human-plan/1', id, policy: 'single-person-greedy/1', input_digest: input, input_snapshot: s, now, day, timezone: zone, blocks: [], preserved, deferred: [], conflicts: [], explanations: [], next: { action: 'inspect', task_id: null, reason: 'Review unscheduled work.' }, available_minutes: 0, scheduled_minutes: 0 };
  const occupied: Array<Interval & { resources: string[]; person: boolean }> = s.events.filter(e => e.timing).map(e => ({ ...e.timing!, person: e.timing!.blocking }));
  for (const t of s.tasks) for (const a of t.actuals) occupied.push({ ...a, person: true, resources: t.resources });
  for (const b of preserved) { occupied.push({ start: b.start, end: b.end, person: true, resources: b.resources }); if (b.passive_end > b.end) occupied.push({ start: b.end, end: b.passive_end, person: false, resources: b.resources }); }
  for (let i = 0; i < preserved.length; i++) {
    const b = preserved[i], t = s.tasks.find(t => t.id === b.task_id);
    if (!t || t.revision !== b.task_revision || ['done', 'cancelled', 'blocked', 'paused'].includes(t.execution)) plan.conflicts.push(`Accepted block for ${t?.text ?? b.task_id} needs review after a task change.`);
    if (!s.schedule.config.availability.some(w => w.start <= b.start && w.end >= b.end)) plan.conflicts.push(`Accepted block for ${t?.text} is outside working hours.`);
    if (s.events.some(e => e.timing?.blocking && overlap(b, e.timing))) plan.conflicts.push(`Accepted block for ${t?.text} conflicts with a commitment.`);
    if (t && (t.resources.some(r => s.schedule.config.resources[r] !== 'available') || t.preconditions.some(p => p.status !== 'met') || t.review !== 'confirmed')) plan.conflicts.push(`Accepted block for ${t.text} has unconfirmed prerequisites/resources.`);
    if (s.events.some(e => e.timing && e.timing.resources.some(r => b.resources.includes(r)) && overlap({ start: b.start, end: b.passive_end }, e.timing))) plan.conflicts.push(`Accepted resources for ${t?.text} conflict with a reservation.`);
    if (preserved.slice(i + 1).some(other => overlap(b, other))) plan.conflicts.push('Accepted task blocks overlap.');
  }
  // Capacity is a union subtraction, so overlapping commitments are never counted twice.
  function slots(resourceIds: string[], earliest: number): Array<{ start: number; end: number }> {
    let free = windows.map(w => ({ start: Math.max(ms(w.start), earliest), end: ms(w.end) })).filter(w => w.start < w.end);
    for (const busy of occupied.filter(b => b.person || b.resources.some(r => resourceIds.includes(r)))) {
      free = free.flatMap(w => ! (w.start < ms(busy.end) && ms(busy.start) < w.end) ? [w] : [{ start: w.start, end: Math.min(w.end, ms(busy.start)) }, { start: Math.max(w.start, ms(busy.end)), end: w.end }].filter(x => x.start < x.end));
    }
    return free;
  }
  plan.available_minutes = slots([], ms(now)).reduce((n, w) => n + (w.end - w.start) / 60000, 0);
  const confirmed = (t: Task): GoalRow[] => t.links.filter(l => l.review === 'confirmed').flatMap(l => s.goals.filter(g => g.id === l.goal_id && g.status !== 'done'));
  const deadline = (t: Task): string => [t.deadline, ...confirmed(t).map(g => g.deadline)].filter((d): d is string => !!d).sort()[0] ?? '9999-12-31';
  for (const b of preserved) {
    const t = s.tasks.find(t => t.id === b.task_id); if (!t) continue;
    if (localParts(b.passive_end, zone).day > deadline(t) || t.window && (b.start < t.window.start || b.passive_end > t.window.end)) plan.conflicts.push(`Accepted block for ${t.text} violates its current deadline/window.`);
    if (t.person !== s.schedule.config.person || t.process && (s.process_revisions[t.process.id] !== t.process.revision || s.superseded_process_ids.includes(t.process.id))) plan.conflicts.push(`Accepted block for ${t.text} needs person/process review.`);
  }
  const priority = (t: Task): number => Math.max(0, ...confirmed(t).map(g => g.weight));
  const unlocks = (t: Task): number => s.tasks.filter(other => other.dependencies.includes(t.id)).length;
  const ordered = s.tasks.filter(t => !['done', 'cancelled'].includes(t.execution)).sort((a, b) => priority(b) - priority(a) || deadline(a).localeCompare(deadline(b)) || unlocks(b) - unlocks(a) || (a.setup_minutes + a.travel_minutes) - (b.setup_minutes + b.travel_minutes) || a.id.localeCompare(b.id));
  const completion = new Map(s.tasks.filter(t => t.execution === 'done').map(t => [t.id, t.actuals.length ? Math.max(...t.actuals.map(a => ms(a.end))) + t.passive_minutes * 60000 : ms(now)]));
  const pending = new Set(ordered.map(t => t.id));
  let budget = s.schedule.config.max_minutes - preserved.reduce((n, b) => n + Math.max(0, Math.min(ms(b.end), ms(end)) - Math.max(ms(b.start), ms(begin), ms(now))) / 60000, 0) - s.tasks.flatMap(t => t.actuals).reduce((n, a) => n + Math.max(0, Math.min(ms(a.end), ms(end)) - Math.max(ms(a.start), ms(begin))) / 60000, 0);
  if (budget < 0) plan.conflicts.push('Accepted work and actuals exceed the daily work limit.');
  const defer = (t: Task, reason: string): void => { plan.deferred.push({ task_id: t.id, reason }); pending.delete(t.id); };
  for (let round = 0; pending.size && round <= ordered.length; round++) {
    let progress = false;
    for (const t of ordered.filter(t => pending.has(t.id))) {
      const invalid = t.review !== 'confirmed' ? 'Confirm this task before planning.' : ['paused', 'blocked'].includes(t.execution) ? `Task is ${t.execution}; resume or resolve the blocker.` : t.person !== s.schedule.config.person ? 'Required person is not available in this single-person plan.' : !t.completion_criteria.trim() ? 'Add completion criteria.' : t.remaining_minutes === null ? 'Provide remaining active minutes and estimate source.' : t.preconditions.some(p => p.status !== 'met') ? 'A required precondition is unmet or unknown.' : t.resources.some(r => s.schedule.config.resources[r] !== 'available') ? 'Required resource availability is missing or blocked.' : t.process && (s.process_revisions[t.process.id] !== t.process.revision || s.superseded_process_ids.includes(t.process.id)) ? 'Process reference is stale; review the task.' : deadline(t) < day ? 'Deadline is already past; review priorities or deadline.' : null;
      if (invalid) { defer(t, invalid); progress = true; continue; }
      if (s.schedule.blocks.some(b => b.status === 'accepted' && b.task_id === t.id && b.end <= now)) { defer(t, 'An accepted interval elapsed without a completion update. Record actual work or release the reservation.'); progress = true; continue; }
      if (t.dependencies.some(d => pending.has(d) && !completion.has(d))) continue;
      if (t.dependencies.some(d => !completion.has(d))) { defer(t, 'Prerequisite is unfinished, unscheduled, or blocked.'); progress = true; continue; }
      const locked = preserved.filter(b => b.task_id === t.id);
      if (locked.some(b => b.task_revision !== t.revision)) { defer(t, 'Review or release the changed task’s accepted blocks.'); progress = true; continue; }
      const already = locked.reduce((n, b) => n + b.active_minutes, 0), remaining = Math.max(0, t.remaining_minutes! - already);
      if (remaining === 0 && locked.length) { completion.set(t.id, Math.max(...locked.map(b => ms(b.passive_end)))); pending.delete(t.id); progress = true; continue; }
      if (remaining === 0) { defer(t, 'Zero remaining estimate is not proof of completion; record an outcome.'); progress = true; continue; }
      let earliest = Math.max(ms(now), ...t.dependencies.map(d => completion.get(d)!), t.defer_until ? ms(t.defer_until) : 0, t.window ? ms(t.window.start) : 0, ...locked.map(b => ms(b.passive_end)));
      const proposed: TaskBlock[] = []; let left = remaining; const overhead = locked.length ? 0 : t.setup_minutes + t.travel_minutes;
      for (const slot of slots(t.resources, earliest)) {
        const stop = Math.min(slot.end, t.window ? ms(t.window.end) : Infinity), extra = proposed.length ? 0 : overhead;
        const capacity = Math.min((stop - slot.start) / 60000 - extra, budget - proposed.reduce((n, b) => n + (ms(b.end) - ms(b.start)) / 60000, 0) - extra);
        if (capacity < 1 || !t.splittable && capacity < left) continue;
        const active = Math.min(left, Math.floor(capacity)), finish = slot.start + (active + extra) * 60000;
        proposed.push({ id: hash({ id, task: t.id, index: proposed.length }), task_id: t.id, task_revision: t.revision, start: iso(slot.start), end: iso(finish), passive_end: iso(finish), active_minutes: active, resources: t.resources, status: 'accepted', pinned: false, plan_id: id });
        left -= active; if (!left) break;
      }
      if (left > 0) { defer(t, `Insufficient available time: ${left} active minutes remain unallocated. No partial proposal was committed.`); progress = true; continue; }
      const last = proposed[proposed.length - 1]; last.passive_end = iso(ms(last.end) + t.passive_minutes * 60000);
      if (localParts(last.passive_end, zone).day > deadline(t) || t.window && last.passive_end > t.window.end) { defer(t, 'Active work and passive wait cannot finish within the deadline/window.'); progress = true; continue; }
      if (occupied.some(b => b.resources.some(r => t.resources.includes(r)) && overlap({ start: last.end, end: last.passive_end }, b))) { defer(t, 'Passive wait would overlap a required resource reservation.'); progress = true; continue; }
      for (const b of proposed) occupied.push({ ...b, person: true });
      if (last.passive_end > last.end) occupied.push({ start: last.end, end: last.passive_end, resources: t.resources, person: false });
      plan.blocks.push(...proposed); const used = proposed.reduce((n, b) => n + (ms(b.end) - ms(b.start)) / 60000, 0); budget -= used;
      plan.explanations.push({ task_id: t.id, goals: confirmed(t).map(g => g.id), reason: `Priority ${priority(t)} (maximum confirmed goal weight; shared tasks counted once). Prerequisites scheduled/done; resources confirmed. ${used} operator minutes, ${t.passive_minutes} passive minutes. Estimate: ${t.estimate_source}.` });
      completion.set(t.id, ms(last.passive_end)); pending.delete(t.id); progress = true;
    }
    if (!progress) break;
  }
  for (const t of ordered.filter(t => pending.has(t.id))) defer(t, 'Unresolved prerequisite chain.');
  for (const b of preserved) {
    const t = s.tasks.find(t => t.id === b.task_id);
    if (t?.dependencies.some(d => !completion.has(d) || completion.get(d)! > ms(b.start))) plan.conflicts.push(`Accepted block for ${t.text} starts before its prerequisites can finish.`);
  }
  plan.blocks.sort((a, b) => a.start.localeCompare(b.start));
  plan.scheduled_minutes = plan.blocks.reduce((n, b) => n + (ms(b.end) - ms(b.start)) / 60000, 0);
  const first = [...plan.blocks, ...preserved].sort((a, b) => a.start.localeCompare(b.start))[0];
  plan.next = plan.conflicts.length ? { action: 'inspect', task_id: null, reason: plan.conflicts[0] } : first ? { action: first.start <= now ? 'work' : 'wait', task_id: first.task_id, reason: first.start <= now ? 'This block fits the reviewed plan; start only after accepting proposed work.' : `Next available block begins ${first.start}.` } : { action: plan.deferred.length ? 'inspect' : 'defer', task_id: null, reason: plan.deferred[0]?.reason ?? 'No unfinished tasks to schedule.' };
  return plan;
}
/** Generate an immutable proposal; unchanged inputs/time yield the same plan identity. */
export function proposePlan(root: string, day: string, now: string): TaskPlan { return atomic(root, db => { const plan = calculate(snapshot(db), day, now); saveDoc(db, `human-plan:${plan.id}`, plan); saveDoc(db, 'human-plan-latest', plan.id); return plan; }); }
/** Accept/reject atomically. Retry is idempotent; changed inputs or elapsed proposed starts require replanning. */
export function decidePlan(root: string, id: string, decision: 'accepted' | 'rejected', reason: string, now = new Date().toISOString()): Schedule {
  return atomic(root, db => {
    words(reason, 'Decision reason'); check(['accepted', 'rejected'].includes(decision), 'Invalid plan decision.');
    const s = snapshot(db), prior = s.schedule.decisions.find(d => d.plan_id === id && ['accepted', 'rejected'].includes(d.decision));
    if (prior) { check(prior.decision === decision, 'Plan already decided differently; make a new proposal.'); return s.schedule; }
    const plan = doc<TaskPlan | null>(db, `human-plan:${id}`, null); check(plan, 'Plan not found.');
    check(plan.input_digest === hash(s), 'Stale plan; replan before deciding.');
    if (decision === 'accepted') {
      check(!plan.conflicts.length, 'Resolve accepted-block conflicts before accepting.');
      check(plan.blocks.every(b => b.start >= instant(now)), 'A proposed start is in the past; replan.');
      s.schedule.blocks.push(...plan.blocks);
    }
    s.schedule.decisions.push({ plan_id: id, decision, reason, at: instant(now) }); s.schedule.revision++; saveDoc(db, 'human-schedule', s.schedule); return s.schedule;
  });
}
/** Explicitly pin or release an accepted block; historical blocks/decisions are retained. */
export function changeBlock(root: string, id: string, revision: number, action: 'pin' | 'release', reason: string): Schedule {
  return atomic(root, db => { words(reason, 'Change reason'); const s = doc(db, 'human-schedule', defaultSchedule()); check(s.revision === revision, 'Stale schedule revision.'); const block = s.blocks.find(b => b.id === id); check(block && block.status === 'accepted', 'Accepted block not found.'); check(['pin', 'release'].includes(action), 'Invalid block action.'); if (action === 'pin') block.pinned = true; else block.status = 'released'; s.decisions.push({ plan_id: block.plan_id, decision: action === 'pin' ? 'pinned' : 'released', reason, at: new Date().toISOString() }); s.revision++; saveDoc(db, 'human-schedule', s); return s; });
}
/** Shared UI/CLI view: confirmed goal relationships, separate outcome status and calendar reservations. */
export function planningView(root: string): Snapshot & { latest_plan: TaskPlan | null; goal_progress: Array<{ goal_id: string; total: number; completed: number; outcome: string }> } {
  return withDb(root, db => {
    const s = snapshot(db), id = doc<string | null>(db, 'human-plan-latest', null), plan = id ? doc<TaskPlan | null>(db, `human-plan:${id}`, null) : null;
    if (plan) plan.stale = plan.input_digest !== hash(s);
    return { ...s, latest_plan: plan, goal_progress: s.goals.map(g => { const linked = s.tasks.filter(t => t.links.some(l => l.goal_id === g.id && l.review === 'confirmed')); return { goal_id: g.id, total: linked.length, completed: linked.filter(t => t.execution === 'done').length, outcome: g.status === 'done' ? 'operator marked outcome complete' : 'outcome not verified' }; }) };
  });
}
/** Add accepted/proposed task blocks to the existing calendar without hiding commitments. */
export function planningCalendar(root: string): Array<Record<string, unknown>> {
  const view = planningView(root), accepted = view.schedule.blocks.filter(b => b.status === 'accepted');
  const proposed = view.latest_plan && !view.latest_plan.stale ? view.latest_plan.blocks.filter(b => !accepted.some(a => a.id === b.id)) : [];
  return [...accepted.map(b => ({ ...b, scheduling: 'accepted' })), ...proposed.map(b => ({ ...b, scheduling: 'proposed' }))].map(b => {
    const task = view.tasks.find(t => t.id === b.task_id)!; const p = localParts(b.start, view.schedule.config.timezone);
    return { id: `task-block-${b.id}`, task_id: b.task_id, title: task?.text ?? b.task_id, date: p.day, time: p.time, kind: 'task', scheduling: b.scheduling, execution: task?.execution, start: b.start, end: b.end, pinned: b.pinned, goal_ids: task?.links.filter(l => l.review === 'confirmed').map(l => l.goal_id) ?? [], detail: `${b.scheduling} · ${view.schedule.config.timezone} · ${task?.execution}`, payload: null, media: null, created_at: '' };
  });
}
/** Versioned command boundary shared by the terminal and HTTP handler. */
export function planningCommand(root: string, raw: unknown): unknown {
  const v = object(raw);
  if (v.command === 'view') return planningView(root);
  if (v.command === 'plan') return withDb(root, db => { words(v.id, 'Plan ID'); const p = doc<TaskPlan | null>(db, `human-plan:${v.id}`, null); check(p, 'Plan not found.'); return { ...p, stale: p.input_digest !== hash(snapshot(db)) }; });
  if (v.command === 'goal') return atomic(root, db => {
    const current = snapshot(db).goals.find(g => g.id === v.id); check(current, 'Goal not found.'); check(hash(current) === hash(v.expected), 'Stale goal; reload before changing.');
    const patch = object(v.patch); check(Object.keys(patch).every(k => ['text', 'deadline', 'weight', 'success_criteria'].includes(k)), 'Unsupported goal field.');
    const next = { ...current, ...patch } as GoalRow; words(next.text, 'Goal title'); words(next.success_criteria, 'Success criteria', true); words(v.reason, 'Goal change reason');
    if (next.deadline !== null) validDay(next.deadline); check(Number.isInteger(next.weight) && next.weight >= 1 && next.weight <= 5, 'Priority must be 1–5.');
    db.prepare('UPDATE goals SET text=?,deadline=?,weight=?,success_criteria=? WHERE id=?').run(next.text, next.deadline, next.weight, next.success_criteria, current.id);
    const history = doc<unknown[]>(db, `goal-history:${current.id}`, []); history.push({ before: current, after: next, reason: v.reason, at: new Date().toISOString() }); saveDoc(db, `goal-history:${current.id}`, history); return next;
  });
  if (v.command === 'create') return createTask(root, v.task, v.request_id as string);
  if (v.command === 'edit') return editTask(root, v.id as string, v.revision as number, v.patch, v.reason as string);
  if (v.command === 'work') return recordWork(root, v.id as string, v.revision as number, v.work);
  if (v.command === 'configure') return configurePlanning(root, v.revision as number, v.config);
  if (v.command === 'commitment') return saveCommitment(root, v.event);
  if (v.command === 'propose') return proposePlan(root, v.day as string, v.now as string);
  if (v.command === 'decide') return decidePlan(root, v.id as string, v.decision as 'accepted' | 'rejected', v.reason as string);
  if (v.command === 'block') return changeBlock(root, v.id as string, v.revision as number, v.action as 'pin' | 'release', v.reason as string);
  if (v.command === 'time') return { instant: zonedInstant(v.local as string, v.timezone as string, v.fold as 'earlier' | 'later' | undefined) };
  throw new PlanningError('Unknown planning command.');
}

/** Preview current feasibility without saving a new proposal or replacing accepted work. */
export function previewPlan(root: string, day: string, now: string): TaskPlan { return withDb(root, db => calculate(snapshot(db), day, now)); }
