/** Resumable video-first journeys. These records link canonical evidence/processes/goals/tasks;
 * they do not own another planner, task database, or spatial model. */
import { createHash, randomUUID } from 'node:crypto';
import type { RecordTransaction } from './record-model.js';
import { withRecords } from './records.js';
import { addGoalInDb, type NewGoal } from './goals.js';
import { createTaskInDb, tasks, planningView, previewPlan } from './task-planning.js';
import { buildProcessFromScan, correctProcessInDb, normalizeProcess, validateProcess, type ProcessDoc, type CorrectionPatch } from './processes.js';
import { ingestEvidence, reconciliationView, type EvidenceSource } from './reconciliation.js';
import { reconcileVideo, type ScanRunner } from './reconciliation-video.js';
import { listImprovementReviews, readImprovementReviewInDb } from './improvements.js';
import { outcomeView } from './outcomes.js';
import { instant, localParts } from './planning-time.js';

export interface JourneyClip {
  source_id: string; role: 'baseline' | 'additional' | 'followup'; task_id: string | null;
  process_id: string | null; interpretation_id: string | null; reviewed_revision: number | null;
}
export interface Journey {
  schema: 'work-journey/1'; id: string; revision: number; title: string; created_at: string; updated_at: string;
  clips: JourneyClip[]; goal_ids: string[]; task_ids: string[]; desired_improvement: string;
  intent_confirmed: boolean;
  observation_only?: boolean;
  next_draft?: { text: string; outcome: string; basis: string };
  next_decision?: { choice: 'do' | 'later' | 'done' | 'finish'; text: string; at: string; basis: string; task_id: string | null };
  method: { decision: 'retain' | 'intervention'; reason: string; basis: string; review_id: string | null; candidate_id: string | null } | null;
  history: Array<{ at: string; action: string; reason: string; before: unknown }>;
}
export class JourneyError extends Error {}
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new JourneyError(message); }
function object(raw: unknown): Record<string, any> { check(raw && typeof raw === 'object' && !Array.isArray(raw), 'Expected an object.'); return raw as Record<string, any>; }
function text(raw: unknown, label: string, empty = false): string { check(typeof raw === 'string' && (empty || !!raw.trim()) && raw.length <= 2000, `${label} must be short text.`); return raw.trim(); }
function hash(raw: unknown): string { return createHash('sha256').update(JSON.stringify(raw)).digest('hex'); }
function get<T>(db: RecordTransaction, key: string): T | null { const row = db.first('docs', { where: { key: key }, fields: ["body"] }) as { body: string } | undefined; return row ? JSON.parse(row.body) : null; }
function put(db: RecordTransaction, key: string, value: unknown): void { db.insert('docs', { key: key, body: JSON.stringify(value), updated_at: new Date().toISOString() }, { conflict: ["key"], update: ["body","updated_at"] }); }
function all(db: RecordTransaction): Journey[] { return (db.select('docs', { prefix: { key: "journey:" }, order: ["-updated_at","key"], fields: ["body"] }) as unknown as { body: string }[]).map(r => JSON.parse(r.body)); }
function read(db: RecordTransaction, id: string): Journey { const j = get<Journey>(db, `journey:${id}`); check(j, 'Workflow not found.'); return j; }
function source(db: RecordTransaction, id: string): EvidenceSource { const s = get<EvidenceSource>(db, `evidence-source:${id}`); check(s, 'Retained evidence not found.'); return s; }
function processDoc(db: RecordTransaction, id: string): ProcessDoc { const row = db.first('processes', { where: { id: id }, order: ["-rev"], fields: ["body"] }) as { body: string } | undefined; check(row, 'Process not found.'); return JSON.parse(row.body); }
function basis(db: RecordTransaction, j: Journey): string { return hash({ processes: j.clips.filter(c => c.role !== 'followup').map(c => ({ id: c.process_id, rev: c.process_id ? processDoc(db, c.process_id).rev : null, interpretation: source(db, c.source_id).interpretations.at(-1)?.id ?? null })), goals: j.goal_ids.map(id => db.first('goals', { where: { id: id } })), desire: j.desired_improvement }); }
function reviewed(db: RecordTransaction, j: Journey): boolean { return j.clips.filter(c => c.role !== 'followup').every(c => c.process_id && c.reviewed_revision === processDoc(db, c.process_id).rev && c.interpretation_id === source(db, c.source_id).interpretations.at(-1)?.id && !source(db,c.source_id).processing); }
/** A revisable suggestion, never a claim that unobserved work happened or a calendar booking. */
function nextProposal(db: RecordTransaction, j: Journey) {
  const stamp = basis(db, j);
  const clip = [...j.clips].reverse().find(c => c.role !== 'followup' && c.process_id);
  const p = clip?.process_id ? processDoc(db, clip.process_id) : null;
  const draft = j.next_draft;
  const suggested = p?.steps.find(s => s.observed_order === null && s.execution === 'not_started');
  return { basis: stamp, current: p?.steps.filter(s => s.observed_order !== null).at(-1)?.label ?? 'No observed state yet',
    outcome: draft?.outcome ?? p?.stage ?? 'Check the result of the recorded work',
    text: draft?.text ?? suggested?.label ?? 'Check the result of the recorded work',
    origin: draft ? 'human' : 'proposed', correction_needs_review: !!draft && draft.basis !== stamp, decision: j.next_decision?.basis === stamp ? j.next_decision : null };
}
async function atomic<T>(root: string, fn: (db: RecordTransaction) => T): Promise<T> { return withRecords(root, fn); }
function save(db: RecordTransaction, j: Journey, action: string, reason: string, before: unknown): Journey { j.revision++; j.updated_at = new Date().toISOString(); j.history.push({ at: j.updated_at, action, reason, before }); put(db, `journey:${j.id}`, j); return j; }

/** Attach retained evidence before inference. Identical bytes resume the original workflow. */
export async function attachJourneySource(root: string, sourceId: string, raw: unknown = {}): Promise<Journey> {
  const v = object(raw);
  return await atomic(root, db => {
    const s = source(db, sourceId); check(s.kind === 'video', 'Capture requires video evidence.');
    const existing = all(db).find(j => j.clips.some(c => c.source_id === sourceId));
    if (existing) { check(!v.workflow_id || existing.id === v.workflow_id, 'This clip already belongs to another workflow. Resume its review.'); return existing; }
    const role = v.role ?? (v.workflow_id ? 'additional' : 'baseline');
    check(['baseline', 'additional', 'followup'].includes(role), 'Invalid capture role.');
    check(role === 'baseline' || v.workflow_id, 'Choose a workflow for additional or follow-up footage.');
    const now = new Date().toISOString();
    const j: Journey = v.workflow_id ? read(db, v.workflow_id) : { schema: 'work-journey/1', id: randomUUID(), revision: 0, title: 'Work review', created_at: now, updated_at: now, clips: [], goal_ids: [], task_ids: [], desired_improvement: '', intent_confirmed: false, method: null, history: [] };
    check(!v.workflow_id || v.revision === j.revision, 'Stale workflow revision.');
    check(role !== 'baseline' || !j.clips.length, 'Use additional footage to extend an existing workflow.');
    if (role === 'followup') check(j.task_ids.includes(v.task_id) && s.context.task_ids.includes(v.task_id), 'Choose an existing workflow task for this follow-up.');
    j.clips.push({ source_id: s.id, role, task_id: role === 'followup' ? v.task_id : null, process_id: null, interpretation_id: null, reviewed_revision: null });
    return save(db, j, 'capture', role === 'followup' ? 'Follow-up linked to existing work; task occurrence still needs confirmation.' : 'Clip retained before interpretation; no tasks or goals inferred as commitments.', null);
  });
}

/** Materialize a process once per initial interpretation. Recovery reuses stored analysis. */
export async function syncJourneySource(root: string, workflowId: string, sourceId: string): Promise<Journey> {
  return await atomic(root, db => {
    const j = read(db, workflowId), clip = j.clips.find(c => c.source_id === sourceId); check(clip, 'Clip is not in this workflow.');
    const s = source(db, sourceId), interpretation = s.interpretations.at(-1);
    if (clip.role === 'followup' || !interpretation || clip.interpretation_id === interpretation.id) return j;
    // Every analysis attempt remains inspectable. It never overwrites human corrections.
    const id = `journey-process-${hash({ source: s.id, interpretation: interpretation.id }).slice(0, 32)}`;
    const raw = object(interpretation.raw ?? {});
    const p = normalizeProcess(validateProcess(buildProcessFromScan({ id, media: s.media, model: interpretation.model, promptVersion: interpretation.prompt_version, recordedAt: s.recorded_at, duration_s: s.duration_s,
      analysis: { ...raw, per_frame: Array.isArray(raw.per_frame) ? raw.per_frame : interpretation.observations.map(o => o.text), frame_times_s: Array.isArray(raw.frame_times_s) ? raw.frame_times_s : interpretation.observations.map(o => o.start_s) } })));
    db.insert('processes', { id: id, rev: p.rev, body: JSON.stringify(p), author: interpretation.origin, created: p.created_at }, { ignore: true });
    const before = structuredClone(clip);
    if (clip.process_id && clip.process_id !== id) put(db, `superseded-process:${clip.process_id}`, { by: id, source_id: sourceId, reason: 'Explicit source reanalysis requires a new process review.' });
    clip.process_id = id; clip.interpretation_id = interpretation.id; clip.reviewed_revision = null;
    if (j.title === 'Work review') j.title = p.title;
    return save(db, j, 'interpretation', 'Source-linked observations await human review; future suggestions are separate.', before);
  });
}

export interface JourneyCaptureInput { media?: string; source_id?: string; workflow_id?: string; revision?: number; role?: 'baseline' | 'additional' | 'followup'; task_id?: string; recorded_at?: string | null; retry?: boolean; source_revision?: number; frames?: number }
/** Shared upload/CLI orchestration. Failures retain source and retry state without replaying mutations. */
export async function captureJourney(root: string, input: JourneyCaptureInput, run: ScanRunner, origin: 'model' | 'replay' = 'model'): Promise<Journey> {
  if (input.workflow_id) await withRecords(root, db => { const j = read(db, input.workflow_id!); if (!input.source_id) check(j.revision === input.revision, 'Stale workflow revision.'); if (input.role === 'followup') check(j.task_ids.includes(input.task_id!), 'Choose a task in this workflow.'); });
  const s = input.source_id ? (await reconciliationView(root)).sources.find(s => s.id === input.source_id) : (await ingestEvidence(root, { kind: 'video', media: input.media, recorded_at: input.recorded_at ?? null, context: { task_ids: input.role === 'followup' && input.task_id ? [input.task_id] : [] } }));
  check(s, 'Retained source not found.');
  const j = await attachJourneySource(root, s.id, input);
  // Reviewed initial analysis is stable. Reanalysis is explicit and makes its review pending.
  await reconcileVideo(root, { source_id: s.id, retry: input.retry, revision: input.source_revision, frames: input.frames }, run, origin);
  return await syncJourneySource(root, j.id, s.id);
}

/** Revision/receipt-protected transitions; side effects and references commit together. */
export async function journeyCommand(root: string, raw: unknown): Promise<unknown> {
  const v = object(raw);
  if (v.command === 'view') return await journeyView(root, v.now);
  return await atomic(root, db => {
    const request = text(v.request_id, 'Request ID'), key = `journey-request:${hash(request)}`, digest = hash(v);
    const receipt = get<{ digest: string; id: string }>(db, key);
    if (receipt) { check(receipt.digest === digest, 'Request ID reused with different input.'); return read(db, receipt.id); }
    const j = read(db, text(v.id, 'Workflow ID')); check(j.revision === v.revision, 'Stale workflow revision. Reload the review.');
    const { history: _history, ...before } = structuredClone(j); const reason = text(v.reason, 'Reason');
    if (v.command === 'correct' || v.command === 'review') {
      const clip = j.clips.find(c => c.source_id === v.source_id && c.role !== 'followup'); check(clip?.process_id, 'Choose an interpreted baseline or additional clip.');
      const p = processDoc(db, clip.process_id), s = source(db, clip.source_id);
      check(p.rev === v.process_revision && clip.interpretation_id === s.interpretations.at(-1)?.id && !s.processing, 'Stale process or interpretation. Resume analysis first.');
      if (v.command === 'correct') { const corrected = correctProcessInDb(db, root, p.id, object(v.patch) as CorrectionPatch, reason, 'farmer', v.process_revision); if (clip.role === 'baseline' && v.patch.title !== undefined) j.title = corrected.doc.title; clip.reviewed_revision = null; }
      else clip.reviewed_revision = p.rev;
    } else if (v.command === 'next_correct' || v.command === 'next_decide') {
      check(reviewed(db,j), 'Review the observed work first.');
      const proposal = nextProposal(db,j);
      check(v.basis === proposal.basis, 'The proposal changed. Review it again.');
      check(!proposal.decision, 'This proposal already has a decision. Resume it before changing it.');
      if (v.command === 'next_correct') {
        j.next_draft = { text: text(v.text,'Next action'), outcome: text(v.outcome,'Intended result'), basis: proposal.basis };
      } else {
        check(['do','later','done','finish'].includes(v.choice), 'Choose what to do next.');
        let taskId: string | null = null;
        if (v.choice === 'do' || v.choice === 'later') {
          const task = createTaskInDb(db, { text: proposal.text, completion_criteria: '', links: [], review: 'confirmed', execution: 'open' }, `journey-next:${j.id}:${request}`);
          taskId = task.id; j.task_ids.push(task.id);
          // Accepting an action does not establish goals, durations, successful outcomes or a booking.
        }
        j.next_decision = { choice:v.choice, text:proposal.text, at:new Date().toISOString(), basis:proposal.basis, task_id:taskId };
        j.observation_only = !j.task_ids.length;
      }
    } else if (v.command === 'save_observation') {
      check(reviewed(db, j), 'Review all observed work before saving an observation.');
      check(!j.task_ids.length, 'Existing future work must remain in its planning workflow.');
      j.observation_only = true;
    } else if (v.command === 'resume_planning') {
      check(!j.next_decision?.task_id, 'Open the existing task to change this accepted action.');
      j.observation_only = false;
      j.next_decision = undefined;
    } else if (v.command === 'goal') {
      j.observation_only = false;
      check(reviewed(db, j), 'Review the observed work before clarifying intent.');
      const desire = text(v.desired_improvement, 'Desired improvement (or explicitly none)');
      let id: string;
      if (v.goal_id) { id = text(v.goal_id, 'Goal ID'); const goal = db.first('goals', { where: { id: id } }); check(goal, 'Goal not found.'); }
      else { const g = object(v.goal); text(g.text, 'Desired outcome'); text(g.success_criteria, 'Success criteria'); check(Number.isInteger(g.weight) && g.weight >= 1 && g.weight <= 5, 'Priority must be 1–5.'); id = addGoalInDb(db, g as unknown as NewGoal).id; }
      j.goal_ids = [...new Set([...j.goal_ids, id])]; j.desired_improvement = desire; j.intent_confirmed = true;
    } else if (v.command === 'unassigned') {
      j.observation_only = false;
      check(reviewed(db,j), 'Review the observed work first.');
      j.intent_confirmed = true; j.desired_improvement = text(v.desired_improvement, 'Desired improvement (or explicitly none)');
    } else if (v.command === 'method') {
      check(reviewed(db, j) && j.intent_confirmed, 'Review work and clarify intent before choosing a method.');
      check(['retain', 'intervention'].includes(v.decision), 'Choose current practice or an accepted intervention.');
      if (v.decision === 'intervention') {
        // Read same stored review and validate current process/context using public service before writing.
        const review = readImprovementReviewInDb(db, text(v.review_id,'Review ID'));
        const assessment = review?.assessments.find(a => a.candidate.id === v.candidate_id);
        check(review && !review.stale && assessment?.decision === 'accepted' && assessment.feasibility === 'eligible' && j.clips.some(c => c.process_id === assessment.candidate.process_id), 'Choose a current accepted eligible improvement for this workflow.');
      }
      j.method = { decision: v.decision, reason, basis: basis(db,j), review_id: v.decision === 'intervention' ? text(v.review_id,'Review ID') : null, candidate_id: v.decision === 'intervention' ? text(v.candidate_id,'Candidate ID') : null };
    } else if (v.command === 'task') {
      check(reviewed(db,j) && j.intent_confirmed && j.method?.basis === basis(db,j), 'Review work, clarify intent and choose a current method before organizing future work.');
      if (j.method.decision === 'intervention') { const review = readImprovementReviewInDb(db, j.method.review_id!); check(!review.stale && review.assessments.some(a => a.candidate.id === j.method!.candidate_id && a.decision === 'accepted' && a.feasibility === 'eligible'), 'Stale or withdrawn improvement; review the method.'); }
      if (v.task_id) { check(tasks(db).some(t => t.id === v.task_id), 'Task not found.'); j.task_ids = [...new Set([...j.task_ids, v.task_id])]; }
      else {
        check(v.future_confirmed === true, 'Explicitly confirm this is future work, not an observed action.');
        const patch = object(v.task); text(patch.completion_criteria,'Completion criteria');
        check(!patch.execution || patch.execution === 'open', 'New future work starts open.');
        check(!patch.process || j.clips.some(c => c.process_id === patch.process.id && c.reviewed_revision === patch.process.revision), 'Use a reviewed process in this workflow.');
        check(Array.isArray(patch.links) && patch.links.every((l: any) => j.goal_ids.includes(l.goal_id) && l.origin === 'human' && l.review === 'confirmed'), 'Confirm links to this workflow’s goals, or leave unassigned.');
        const task = createTaskInDb(db, { ...patch, review: 'confirmed', execution: 'open' }, `journey:${j.id}:${request}`);
        j.task_ids.push(task.id);
      }
    } else if (v.command === 'rename') j.title = text(v.title,'Workflow title');
    else throw new JourneyError('Unknown journey command.');
    save(db,j,v.command,reason,before); put(db,key,{digest,id:j.id}); return j;
  });
}

/** Read a resumable journey plus live references; corrections invalidate reviews/choices without losing history. */
export async function journeyView(root: string, at = new Date().toISOString()) {
  const now = instant(at), planning = await planningView(root), updates = await reconciliationView(root), outcomes = await outcomeView(root), improvements = await listImprovementReviews(root);
  const preview = await previewPlan(root, localParts(now, planning.schedule.config.timezone).day, now);
  const workflows = await withRecords(root, db => all(db).map(j => {
    const clips = j.clips.map(c => ({ ...c, source: source(db,c.source_id), process: c.process_id ? processDoc(db,c.process_id) : null }));
    const currentTasks = planning.tasks.filter(t => j.task_ids.includes(t.id));
    const reviews = improvements.filter(r => r.assessments.some(a => clips.some(c => c.process_id === a.candidate.process_id)));
    const candidate = j.method?.decision === 'intervention' ? reviews.find(r => r.id === j.method!.review_id) : null;
    let methodCurrent = !!j.method && j.method.basis === basis(db,j) && (j.method.decision === 'retain' || !!candidate && !candidate.stale && candidate.assessments.some(a => a.candidate.id === j.method!.candidate_id && a.decision === 'accepted' && a.feasibility === 'eligible'));
    const trials = outcomes.trials.filter(t => clips.some(c => c.process_id === t.trial.assessment.candidate.process_id));
    const methodTrial = j.method?.decision === 'intervention' ? trials.filter(t => t.trial.candidate_id === j.method!.candidate_id && (t.trial.review_id === j.method!.review_id || t.trial.assessment.candidate.change === candidate?.assessments.find(a => a.candidate.id === j.method!.candidate_id)?.candidate.change)).sort((a,b)=>b.trial.created_at.localeCompare(a.trial.created_at))[0] : null;
    if (methodTrial && (methodTrial.result.latest_decision?.decision === 'reject' || methodTrial.result.latest_decision?.decision === 'revise' || methodTrial.result.followup_id && (!methodTrial.result.latest_decision?.current || methodTrial.result.latest_decision.decision !== 'keep'))) methodCurrent = false;
    const baselineReviewed = reviewed(db,j);
    const followups = updates.sources.filter(s => j.clips.some(c => c.role === 'followup' && c.source_id === s.id) || s.context.task_ids.some(id => j.task_ids.includes(id)) || s.associations.some(a => a.decision === 'confirmed' && j.task_ids.includes(a.task_id)));
    const pending = followups.filter(s => !['applied','no_material_change'].includes(s.stage));
    const blocks = planning.schedule.blocks.filter(b => j.task_ids.includes(b.task_id) && b.status === 'accepted');
    const stage = !baselineReviewed ? 'review' : j.observation_only && !currentTasks.length ? 'saved' : !j.intent_confirmed ? 'goals' : !methodCurrent ? 'improvements' : !currentTasks.length ? 'tasks' : pending.length ? 'followup' : blocks.length ? 'today' : 'schedule';
    const proposal = nextProposal(db,j);
    const next = baselineReviewed && !j.intent_confirmed ? (proposal.decision ? 'Next action saved. Open the workflow to continue.' : 'Choose the suggested next action, correct it, or finish here.') : ({saved:'Observation saved. No future work was created. Resume planning whenever you need it.',review:'Resume review: inspect the clip, correct observations and confirm what is known.',goals:'Confirm what you want to accomplish and what you want to improve.',improvements:'Compare supported improvements or explicitly retain current practice.',tasks:'Choose future work and confirm its contribution to your goals.',followup:'Review what the follow-up changes before adapting the plan.',schedule:'Review estimates and availability, then propose a day plan.',today:'Follow accepted work; record progress or review changed conditions.'} as Record<string,string>)[stage];
    return { workflow:j, proposal, clips, tasks:currentTasks, goals:planning.goals.filter(g => j.goal_ids.includes(g.id)), stage, next, baseline_reviewed:baselineReviewed, method_current:methodCurrent, followups, pending_reviews:pending.length, blocks, improvements:reviews, outcomes:trials, outcome_status:trials.length ? null : 'Unknown: no intervention trial with comparable baseline and follow-up measurements is registered.' };
  }));
  const nextTask = planning.tasks.find(t => t.id === preview.next.task_id) ?? null;
  const nextBlock = nextTask ? [...preview.preserved,...preview.blocks].filter(b => b.task_id === nextTask.id).sort((a,b)=>a.start.localeCompare(b.start))[0] : null;
  const accepted = !!nextBlock && planning.schedule.blocks.some(b => b.id === nextBlock.id && b.status === 'accepted');
  const workflowWarnings = workflows.filter(w => w.tasks.some(t => t.id === nextTask?.id) && (!w.baseline_reviewed || !w.method_current && w.proposal.decision?.task_id !== nextTask?.id));
  return { schema:'work-journey-view/1' as const, now, workflows, planning, today:{ next: workflowWarnings.length ? {action:'inspect',task_id:null,reason:'The workflow’s observations, goal or method changed. Resume its review before acting.'} : preview.next, task:workflowWarnings.length ? null : nextTask, block:nextBlock, accepted, goals:nextTask ? planning.goals.filter(g=>nextTask.links.some(l=>l.goal_id===g.id&&l.review==='confirmed')) : [], conflicts:preview.conflicts, deferred:preview.deferred, agenda:planning.schedule.blocks.filter(b=>b.status==='accepted'&&localParts(b.start,planning.schedule.config.timezone).day===localParts(now,planning.schedule.config.timezone).day), commitments:planning.events.filter(e=>e.timing&&localParts(e.timing.start,planning.schedule.config.timezone).day===localParts(now,planning.schedule.config.timezone).day) } };
}

