/** Evidence revisions and reviewed changes over canonical actions, never a second task store. */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import type { RecordTransaction } from './record-model.js';
import { withRecords } from './records.js';
import { tasks, update, planningView, previewPlan, type Task } from './task-planning.js';
import { validateProcess, normalizeProcess, validateCompletion, type ProcessDoc } from './processes.js';
import { instant } from './planning-time.js';

export class ReconciliationError extends Error {}
export interface Observation {
  id: string; text: string; start_s: number | null; end_s: number | null;
  confidence: 'low' | 'medium' | 'high' | 'unknown'; uncertainty: string;
  coverage: 'sampled' | 'continuous' | 'human_report';
}
export interface Interpretation {
  id: string; model: string; prompt_version: string; origin: 'model' | 'replay' | 'human';
  at: string; observations: Observation[]; raw: unknown;
}
export interface Change {
  id: string; task_id: string; base_revision: number; before: Record<string, unknown>;
  observation_id: string; interpretation_id: string; kind: 'progress' | 'completion' | 'blocker' | 'correction';
  patch: Record<string, unknown>; quantity_mode: 'remaining' | 'incremental' | null;
  quantity_value: number | null; unit: string | null; reason: string; uncertainty: string;
  status: 'proposed' | 'accepted' | 'corrected' | 'rejected' | 'deferred';
  decisions: Array<{ at: string; decision: string; reason: string; patch: unknown; resulting_revision?: number }>;
}
export interface RelatedChange {
  id: string; kind: 'process_revision' | 'friction' | 'spatial'; task_id: string;
  process_id: string | null; base_revision: number | null; before: ProcessDoc | null;
  proposal: Record<string, unknown>; observation_id: string; interpretation_id: string; reason: string;
  status: 'proposed' | 'deferred' | 'rejected' | 'applied' | 'recorded' | 'pending_external';
  decisions: Array<{ at: string; decision: string; reason: string }>;
}
export interface EvidenceSource {
  schema: 'work-update/1'; id: string; checksum: string; kind: 'video' | 'manual'; media: string | null;
  metadata?: Record<string, unknown>;
  uploaded_at: string; recorded_at: string | null; time_uncertainty: string; duration_s: number | null;
  context: { task_ids: string[]; goal_ids: string[]; place: string; occurrence: string };
  revision: number; stage: 'received' | 'processing' | 'needs_review' | 'applied' | 'no_material_change' | 'failed_retryable';
  processing: { token: string; started_at: string } | null; error: string | null;
  baseline: Task[]; associations: Array<{ task_id: string; decision: 'confirmed' | 'rejected'; reason: string }>;
  related?: RelatedChange[];
  interpretations: Interpretation[]; changes: Change[];
  history: Array<{ at: string; action: string; reason: string }>;
}
interface ReviewInput {
  change_id: string; decision: 'accepted' | 'corrected' | 'rejected' | 'deferred'; reason: string;
  correction?: Record<string, unknown>; current_confirmed?: boolean;
  overlap?: 'distinct' | 'same'; overlap_reason?: string;
}
function ensure(ok: unknown, message: string): asserts ok { if (!ok) throw new ReconciliationError(message); }
function record(raw: unknown): Record<string, any> { ensure(raw && typeof raw === 'object' && !Array.isArray(raw), 'Expected an object.'); return raw as Record<string, any>; }
function text(raw: unknown, label: string, empty = false): string { ensure(typeof raw === 'string' && (empty || !!raw.trim()) && raw.length <= 4000, `${label} must be short text.`); return raw.trim(); }
function strings(raw: unknown): string[] { ensure(Array.isArray(raw) && raw.length <= 100 && raw.every(s => typeof s === 'string' && s.length > 0 && s.length <= 200) && new Set(raw).size === raw.length, 'Expected unique identifiers.'); return raw; }
function digest(raw: unknown): string { return createHash('sha256').update(JSON.stringify(raw)).digest('hex'); }
function now(): string { return new Date().toISOString(); }
function get<T>(db: RecordTransaction, key: string): T | null { const row = db.first('docs', { where: { key: key }, fields: ["body"] }) as { body: string } | undefined; return row ? JSON.parse(row.body) as T : null; }
function put(db: RecordTransaction, key: string, value: unknown): void { db.insert('docs', { key: key, body: JSON.stringify(value), updated_at: now() }, { conflict: ["key"], update: ["body","updated_at"] }); }
async function atomic<T>(root: string, fn: (db: RecordTransaction) => T): Promise<T> { return withRecords(root, fn); }
function all(db: RecordTransaction): EvidenceSource[] { return (db.select('docs', { prefix: { key: "evidence-source:" }, order: ["key"], fields: ["body"] }) as unknown as { body: string }[]).map(r => JSON.parse(r.body)); }
function source(db: RecordTransaction, id: string): EvidenceSource { const s = get<EvidenceSource>(db, `evidence-source:${id}`); ensure(s, 'Evidence source not found.'); return s; }
function save(db: RecordTransaction, s: EvidenceSource): void { put(db, `evidence-source:${s.id}`, s); }
function checkRevision(s: EvidenceSource, revision: number): void { ensure(s.revision === revision, 'Stale evidence revision. Reload the review.'); }
function status(s: EvidenceSource): void { s.stage = (s.related ?? []).some(c => ['proposed', 'deferred', 'pending_external'].includes(c.status)) || s.changes.some(c => ['proposed', 'deferred'].includes(c.status)) || !s.associations.some(a => a.decision === 'confirmed') ? 'needs_review' : (s.changes.some(c => ['accepted', 'corrected'].includes(c.status)) || (s.related ?? []).some(c => ['applied', 'recorded'].includes(c.status))) ? 'applied' : 'no_material_change'; }

/** Register exact bytes once. Context is a suggestion; identity is confirmed separately. */
export async function ingestEvidence(root: string, raw: unknown): Promise<EvidenceSource> {
  const v = record(raw); ensure(['video', 'manual'].includes(v.kind), 'Invalid source kind.');
  const context = record(v.context ?? {}), taskIds = strings(context.task_ids ?? []), goalIds = strings(context.goal_ids ?? []);
  const place = text(context.place ?? '', 'Place', true), occurrence = text(context.occurrence ?? '', 'Occurrence', true);
  let checksum: string, media: string | null = null;
  if (v.kind === 'video') {
    media = text(v.media, 'Media filename'); ensure(basename(media) === media && !media.includes('\\') && !media.includes('..'), 'Use a persisted media filename.');
    const path = resolve(root, 'media', media); ensure(path.startsWith(resolve(root, 'media') + sep), 'Invalid media path.');
    checksum = createHash('sha256').update(readFileSync(path)).digest('hex');
  } else checksum = digest({ request_id: text(v.request_id, 'Request ID'), report: text(v.report, 'Report') });
  const recordedAt = v.recorded_at ? instant(v.recorded_at) : null;
  const uncertainty = text(v.time_uncertainty ?? (recordedAt ? 'Operator supplied' : 'Recording time unknown'), 'Time uncertainty');
  ensure(!recordedAt || recordedAt <= now(), 'Evidence cannot be recorded in the future.');
  const duration = v.duration_s ?? null; ensure(duration === null || typeof duration === 'number' && Number.isFinite(duration) && duration > 0, 'Invalid duration.');
  return await atomic(root, db => {
    const id = digest({ kind: v.kind, checksum }); const existing = get<EvidenceSource>(db, `evidence-source:${id}`);
    if (existing) return existing;
    if (v.kind === 'manual') { const prior = get<string>(db, `evidence-request:${digest(v.request_id)}`); ensure(!prior || prior === id, 'Request ID reused with different report.'); put(db, `evidence-request:${digest(v.request_id)}`, id); }
    const current = tasks(db); ensure(taskIds.every(id => current.some(t => t.id === id)), 'Unknown context task.');
    const goals = new Set((db.select('goals', { fields: ["id"] }) as unknown as { id: string }[]).map(g => g.id)); ensure(goalIds.every(id => goals.has(id)), 'Unknown context goal.');
    const s: EvidenceSource = { schema: 'work-update/1', id, checksum, kind: v.kind, media, uploaded_at: now(), recorded_at: recordedAt, time_uncertainty: uncertainty, duration_s: duration,
      context: { task_ids: taskIds, goal_ids: goalIds, place, occurrence }, revision: 1, stage: 'received', processing: null, error: null,
      baseline: current, associations: [], interpretations: [], changes: [], history: [{ at: now(), action: 'received', reason: v.kind === 'manual' ? v.report : 'Source bytes retained; recorded time is separate from upload time.' }] };
    save(db, s); return s;
  });
}
/** Claim a persisted processing attempt. Explicit retry invalidates an interrupted worker's token. */
export async function beginInterpretation(root: string, id: string, revision: number, retry = false): Promise<EvidenceSource> {
  return await atomic(root, db => { const s = source(db, id); checkRevision(s, revision); ensure(!s.processing || retry, 'Processing already active; use explicit retry if interrupted.'); s.processing = { token: randomUUID(), started_at: now() }; s.stage = 'processing'; s.error = null; s.revision++; save(db, s); return s; });
}
/** Store model failure without discarding the clip or accepted work. */
export async function failInterpretation(root: string, id: string, token: string, message: string): Promise<EvidenceSource> {
  return await atomic(root, db => { const s = source(db, id); ensure(s.processing?.token === token, 'Stale processing attempt.'); s.processing = null; s.stage = 'failed_retryable'; s.error = text(message.slice(0, 4000), 'Failure'); s.revision++; save(db, s); return s; });
}
function observation(raw: unknown, duration: number | null): Observation {
  const v = record(raw); const start = v.start_s ?? null, end = v.end_s ?? start;
  ensure(start === null && end === null || typeof start === 'number' && typeof end === 'number' && Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start && (duration === null || end <= duration), 'Invalid source interval.');
  ensure(['sampled', 'continuous', 'human_report'].includes(v.coverage), 'Invalid observation coverage.');
  ensure(['low', 'medium', 'high', 'unknown'].includes(v.confidence), 'Invalid confidence.');
  return { id: text(v.id, 'Observation ID'), text: text(v.text, 'Observation'), start_s: start, end_s: end, confidence: v.confidence, coverage: v.coverage, uncertainty: text(v.uncertainty, 'Uncertainty', true) };
}
/** Finish an interpretation revision; reruns are interpretations of one source, never extra evidence. */
export async function finishInterpretation(root: string, id: string, token: string, raw: unknown): Promise<EvidenceSource> {
  const v = record(raw);
  return await atomic(root, db => {
    const s = source(db, id); ensure(s.processing?.token === token, 'Stale processing attempt.');
    ensure(['model', 'replay', 'human'].includes(v.origin), 'Invalid interpretation origin.');
    ensure(Array.isArray(v.observations) && v.observations.length <= 200, 'Expected observations.');
    if (v.metadata) {
      const m = record(v.metadata);
      const duration = m.duration_s;
      ensure(duration === null || duration === undefined || typeof duration === 'number' && Number.isFinite(duration) && duration > 0, 'Invalid media duration.');
      if (typeof duration === 'number') s.duration_s = duration;
      s.metadata = m;
      if (!s.recorded_at && m.recorded_source === 'container' && typeof m.recorded_at === 'string') {
        const recorded = instant(m.recorded_at); ensure(recorded <= now(), 'Container recording date is in the future.');
        s.recorded_at = recorded; s.time_uncertainty = 'Container timestamp; operator should verify camera clock';
      }
    }
    const observations = v.observations.map((o: unknown) => observation(o, s.duration_s)); strings(observations.map((o: Observation) => o.id));
    s.interpretations.push({ id: randomUUID(), at: now(), model: text(v.model, 'Model'), prompt_version: text(v.prompt_version, 'Prompt version'), origin: v.origin, observations, raw: v.raw ?? null });
    s.processing = null; s.error = null; s.revision++; status(s); save(db, s); return s;
  });
}
/** Associate an existing occurrence. Rejected identity cannot authorize dependent changes. */
export async function associateEvidence(root: string, id: string, revision: number, taskId: string, decision: 'confirmed' | 'rejected', reason: string): Promise<EvidenceSource> {
  return await atomic(root, db => {
    const s = source(db, id); checkRevision(s, revision); ensure(['confirmed', 'rejected'].includes(decision), 'Invalid association decision.'); text(reason, 'Identity rationale');
    const task = tasks(db).find(t => t.id === taskId); ensure(task, 'Unknown task.');
    ensure((!s.changes.some(c => c.task_id === taskId && ['accepted', 'corrected'].includes(c.status)) && !(s.related ?? []).some(c => c.task_id === taskId && ['applied', 'recorded', 'pending_external'].includes(c.status))) || decision === 'confirmed', 'Applied identity must be corrected through a new reviewed correction; history cannot be detached.');
    s.associations = [...s.associations.filter(a => a.task_id !== taskId), { task_id: taskId, decision, reason }];
    if (!s.baseline.some(t => t.id === taskId)) s.baseline.push(task);
    s.history.push({ at: now(), action: `association:${decision}`, reason }); s.revision++; status(s); save(db, s); return s;
  });
}
const PATCH_KEYS = new Set(['execution', 'remaining_minutes', 'estimate_source', 'quantity', 'preconditions', 'dependencies', 'location']);
function checkedPatch(task: Task, raw: unknown, kind: Change['kind']): Record<string, unknown> {
  const patch = { ...record(raw) }; ensure(Object.keys(patch).length > 0 && Object.keys(patch).every(k => PATCH_KEYS.has(k)), 'Unsupported evidence change field.');
  if (patch.execution === 'done' || kind === 'completion') {
    ensure(task.completion_criteria.trim(), 'Define completion criteria first.');
    ensure(patch.execution === 'done', 'Completion must explicitly mark done.');
    ensure(patch.remaining_minutes === undefined || patch.remaining_minutes === 0, 'Completion conflicts with remaining minutes.');
    ensure(patch.quantity === undefined || record(patch.quantity).remaining === 0, 'Completion conflicts with remaining quantity.');
    patch.remaining_minutes = 0; if (!task.estimate_source) patch.estimate_source = 'Operator-confirmed completion; no duration inferred'; if (task.quantity) patch.quantity = { ...task.quantity, remaining: 0 };
  } else if (patch.quantity !== undefined) {
    const q = record(patch.quantity); ensure(task.quantity && q.total === task.quantity.total && q.unit === task.quantity.unit, 'Quantity total and unit must match the canonical task.');
    ensure(typeof q.remaining === 'number' && Number.isFinite(q.remaining) && q.remaining >= 0 && q.remaining <= q.total, 'Invalid remaining quantity.');
  }
  if (patch.remaining_minutes !== undefined) ensure(typeof patch.remaining_minutes === 'number' && Number.isFinite(patch.remaining_minutes) && patch.remaining_minutes >= 0, 'Invalid remaining minutes.');
  return patch;
}
/** Propose a task change against the ingestion snapshot; no operational mutation occurs here. */
export async function proposeChange(root: string, id: string, revision: number, raw: unknown): Promise<EvidenceSource> {
  const v = record(raw);
  return await atomic(root, db => {
    const s = source(db, id); checkRevision(s, revision);
    const run = v.interpretation_id ? s.interpretations.find(r => r.id === v.interpretation_id) : s.interpretations.at(-1); ensure(run, 'Interpret source evidence first.');
    const obs = run.observations.find(o => o.id === v.observation_id); ensure(obs, 'Unknown observation reference.');
    const task = s.baseline.find(t => t.id === v.task_id); ensure(task, 'Associate a known task before proposing a change.');
    ensure(['progress', 'completion', 'blocker', 'correction'].includes(v.kind), 'Unsupported change kind.');
    let patch = record(v.patch ?? {}); const mode = v.quantity_mode ?? null; let value: number | null = null; let unit: string | null = null;
    ensure(mode === null || ['remaining', 'incremental'].includes(mode), 'Quantity needs remaining or incremental semantics.');
    ensure(!('quantity' in patch), 'Supply quantity_mode, quantity_value and unit.');
    if (mode) {
      value = v.quantity_value; unit = text(v.unit, 'Quantity unit');
      ensure(task.quantity && task.quantity.unit === unit, 'Quantity unit must match task.');
      ensure(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= (mode === 'incremental' ? task.quantity.remaining : task.quantity.total), 'Invalid quantity value.');
      patch = { ...patch, quantity: { ...task.quantity, remaining: mode === 'incremental' ? task.quantity.remaining - value : value } };
    }
    patch = checkedPatch(task, patch, v.kind);
    // Deliberately exclude model version/observation ID: equivalent reruns retain prior rejection/acceptance.
    const fingerprint = digest({ source: s.id, task: task.id, span: [obs.start_s, obs.end_s], kind: v.kind, patch, mode, value });
    if (s.changes.some(c => c.id === fingerprint)) return s;
    const before = Object.fromEntries(Object.keys(patch).map(k => [k, (task as unknown as Record<string, unknown>)[k]]));
    s.changes.push({ id: fingerprint, task_id: task.id, base_revision: task.revision, before, observation_id: obs.id, interpretation_id: run.id, kind: v.kind, patch, quantity_mode: mode, quantity_value: value, unit,
      reason: text(v.reason, 'Change rationale'), uncertainty: text(v.uncertainty ?? obs.uncertainty, 'Uncertainty', true), status: 'proposed', decisions: [] });
    s.revision++; status(s); save(db, s); return s;
  });
}
function applied(c: Change): boolean { return ['accepted', 'corrected'].includes(c.status); }
function overlap(a: Observation, b: Observation): boolean { return a.start_s === null || b.start_s === null || a.start_s! <= b.end_s! && b.start_s! <= a.end_s!; }
function obsFor(s: EvidenceSource, c: Change): Observation { return s.interpretations.find(r => r.id === c.interpretation_id)!.observations.find(o => o.id === c.observation_id)!; }
/** Explain historical/ambiguous/duplicate claims without hiding the accepted value. */
function warnings(db: RecordTransaction, s: EvidenceSource, c: Change): string[] {
  const current = tasks(db).find(t => t.id === c.task_id), result: string[] = [];
  if (!current || current.revision !== c.base_revision) result.push('Stale task revision: explicitly rebase before applying.');
  if (!s.associations.some(a => a.task_id === c.task_id && a.decision === 'confirmed')) result.push('Confirm which task occurrence this evidence concerns.');
  if (!s.recorded_at || /unknown|estimate|mtime/i.test(s.time_uncertainty)) result.push('Recording time is uncertain; confirm the proposed value describes current work.');
  const accepted = all(db).flatMap(other => other.changes.filter(x => applied(x) && x.task_id === c.task_id && x.id !== c.id).map(x => ({ other, change: x })));
  if (s.recorded_at && (current?.history.at(-1)?.at ?? '') > s.recorded_at) result.push('Evidence predates the latest task edit; it may describe historical work.');
  if (accepted.some(x => x.other.recorded_at && (!s.recorded_at || x.other.recorded_at > s.recorded_at))) result.push('Later accepted evidence exists; do not regress current state.');
  if (accepted.some(x => x.other.id === s.id && overlap(obsFor(s, c), obsFor(x.other, x.change)))) result.push('This source interval already supports an applied change.');
  if (accepted.some(x => x.other.id !== s.id)) result.push('Possible overlap with other footage/reports of this task; verify occurrence and quantity interpretation.');
  if (c.kind === 'completion') result.push(`Completion requires confirmation of: ${current?.completion_criteria ?? 'unknown criteria'}. Clip ending or absence is not proof.`);
  if (current && (c.patch.execution && c.patch.execution !== current.execution || c.patch.quantity)) result.push('Proposed claim differs from accepted task state; review the before/after values.');
  return result;
}
/** Rebase explicitly; preserve original proposal and decisions, never overwrite the old before value. */
export async function rebaseChange(root: string, id: string, revision: number, changeId: string, reason: string): Promise<EvidenceSource> {
  return await atomic(root, db => { const s = source(db, id); checkRevision(s, revision); const old = s.changes.find(c => c.id === changeId); ensure(old && !applied(old), 'Cannot rebase an applied/missing change.'); text(reason, 'Rebase rationale');
    const task = tasks(db).find(t => t.id === old.task_id); ensure(task, 'Task missing.');
    ensure(task.revision !== old.base_revision, 'Proposal already uses current revision.');
    let patch = { ...old.patch }; if (old.quantity_mode === 'incremental') { ensure(task.quantity && task.quantity.unit === old.unit && task.quantity.remaining >= old.quantity_value!, 'Quantity no longer compatible.'); patch.quantity = { ...task.quantity, remaining: task.quantity.remaining - old.quantity_value! }; }
    patch = checkedPatch(task, patch, old.kind);
    const id2 = digest({ original: old.id, revision: task.revision }); ensure(!s.changes.some(c => c.id === id2), 'Rebased proposal already exists.');
    s.changes.push({ ...old, id: id2, base_revision: task.revision, patch, before: Object.fromEntries(Object.keys(patch).map(k => [k, (task as unknown as Record<string, unknown>)[k]])), status: 'proposed', decisions: [] });
    old.status = 'rejected'; old.decisions.push({ at: now(), decision: 'superseded_by_rebase', reason, patch: { replacement: id2 } }); s.revision++; status(s); save(db, s); return s;
  });
}
/** Apply a coherent subset and its audit trail in one SQLite transaction. Retried keys are immutable. */
export async function reviewChanges(root: string, id: string, revision: number, requestId: string, raw: unknown): Promise<EvidenceSource> {
  text(requestId, 'Review request ID'); ensure(Array.isArray(raw) && raw.length > 0 && raw.length <= 100, 'Select changes to review.');
  const reviews = raw as ReviewInput[]; strings(reviews.map(r => r.change_id));
  return await atomic(root, db => {
    const key = `evidence-review:${digest({ id, requestId })}`, prior = get<{ digest: string }>(db, key), payload = digest(raw);
    if (prior) { ensure(prior.digest === payload, 'Review request ID reused with different decisions.'); return source(db, id); }
    const s = source(db, id); checkRevision(s, revision);
    const taskPatches = new Map<string, { task: Task; patch: Record<string, unknown>; decisions: ReviewInput[] }>();
    for (const r of reviews) {
      text(r.reason, 'Decision reason'); ensure(['accepted', 'corrected', 'rejected', 'deferred'].includes(r.decision), 'Invalid decision.');
      const c = s.changes.find(c => c.id === r.change_id); ensure(c && !applied(c), 'Change missing or already applied.');
      if (['accepted', 'corrected'].includes(r.decision)) {
        const task = tasks(db).find(t => t.id === c.task_id); ensure(task && task.revision === c.base_revision, 'Stale task revision. Rebase explicitly.');
        ensure(s.associations.some(a => a.task_id === c.task_id && a.decision === 'confirmed'), 'Confirm task occurrence before applying dependent changes.');
        const warn = warnings(db, s, c);
        if (warn.some(w => /historical|Later accepted|uncertain/.test(w))) ensure(r.current_confirmed === true, 'Historical/uncertain evidence: confirm current state explicitly or retain as history.');
        if (warn.some(w => /already supports/.test(w))) ensure(r.decision === 'corrected' && r.correction && !('quantity' in c.patch && c.quantity_mode === 'incremental'), 'Source interval already applied; only an explicit non-additive correction is allowed.');
        if (warn.some(w => /Possible overlap/.test(w))) { ensure(['distinct', 'same'].includes(r.overlap ?? ''), 'Resolve possible footage overlap.'); text(r.overlap_reason, 'Overlap rationale'); ensure(r.overlap !== 'same' || c.quantity_mode !== 'incremental', 'Overlapping evidence cannot add incremental progress. Use a confirmed remaining total.'); }
        const patch = checkedPatch(task, r.decision === 'corrected' ? r.correction : c.patch, c.kind);
        if (patch.execution === 'done') ensure(r.current_confirmed === true, 'Explicitly confirm completion criteria are satisfied.');
        // One patch per field per task in a batch prevents hidden last-write-wins and duplicate quantity addition.
        const merged = taskPatches.get(task.id) ?? { task, patch: {}, decisions: [] };
        ensure(Object.keys(patch).every(k => !(k in merged.patch)), 'Dependent changes write the same field. Review separately.');
        Object.assign(merged.patch, patch); merged.decisions.push(r); taskPatches.set(task.id, merged);
      }
    }
    for (const { task, patch } of taskPatches.values()) {
      const final = { ...task, ...patch } as Task; ensure(final.execution !== 'done' || final.remaining_minutes === 0 && (!final.quantity || final.quantity.remaining === 0), 'Done task cannot retain remaining work.');
      update(db, task, patch, `Evidence ${id}: ${reviews.filter(r => s.changes.find(c => c.id === r.change_id)?.task_id === task.id).map(r => r.reason).join('; ')}`);
    }
    for (const r of reviews) { const c = s.changes.find(c => c.id === r.change_id)!; c.status = r.decision; c.decisions.push({ at: now(), decision: r.decision, reason: r.reason, patch: { applied: r.correction ?? c.patch, current_confirmed: r.current_confirmed ?? false, overlap: r.overlap ?? null, overlap_reason: r.overlap_reason ?? null }, ...(applied(c) ? { resulting_revision: c.base_revision + 1 } : {}) }); }
    s.revision++; status(s); s.history.push({ at: now(), action: 'review', reason: 'Selected decisions saved atomically; accepted schedules and goal outcomes unchanged.' }); save(db, s); put(db, key, { digest: payload }); return s;
  });
}
/** Persist an intentional operator update without a redundant approval round trip. */
export async function manualUpdate(root: string, raw: unknown): Promise<EvidenceSource> {
  const v = record(raw); const requestId = text(v.request_id, 'Request ID');
  // One enclosing transaction, including ingest/proposal semantics, makes retries and failed edits safe.
  return await atomic(root, db => {
    const key = `manual-update:${digest(requestId)}`, prior = get<{ digest: string; id: string }>(db, key);
    if (prior) { ensure(prior.digest === digest(v), 'Request ID reused with different manual update.'); return source(db, prior.id); }
    const task = tasks(db).find(t => t.id === v.task_id); ensure(task && task.revision === v.task_revision, 'Stale task revision.');
    const reason = text(v.report, 'Human report'); const patch = checkedPatch(task, v.patch, 'correction');
    const final = { ...task, ...patch } as Task; ensure(final.execution !== 'done' || final.remaining_minutes === 0 && (!final.quantity || final.quantity.remaining === 0), 'Done task cannot retain remaining work.');
    const at = now(), id = digest({ requestId, report: reason }), next = update(db, task, patch, reason);
    const s: EvidenceSource = { schema: 'work-update/1', id, checksum: digest(v), kind: 'manual', media: null, uploaded_at: at, recorded_at: at, time_uncertainty: 'Explicit current-state report by operator', duration_s: null,
      context: { task_ids: [task.id], goal_ids: task.links.map(l => l.goal_id), place: task.location, occurrence: task.id }, baseline: [task], revision: 1, stage: 'applied', processing: null, error: null, associations: [{ task_id: task.id, decision: 'confirmed', reason }],
      interpretations: [{ id: 'human', model: 'operator', prompt_version: 'manual/1', origin: 'human', at, observations: [{ id: 'report', text: reason, start_s: null, end_s: null, confidence: 'unknown', uncertainty: 'Human report; not independent visual measurement', coverage: 'human_report' }], raw: v }],
      changes: [{ id: digest({ id, patch }), task_id: task.id, base_revision: task.revision, before: Object.fromEntries(Object.keys(patch).map(k => [k, (task as unknown as Record<string, unknown>)[k]])), observation_id: 'report', interpretation_id: 'human', kind: 'correction', patch, quantity_mode: patch.quantity ? 'remaining' : null, quantity_value: patch.quantity ? (patch.quantity as { remaining: number }).remaining : null, unit: task.quantity?.unit ?? null, reason, uncertainty: 'Operator assertion', status: 'accepted', decisions: [{ at, decision: 'explicit_manual_update', reason, patch, resulting_revision: next.revision }] }], history: [{ at, action: 'manual_update', reason }] };
    save(db, s); put(db, key, { digest: digest(v), id }); return s;
  });
}
/** Review queue with live stale/contradiction warnings and transitive downstream task references. */
export async function reconciliationView(root: string): Promise<{ sources: Array<EvidenceSource & { review: Array<{ change_id: string; warnings: string[]; affected_tasks: string[]; goal_ids: string[]; block_ids: string[] }>; next_action: string }> }> {
  const planning = await planningView(root);
  return await withRecords(root, db => ({ sources: all(db).sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at)).map(s => ({ ...s,
    review: s.changes.map(c => {
      const affected = new Set([c.task_id]); let size = 0; while (affected.size !== size) { size = affected.size; planning.tasks.filter(t => t.dependencies.some(d => affected.has(d))).forEach(t => affected.add(t.id)); }
      return { change_id: c.id, warnings: applied(c) ? [] : warnings(db, s, c), affected_tasks: [...affected], goal_ids: [...new Set(planning.tasks.filter(t => affected.has(t.id)).flatMap(t => t.links.map(l => l.goal_id)))], block_ids: planning.schedule.blocks.filter(b => b.status === 'accepted' && affected.has(b.task_id)).map(b => b.id) };
    }), next_action: s.processing ? 'Processing is saved. Retry explicitly if interrupted.' : s.stage === 'failed_retryable' ? 'Retry analysis of the retained clip.' : s.related?.some(c => c.status === 'pending_external') ? 'Spatial change is pending the supported OI handoff; no external mutation has been applied.' : s.stage === 'no_material_change' ? 'No operational change. Evidence and review rationale retained.' : !s.associations.some(a => a.decision === 'confirmed') ? 'Choose the existing task occurrence, or retain unrelated footage without an operational change.' : (s.related ?? []).some(c => ['proposed', 'deferred'].includes(c.status)) || s.changes.some(c => ['proposed', 'deferred'].includes(c.status)) ? 'Review changes and resolve uncertain quantities or contradictions.' : 'Evidence retained. Review current plan if accepted work is affected.'
  })) }));
}
/** Preview effects without accepting a schedule; fixed/pinned work remains preserved. */
export async function reconciliationPlan(root: string, day: string, at: string): Promise<unknown> {
  const prior = await planningView(root), plan = await previewPlan(root, day, at);
  return { plan, comparison: { preserved: plan.preserved.map(b => b.id), added: plan.blocks.map(b => b.id), moved: [], unscheduled: plan.deferred, conflicts: plan.conflicts, accepted_blocks_unchanged: true, previous_plan_id: prior.latest_plan?.id ?? null }, next_action: plan.next };
}
/** Record process/friction/spatial consequences with explicit owner boundaries and source references. */
export async function proposeRelated(root: string, id: string, revision: number, raw: unknown): Promise<EvidenceSource> {
  const v = record(raw);
  return await atomic(root, db => {
    const s = source(db, id); checkRevision(s, revision);
    ensure(['process_revision', 'friction', 'spatial'].includes(v.kind), 'Invalid related change kind.');
    const task = tasks(db).find(t => t.id === v.task_id); ensure(task, 'Unknown task context.');
    const run = v.interpretation_id ? s.interpretations.find(r => r.id === v.interpretation_id) : s.interpretations.at(-1); ensure(run?.observations.some(o => o.id === v.observation_id), 'Unknown supporting observation.');
    const proposal = record(v.proposal); const reason = text(v.reason, 'Related change rationale');
    let before: ProcessDoc | null = null;
    if (v.kind === 'process_revision') {
      ensure(task.process && task.process.id === v.process_id, 'Task must reference this canonical process.');
      const row = db.first('processes', { where: { id: v.process_id }, order: ["-rev"], fields: ["body"] }) as { body: string } | undefined;
      ensure(row, 'Process not found.'); before = JSON.parse(row.body) as ProcessDoc;
      ensure(before.rev === v.base_revision, 'Stale process revision.');
      const next = validateProcess(proposal);
      ensure(next.id === before.id && next.rev === before.rev + 1, 'Proposed process must extend the same process by one revision.');
    } else text(proposal.summary, 'Finding summary');
    const changeId = digest({ source: id, kind: v.kind, task: task.id, observation: v.observation_id, proposal });
    s.related ??= []; if (s.related.some(c => c.id === changeId)) return s;
    s.related.push({ id: changeId, kind: v.kind, task_id: task.id, process_id: before?.id ?? null, base_revision: before?.rev ?? null, before, proposal, observation_id: v.observation_id, interpretation_id: run!.id, reason, status: 'proposed', decisions: [] });
    s.revision++; status(s); save(db, s); return s;
  });
}
/** Apply a reviewed process revision atomically; spatial operations remain an explicit external handoff. */
export async function reviewRelated(root: string, id: string, revision: number, raw: unknown): Promise<EvidenceSource> {
  const v = record(raw);
  return await atomic(root, db => {
    const s = source(db, id); checkRevision(s, revision); const c = s.related?.find(c => c.id === v.change_id); ensure(c, 'Related change not found.');
    ensure(['accepted', 'rejected', 'deferred'].includes(v.decision), 'Invalid related decision.'); text(v.reason, 'Decision rationale');
    ensure(!['applied', 'recorded', 'pending_external'].includes(c.status), 'Related change already reviewed.');
    if (v.decision === 'accepted') {
      ensure(s.associations.some(a => a.task_id === c.task_id && a.decision === 'confirmed'), 'Confirm task occurrence first.');
      if (c.kind === 'process_revision') {
        ensure(v.current_confirmed === true, 'Confirm this process correction describes current work.');
        const current = ({ rev: db.first('processes', { where: { id: c.process_id! }, order: ["-rev"] })?.rev ?? null }) as { rev: number };
        ensure(current.rev === c.base_revision, 'Stale process revision. Submit a revised proposal.');
        const next = normalizeProcess(validateProcess(c.proposal));
        validateCompletion(next, { mediaPresent: media => { if (!media) return false; const path = resolve(root, 'media', media); return path.startsWith(resolve(root, 'media') + sep) && existsSync(path); } });
        // The accepted revision keeps provenance from earlier clips and points to this reconciliation decision.
        next.updated_at = now(); next.created_at = c.before!.created_at;
        next.corrections = [...c.before!.corrections, { rev: next.rev, at: next.updated_at, rationale: `${v.reason} (evidence ${s.id}, observation ${c.observation_id})`, paths: ['reviewed_process_revision'] }];
        db.insert('processes', { id: next.id, rev: next.rev, body: JSON.stringify(next), author: 'farmer', created: now() });
        const plan = get<{ process_basis?: Array<{ process_id: string; rev: number }> }>(db, 'plan');
        if (plan?.process_basis?.some(b => b.process_id === next.id && b.rev < next.rev)) put(db, 'plan', { ...plan, stale: true, stale_reason: `process "${next.id}" updated from evidence ${s.id}` });
        c.status = 'applied';
      } else c.status = c.kind === 'spatial' ? 'pending_external' : 'recorded';
    } else c.status = v.decision;
    c.decisions.push({ at: now(), decision: v.decision, reason: v.reason }); s.revision++; status(s); save(db, s); return s;
  });
}
/** Keep unrelated or insufficient evidence without changing operational state. */
export async function retainEvidence(root: string, id: string, revision: number, reason: string): Promise<EvidenceSource> {
  return await atomic(root, db => { const s = source(db, id); checkRevision(s, revision); text(reason, 'No-change rationale');
    ensure(!(s.related ?? []).some(c => ['proposed', 'deferred', 'pending_external'].includes(c.status)) && !s.processing && !s.changes.some(c => ['proposed', 'deferred'].includes(c.status)), 'Resolve pending changes/processing before retaining with no change.');
    s.stage = s.changes.some(applied) || (s.related ?? []).some(c => ['applied', 'recorded'].includes(c.status)) ? 'applied' : 'no_material_change'; s.history.push({ at: now(), action: 'retain_without_change', reason }); s.revision++; save(db, s); return s;
  });
}
/** Shared JSON command boundary for CLI and HTTP clients. */
export async function reconciliationCommand(root: string, raw: unknown): Promise<unknown> {
  const v = record(raw);
  switch (v.command) {
    case 'view': return await reconciliationView(root);
    case 'ingest': return await ingestEvidence(root, v.source);
    case 'begin': return await beginInterpretation(root, v.id, v.revision, v.retry === true);
    case 'finish': return await finishInterpretation(root, v.id, v.token, v.interpretation);
    case 'fail': return await failInterpretation(root, v.id, v.token, v.error);
    case 'associate': return await associateEvidence(root, v.id, v.revision, v.task_id, v.decision, v.reason);
    case 'propose': return await proposeChange(root, v.id, v.revision, v.change);
    case 'review': return await reviewChanges(root, v.id, v.revision, v.request_id, v.decisions);
    case 'rebase': return await rebaseChange(root, v.id, v.revision, v.change_id, v.reason);
    case 'propose_related': return await proposeRelated(root, v.id, v.revision, v.change);
    case 'review_related': return await reviewRelated(root, v.id, v.revision, v.review);
    case 'retain': return await retainEvidence(root, v.id, v.revision, v.reason);
    case 'manual': return await manualUpdate(root, v);
    case 'plan': return await reconciliationPlan(root, v.day, v.now);
    default: throw new ReconciliationError('Unknown reconciliation command.');
  }
}

