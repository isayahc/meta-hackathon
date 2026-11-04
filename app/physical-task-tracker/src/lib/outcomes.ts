/** Registered intervention trials, source-backed measurements and conservative outcome comparisons. */
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { withDb } from './db.js';
import type { Assessment, ImprovementReview } from './improvements.js';
import type { ProcessDoc } from './processes.js';
import type { EvidenceSource } from './reconciliation.js';
import { instant } from './planning-time.js';
import { planningView } from './task-planning.js';

export class OutcomeError extends Error {}
export interface MetricSpec { id: string; label: string; unit: string; direction: 'lower' | 'higher'; tolerance: number }
export interface OutcomeMeasurement { metric_id: string; value: number | null; unit: string; kind: 'measured' | 'estimated' | 'unknown'; method: 'operator' | 'instrument' | 'continuous_video' | 'sparse_frames'; source: string }
export type VisitReference = { kind: 'session'; spot_id: string; session_id: string; side?: 'before' | 'after' } | { kind: 'evidence'; source_id: string; interpretation_id: string };
export interface VisitContext { intervention_applied: boolean | null; implementation_note: string; staffing: number | null; equipment: string | null; conditions: string | null; quality_criteria: string; quality_passed: boolean | null; coverage: 'full' | 'partial' | 'unknown'; coverage_note: string }
export interface TrialVisit {
  id: string; revision: number; observed_at: string; reference: VisitReference; source_snapshot: unknown; source_digest: string; source_identity: string; continuous_coverage: boolean; quarantined: boolean;
  process_id: string; process_revision: number; process_snapshot: ProcessDoc;
  workload: { amount: number | null; unit: string; context: string }; context: VisitContext; measurements: OutcomeMeasurement[]; notes: string;
}
export interface TrialDecision { decision: 'keep' | 'revise' | 'reject'; reason: string; revision_plan: string | null; at: string; evidence_digest: string; followup_id: string | null }
export interface InterventionTrial {
  schema: 'intervention-trial/1'; id: string; revision: number; created_at: string; started_at: string; registration: 'prospective' | 'retrospective';
  review_id: string; candidate_id: string; assessment: Assessment; review_snapshot: ImprovementReview;
  metrics: MetricSpec[]; workload_unit: string; expected_changes: Array<{ field: 'staffing' | 'equipment' | 'conditions'; value: string | number; reason: string }>;
  baseline: TrialVisit | null; registered_baseline: TrialVisit | null; followups: TrialVisit[];
  decisions: TrialDecision[]; corrections: Array<{ at: string; reason: string; visit_id: string; before: TrialVisit | null }>;
}
export type OutcomeStatus = 'unknown' | 'inconclusive' | 'improved' | 'worse' | 'unchanged';
export interface TrialResult {
  trial_id: string; followup_id: string | null; evidence_digest: string; status: OutcomeStatus;
  metrics: Array<{ metric_id: string; label: string; unit_per_workload: string; baseline: number | null; followup: number | null; delta: number | null; improvement_percent: number | null; status: OutcomeStatus; reasons: string[] }>;
  context_differences: Array<{ field: string; before: unknown; after: unknown; planned: boolean }>;
  reasons: string[]; source_warnings: string[]; causal_interpretation: string; latest_decision: (TrialDecision & { current: boolean }) | null; next_action: string;
}
function need(ok: unknown, message: string): asserts ok { if (!ok) throw new OutcomeError(message); }
function obj(value: unknown): Record<string, any> { need(value && typeof value === 'object' && !Array.isArray(value), 'Expected an object.'); return value as Record<string, any>; }
function words(value: unknown, label: string, empty = false): string { need(typeof value === 'string' && (empty || !!value.trim()) && value.length <= 4000, `${label} must be short text.`); return value.trim(); }
function number(value: unknown, label: string, positive = false): number { need(typeof value === 'number' && Number.isFinite(value) && (positive ? value > 0 : value >= 0), `${label} must be a finite ${positive ? 'positive' : 'nonnegative'} number.`); return value; }
function now(): string { return new Date().toISOString(); }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function get<T>(db: DatabaseSync, key: string): T | null { const row = db.prepare('SELECT body FROM docs WHERE key=?').get(key) as { body: string } | undefined; return row ? JSON.parse(row.body) as T : null; }
function put(db: DatabaseSync, key: string, value: unknown): void { db.prepare('INSERT INTO docs VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at').run(key, JSON.stringify(value), now()); }
function atomic<T>(root: string, fn: (db: DatabaseSync) => T): T { return withDb(root, db => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(db); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }); }
function trial(db: DatabaseSync, id: string): InterventionTrial { const result = get<InterventionTrial>(db, `intervention-trial:${id}`); need(result, 'Trial not found.'); return result; }
function process(db: DatabaseSync, id: string, revision: number): ProcessDoc { const row = db.prepare('SELECT body FROM processes WHERE id=? AND rev=?').get(id, revision) as { body: string } | undefined; need(row, 'Unknown process revision.'); return JSON.parse(row.body) as ProcessDoc; }
function source(db: DatabaseSync, raw: unknown): { reference: VisitReference; snapshot: unknown; identity: string; continuous: boolean; quarantined: boolean } {
  const ref = obj(raw);
  if (ref.kind === 'session') {
    const spot = words(ref.spot_id, 'Spot'), sid = words(ref.session_id, 'Session');
    const row = db.prepare('SELECT analysis,created FROM sessions WHERE spot_id=? AND sid=?').get(spot, sid) as { analysis: string; created: string } | undefined; need(row, 'Session not found.');
    const analysis = JSON.parse(row.analysis) as Record<string, unknown>;
    const side = ref.side ?? 'after'; need(side === 'before' || side === 'after', 'Session side must be before or after.');
    const media = analysis.visit_evidence as { before?: { identity: string }; after?: { identity: string } } | undefined;
    return { reference: { kind: 'session', spot_id: spot, session_id: sid, side }, snapshot: { analysis, created: row.created, side }, identity: media?.[side as 'before' | 'after']?.identity ?? `session:${spot}:${sid}:${side}`, continuous: false, quarantined: analysis.same_location === false };
  }
  need(ref.kind === 'evidence', 'Choose a stored session or evidence interpretation.');
  const s = get<EvidenceSource>(db, `evidence-source:${words(ref.source_id, 'Evidence source')}`); need(s, 'Evidence source not found.');
  const interpretation = s.interpretations.find(i => i.id === ref.interpretation_id); need(interpretation, 'Interpretation not found.');
  return { reference: { kind: 'evidence', source_id: s.id, interpretation_id: interpretation.id }, snapshot: { checksum: s.checksum, media: s.media, recorded_at: s.recorded_at, interpretation }, identity: `${s.kind === 'video' ? 'media' : 'evidence'}:${s.checksum}`, continuous: interpretation.observations.some(o => o.coverage === 'continuous' && o.start_s !== null && o.end_s !== null && o.end_s > o.start_s), quarantined: false };
}
function visit(db: DatabaseSync, raw: unknown, spec: Pick<InterventionTrial, 'metrics' | 'workload_unit' | 'assessment'>, id: string = randomUUID(), revision = 1): TrialVisit {
  const v = obj(raw), s = source(db, v.reference), w = obj(v.workload), c = obj(v.context);
  const observed = instant(v.observed_at); need(observed <= now(), 'Observed work cannot be in the future.');
  const processId = words(v.process_id, 'Process ID'); need(processId === spec.assessment.candidate.process_id, 'Visit must reference the trial process.');
  need(Number.isInteger(v.process_revision) && v.process_revision > 0, 'Invalid process revision.');
  const processSnapshot = process(db, processId, v.process_revision);
  const amount = w.amount === null ? null : number(w.amount, 'Workload', true), unit = words(w.unit, 'Workload unit'); need(unit === spec.workload_unit, 'Workload units must match the registered trial.');
  const staffing = c.staffing === null ? null : number(c.staffing, 'Staffing', true); need(staffing === null || Number.isInteger(staffing), 'Staffing must be a whole number.');
  need(['full', 'partial', 'unknown'].includes(c.coverage), 'Invalid observation coverage.'); need(c.quality_passed === null || typeof c.quality_passed === 'boolean', 'Quality must be verified true/false or unknown.');
  need(c.intervention_applied === undefined || c.intervention_applied === null || typeof c.intervention_applied === 'boolean', 'Intervention use must be confirmed true/false or unknown.');
  const context: VisitContext = { intervention_applied: c.intervention_applied ?? null, implementation_note: words(c.implementation_note ?? '', 'Implementation evidence', c.intervention_applied !== true), staffing, equipment: c.equipment === null ? null : words(c.equipment, 'Equipment'), conditions: c.conditions === null ? null : words(c.conditions, 'Conditions'), quality_criteria: words(c.quality_criteria, 'Quality criteria'), quality_passed: c.quality_passed, coverage: c.coverage, coverage_note: words(c.coverage_note, 'Coverage explanation') };
  need(Array.isArray(v.measurements) && v.measurements.length <= spec.metrics.length, 'Invalid measurements.');
  const measurements: OutcomeMeasurement[] = v.measurements.map((raw: unknown) => {
    const m = obj(raw), metric = spec.metrics.find(s => s.id === m.metric_id); need(metric, 'Unknown registered metric.');
    need(m.unit === metric.unit, 'Measurement unit must match the registered metric; convert explicitly.');
    need(['measured', 'estimated', 'unknown'].includes(m.kind), 'Invalid measurement kind.'); need(['operator', 'instrument', 'continuous_video', 'sparse_frames'].includes(m.method), 'Invalid measurement method.');
    const value = m.value === null ? null : number(m.value, 'Measurement'); need(m.kind !== 'unknown' || value === null, 'Unknown measurements must have null values.');
    return { metric_id: metric.id, value, unit: metric.unit, kind: m.kind, method: m.method, source: words(m.source, 'Measurement evidence') };
  });
  need(new Set(measurements.map(m => m.metric_id)).size === measurements.length, 'Duplicate metric measurements.');
  return { id, revision, observed_at: observed, reference: s.reference, source_snapshot: s.snapshot, source_digest: hash(s.snapshot), source_identity: s.identity, continuous_coverage: s.continuous, quarantined: s.quarantined,
    process_id: processId, process_revision: v.process_revision, process_snapshot: processSnapshot, workload: { amount, unit, context: words(w.context, 'Workload context') }, context, measurements, notes: words(v.notes ?? '', 'Visit notes', true) };
}
function receipt(db: DatabaseSync, requestId: string, payload: unknown): { key: string; previous: string | null } {
  words(requestId, 'Request ID'); const key = `outcome-request:${hash(requestId)}`, existing = get<{ digest: string; id: string }>(db, key);
  need(!existing || existing.digest === hash(payload), 'Request ID reused with different inputs.'); return { key, previous: existing?.id ?? null };
}
/** Freeze an accepted improvement, predicted effects, validation policy and baseline before the trial. */
export function registerTrial(root: string, raw: unknown): InterventionTrial {
  const v = obj(raw);
  return atomic(root, db => {
    const req = receipt(db, v.request_id, v); if (req.previous) return trial(db, req.previous);
    const review = get<ImprovementReview>(db, `improvements:${words(v.review_id, 'Review ID')}`); need(review, 'Improvement review not found.');
    const assessment = review.assessments.find(a => a.candidate.id === v.candidate_id); need(assessment && assessment.decision === 'accepted' && assessment.feasibility === 'eligible', 'Accept an eligible improvement before registering a trial.');
    need(hash(get(db, 'workflow-context')) === hash(review.context), 'Stale improvement context. Regenerate the review.');
    for (const b of review.process_basis) { const row = db.prepare('SELECT MAX(rev) AS rev FROM processes WHERE id=?').get(b.process_id) as { rev: number }; need(row.rev === b.rev, 'Stale improvement process. Regenerate the review.'); }
    need(Array.isArray(v.metrics) && v.metrics.length > 0 && v.metrics.length <= 20, 'Register one to twenty metrics.');
    const metrics: MetricSpec[] = v.metrics.map((x: unknown) => { const m = obj(x); need(['lower', 'higher'].includes(m.direction), 'Invalid metric direction.'); return { id: words(m.id, 'Metric ID'), label: words(m.label, 'Metric label'), unit: words(m.unit, 'Metric unit'), direction: m.direction, tolerance: number(m.tolerance, 'Unchanged tolerance') }; });
    need(new Set(metrics.map(m => m.id)).size === metrics.length, 'Duplicate metric IDs.');
    const at = now(), started = v.started_at ? instant(v.started_at) : at; need(started <= at, 'Trial start cannot be in the future.');
    need(!v.started_at || v.retrospective === true, 'Supplying a past start requires retrospective:true; do not claim preregistration.');
    const expected = v.expected_changes ?? []; need(Array.isArray(expected) && expected.length <= 3, 'Invalid expected context changes.');
    const expectedChanges: InterventionTrial['expected_changes'] = expected.map((x: unknown) => { const e = obj(x); need(['staffing', 'equipment', 'conditions'].includes(e.field), 'Invalid expected context field.'); const value = e.field === 'staffing' ? number(e.value, 'Expected staffing', true) : words(e.value, 'Expected context'); if (e.field === 'staffing') need(Number.isInteger(value), 'Staffing must be a whole number.'); return { field: e.field, value, reason: words(e.reason, 'Expected change rationale') }; });
    need(new Set(expectedChanges.map(e => e.field)).size === expectedChanges.length, 'Duplicate expected context changes.');
    const t: InterventionTrial = { schema: 'intervention-trial/1', id: randomUUID(), revision: 1, created_at: at, started_at: started, registration: v.started_at ? 'retrospective' : 'prospective', review_id: review.id, candidate_id: assessment.candidate.id, assessment, review_snapshot: review,
      metrics, workload_unit: words(v.workload_unit, 'Workload unit'), expected_changes: expectedChanges, baseline: null, registered_baseline: null, followups: [], decisions: [], corrections: [] };
    if (v.baseline) { t.baseline = visit(db, v.baseline, t); need(t.baseline.observed_at <= started, 'Baseline must precede the trial.'); need(t.baseline.process_revision === assessment.candidate.process_rev, 'Baseline must use the accepted candidate process revision.'); t.registered_baseline = structuredClone(t.baseline); }
    put(db, `intervention-trial:${t.id}`, t); put(db, req.key, { digest: hash(v), id: t.id }); return t;
  });
}
/** Add follow-up measurements or append an explicit correction, preserving every previous version. */
export function recordTrialVisit(root: string, raw: unknown): InterventionTrial {
  const v = obj(raw);
  return atomic(root, db => {
    const req = receipt(db, v.request_id, v); if (req.previous) return trial(db, req.previous);
    const t = trial(db, v.id); need(t.revision === v.revision, 'Stale trial revision. Reload before editing.');
    const reason = words(v.reason, 'Measurement rationale');
    let before: TrialVisit | null = null; let changed: TrialVisit;
    if (v.role === 'baseline') {
      before = t.baseline; const next = visit(db, v.visit, t, before?.id, (before?.revision ?? 0) + 1);
      need(next.observed_at <= t.started_at, 'Baseline must precede the trial.'); need(next.process_revision === t.assessment.candidate.process_rev, 'Baseline process revision differs from registered candidate.');
      need(!t.followups.some(f => f.source_identity === next.source_identity), 'Baseline and follow-up cannot use the same evidence.'); t.baseline = next; changed = next;
    } else {
      need(v.role === 'followup', 'Visit role must be baseline or followup.');
      before = v.visit_id ? t.followups.find(f => f.id === v.visit_id) ?? null : null; need(!v.visit_id || before, 'Follow-up visit not found.');
      const next = visit(db, v.visit, t, before?.id, (before?.revision ?? 0) + 1);
      need(next.observed_at >= t.started_at, 'Follow-up must be observed after the trial starts.');
      need(next.source_identity !== t.baseline?.source_identity && !t.followups.some(f => f.id !== next.id && f.source_identity === next.source_identity), 'Duplicate evidence: correct the existing visit instead of adding another trial observation.');
      changed = next; t.followups = [...t.followups.filter(f => f.id !== next.id), next].sort((a, b) => a.observed_at.localeCompare(b.observed_at) || a.id.localeCompare(b.id));
    }
    t.corrections.push({ at: now(), reason, visit_id: changed.id, before }); t.revision++; put(db, `intervention-trial:${t.id}`, t); put(db, req.key, { digest: hash(v), id: t.id }); return t;
  });
}
/** Compare comparable rates; never promote estimates, occluded work or confounded visits to proven savings. */
export function evaluateTrial(t: InterventionTrial, followupId?: string): TrialResult {
  const b = t.baseline, f = followupId ? t.followups.find(f => f.id === followupId) ?? null : t.followups.at(-1) ?? null;
  need(!followupId || f, 'Unknown follow-up visit.');
  const reasons: string[] = [], differences: TrialResult['context_differences'] = [];
  if (!b) reasons.push('Baseline measurements are missing.'); if (!f) reasons.push('Follow-up measurements are missing.');
  if (b && f) {
    if (f.context.intervention_applied !== true) reasons.push('Use of the selected intervention in follow-up work has not been verified.');
    if (b.quarantined || f.quarantined) reasons.push('A source session is quarantined because work-location identity is uncertain.');
    if (b.context.coverage !== 'full' || f.context.coverage !== 'full') reasons.push('Observation coverage is incomplete or unknown; hidden work is unresolved.');
    if (b.workload.amount === null || f.workload.amount === null) reasons.push('Comparable workload denominator is missing.');
    if (b.workload.context !== f.workload.context) { differences.push({ field: 'workload_context', before: b.workload.context, after: f.workload.context, planned: false }); reasons.push('Workload composition differs.'); }
    for (const field of ['staffing', 'equipment', 'conditions'] as const) {
      if (b.context[field] === null || f.context[field] === null) reasons.push(`${field} is unknown.`);
      else if (b.context[field] !== f.context[field]) { const planned = t.expected_changes.some(e => e.field === field && e.value === f.context[field]); differences.push({ field, before: b.context[field], after: f.context[field], planned }); if (!planned) reasons.push(`Unplanned ${field} change may confound the comparison.`); }
    }
    for (const e of t.expected_changes) if (f.context[e.field] !== e.value) reasons.push(`Registered ${e.field} change was not verified.`);
    if (b.context.quality_criteria !== f.context.quality_criteria) reasons.push('Quality criteria differ.');
    if (b.context.quality_passed === null || f.context.quality_passed === null) reasons.push('Quality outcome is unverified.');
    if (b.context.quality_passed === false) reasons.push('Baseline did not meet the registered quality criteria.');
  }
  const metrics = t.metrics.map(spec => {
    const bm = b?.measurements.find(m => m.metric_id === spec.id), fm = f?.measurements.find(m => m.metric_id === spec.id), metricReasons = [...reasons];
    const valid = (m: OutcomeMeasurement | undefined, v: TrialVisit | null): boolean => !!m && !!v && m.kind === 'measured' && m.value !== null && v.workload.amount !== null && m.method !== 'sparse_frames' && (m.method !== 'continuous_video' || v.continuous_coverage);
    if (!valid(bm, b)) metricReasons.push('Baseline metric lacks a supported measurement and denominator.');
    if (!valid(fm, f)) metricReasons.push('Follow-up metric lacks a supported measurement and denominator.');
    const rate = (m: OutcomeMeasurement | undefined, v: TrialVisit | null): number | null => { if (!valid(m, v)) return null; const value = m!.value! / v!.workload.amount!; if (!Number.isFinite(value)) { metricReasons.push('Normalized value exceeds supported numeric range.'); return null; } return value; };
    const baseline = rate(bm, b), followup = rate(fm, f);
    const delta = baseline === null || followup === null ? null : followup - baseline;
    const improvement = delta === null ? null : (spec.direction === 'lower' ? -delta : delta);
    const status: OutcomeStatus = delta === null ? 'unknown' : metricReasons.length ? 'inconclusive' : Math.abs(delta) <= spec.tolerance ? 'unchanged' : improvement! > 0 ? 'improved' : 'worse';
    const percent = baseline && improvement !== null ? improvement / baseline * 100 : null;
    return { metric_id: spec.id, label: spec.label, unit_per_workload: `${spec.unit}/${t.workload_unit}`, baseline, followup, delta, improvement_percent: percent !== null && Number.isFinite(percent) ? percent : null, status, reasons: metricReasons };
  });
  const statuses = metrics.map(m => m.status);
  const qualityFailed = !!b && !!f && b.context.quality_passed === true && f.context.quality_passed === false && b.context.quality_criteria === f.context.quality_criteria;
  let status: OutcomeStatus = !b || !f || statuses.every(s => s === 'unknown') ? 'unknown' : reasons.length || statuses.some(s => ['unknown', 'inconclusive'].includes(s)) ? 'inconclusive' : qualityFailed || statuses.includes('worse') ? 'worse' : statuses.includes('improved') ? 'improved' : 'unchanged';
  if (qualityFailed) reasons.push('Follow-up failed the baseline quality criteria; faster work is not an overall improvement.');
  if (qualityFailed && b && f && !reasons.some(r => !r.startsWith('Follow-up failed'))) status = 'worse';
  const evidenceDigest = hash({ metrics: t.metrics, expected_changes: t.expected_changes, baseline: b, followup: f, started_at: t.started_at });
  const decision = t.decisions.at(-1), latest = decision ? { ...decision, current: decision.evidence_digest === evidenceDigest } : null;
  const next = latest?.current ? latest.decision === 'reject' ? `Stop using this intervention: ${t.assessment.candidate.change}. Preserve unfinished work and review another method.` : latest.decision === 'revise' ? `Revise and retest: ${latest.revision_plan}. Keep unresolved work open.` : `Retain the reviewed change: ${t.assessment.candidate.change}. Continue verifying quality and the remaining work.` : latest?.decision === 'reject' ? `Previously rejected: ${t.assessment.candidate.change}. Keep it stopped while reviewing changed evidence.` : latest?.decision === 'revise' ? `Pending revision: ${latest.revision_plan}. Review changed evidence before adopting the revised method.` : status === 'unknown' || status === 'inconclusive' ? `Resolve missing measurements or changed conditions before judging ${t.assessment.candidate.change}.` : `Review the ${status} result and choose keep, revise, or reject for ${t.assessment.candidate.change}.`;
  return { trial_id: t.id, followup_id: f?.id ?? null, evidence_digest: evidenceDigest, status, metrics, context_differences: differences, reasons,
    source_warnings: [], causal_interpretation: 'Observed differences are not proof that the intervention caused them. Estimates and predictions remain separate.', latest_decision: latest, next_action: next };
}
function freshResult(db: DatabaseSync, t: InterventionTrial, followupId?: string): TrialResult {
  const result = evaluateTrial(t, followupId), f = t.followups.find(f => f.id === result.followup_id) ?? null;
  for (const v of [t.baseline, f].filter((v): v is TrialVisit => !!v)) {
    try { if (hash(source(db, v.reference).snapshot) !== v.source_digest) result.source_warnings.push(`Source for visit ${v.id} changed; measurements need correction/review.`); }
    catch { result.source_warnings.push(`Source for visit ${v.id} is unavailable; retained snapshot is historical evidence.`); }
  }
  if (hash(get(db, 'workflow-context')) !== hash(t.review_snapshot.context)) result.source_warnings.push('Current improvement constraints/evidence differ from the registered review; reassess feasibility before reuse.');
  const currentReview = get<ImprovementReview>(db, `improvements:${t.review_id}`);
  if (currentReview?.assessments.find(a => a.candidate.id === t.candidate_id)?.decision !== 'accepted') result.source_warnings.push('Original improvement approval is no longer accepted; review before reuse.');
  const expectedProcess = f?.process_revision ?? t.baseline?.process_revision ?? t.assessment.candidate.process_rev;
  const current = db.prepare('SELECT MAX(rev) AS rev FROM processes WHERE id=?').get(t.assessment.candidate.process_id) as { rev: number | null };
  if (current.rev !== expectedProcess) result.source_warnings.push('Current process differs from the evaluated process revision; review before reusing this recommendation.');
  if (result.source_warnings.length) { if (result.latest_decision) result.latest_decision.current = false; result.next_action = (result.latest_decision?.decision === 'reject' ? 'Keep the previously rejected intervention stopped. ' : result.latest_decision?.decision === 'revise' ? `Revision remains pending: ${result.latest_decision.revision_plan}. ` : '') + result.source_warnings.join(' '); }
  return result;
}
/** Record a farmer decision tied to the exact evaluated evidence; later corrections invalidate it. */
export function decideTrial(root: string, raw: unknown): InterventionTrial {
  const v = obj(raw);
  return atomic(root, db => {
    const req = receipt(db, v.request_id, v); if (req.previous) return trial(db, req.previous);
    const t = trial(db, v.id); need(t.revision === v.revision, 'Stale trial revision.');
    need(['keep', 'revise', 'reject'].includes(v.decision), 'Decision must be keep, revise or reject.');
    const result = freshResult(db, t, v.followup_id); need(result.evidence_digest === v.evidence_digest, 'Stale outcome evidence.');
    need(!result.source_warnings.length || v.decision !== 'keep', 'Stale source/process: review measurements before keeping this intervention.');
    const reason = words(v.reason, 'Decision rationale'), revisionPlan = v.decision === 'revise' ? words(v.revision_plan, 'Revision plan') : null;
    t.decisions.push({ decision: v.decision, reason, revision_plan: revisionPlan, at: now(), evidence_digest: result.evidence_digest, followup_id: result.followup_id }); t.revision++;
    put(db, `intervention-trial:${t.id}`, t); put(db, req.key, { digest: hash(v), id: t.id }); return t;
  });
}
/** List trials with fresh comparisons and exact stored visit/process snapshots. */
export function outcomeView(root: string): { trials: Array<{ trial: InterventionTrial; result: TrialResult }> } {
  return withDb(root, db => ({ trials: (db.prepare("SELECT body FROM docs WHERE key LIKE 'intervention-trial:%' ORDER BY updated_at DESC,key").all() as unknown as { body: string }[]).map(r => { const t = JSON.parse(r.body) as InterventionTrial; return { trial: t, result: freshResult(db, t) }; }) }));
}
/** Present stored compare sessions and exact reconciliation interpretations for attaching evidence. */
export function outcomeSources(root: string): unknown {
  return withDb(root, db => ({ sessions: db.prepare('SELECT s.spot_id,s.sid,s.created,p.name AS spot_name FROM sessions s LEFT JOIN spots p ON p.id=s.spot_id ORDER BY s.created DESC').all(),
    evidence: (db.prepare("SELECT body FROM docs WHERE key LIKE 'evidence-source:%' ORDER BY updated_at DESC").all() as unknown as { body: string }[]).flatMap(r => { const s = JSON.parse(r.body) as EvidenceSource; return s.interpretations.map(i => ({ source_id: s.id, interpretation_id: i.id, recorded_at: s.recorded_at, uploaded_at: s.uploaded_at, origin: i.origin, media: s.media })); }),
    processes: (db.prepare('SELECT id,rev,body FROM processes ORDER BY id,rev DESC').all() as unknown as Array<{ id: string; rev: number; body: string }>).map(p => ({ id: p.id, rev: p.rev, title: (JSON.parse(p.body) as ProcessDoc).title })) }));
}
/** Deterministic briefing supplement: farmer decisions and unresolved canonical tasks, never inferred completion. */
export function outcomeBriefing(root: string): { trials: Array<{ id: string; change: string; status: OutcomeStatus; decision: TrialResult['latest_decision']; next_action: string }>; next_actions: string[]; unresolved_tasks: Array<{ id: string; text: string; execution: string }> } {
  const entries = outcomeView(root).trials, tasks = planningView(root).tasks.filter(t => !['done', 'cancelled'].includes(t.execution));
  return { trials: entries.map(({ trial: t, result: r }) => ({ id: t.id, change: t.assessment.candidate.change, status: r.status, decision: r.latest_decision, next_action: r.next_action })), next_actions: entries.map(e => e.result.next_action), unresolved_tasks: tasks.map(t => ({ id: t.id, text: t.text, execution: t.execution })) };
}
/** Overlay authoritative trial decisions on generated narrative; generated actions remain suggestions for review. */
export function attachOutcomeBriefing(root: string, narrative: unknown): unknown {
  const brief = outcomeBriefing(root); if (!brief.trials.length) return narrative;
  const n = narrative && typeof narrative === 'object' && !Array.isArray(narrative) ? narrative as Record<string, unknown> : { overall: String(narrative ?? '') };
  return { ...n, intervention_outcomes: brief.trials, suggested_actions_for_review: n.next_actions ?? [], next_actions: [...brief.next_actions, ...brief.unresolved_tasks.map(t => `Unresolved (${t.execution}): ${t.text}`)], unresolved_tasks: brief.unresolved_tasks };
}
/** Shared JSON commands for the CLI and dashboard. */
export function outcomeCommand(root: string, raw: unknown): unknown {
  const v = obj(raw);
  switch (v.command) {
    case 'view': return outcomeView(root);
    case 'sources': return outcomeSources(root);
    case 'register': return registerTrial(root, v);
    case 'visit': return recordTrialVisit(root, v);
    case 'decide': return decideTrial(root, v);
    case 'briefing': return outcomeBriefing(root);
    case 'evaluate': return withDb(root, db => freshResult(db, trial(db, v.id), v.followup_id));
    default: throw new OutcomeError('Unknown outcome command.');
  }
}
