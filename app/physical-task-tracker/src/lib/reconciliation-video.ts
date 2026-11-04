/** Video follow-up adapter. Model output is evidence/proposals, never an accepted task mutation. */
import { scanRetainedVideo } from './asset-video.js';
import { ingestEvidence, beginInterpretation, finishInterpretation, failInterpretation, proposeChange, reconciliationView, type EvidenceSource, type Observation } from './reconciliation.js';
export interface VideoFollowupInput { media?: string; task_id?: string; recorded_at?: string | null; source_id?: string; revision?: number; retry?: boolean; frames?: number }
export type ScanRunner = (file: string, args: string[]) => Promise<unknown>;

/** Process a retained source, preserving retry state even if model extraction fails. */
export async function reconcileVideo(root: string, input: VideoFollowupInput, run: ScanRunner, origin: 'model' | 'replay' = 'model'): Promise<EvidenceSource> {
  let source = input.source_id ? (await reconciliationView(root)).sources.find(s => s.id === input.source_id) : (await ingestEvidence(root, {
    kind: 'video', media: input.media, recorded_at: input.recorded_at ?? null,
    time_uncertainty: input.recorded_at ? 'Operator supplied recording time' : 'Recording time unknown', context: { task_ids: input.task_id ? [input.task_id] : [] }
  }));
  if (!source || source.kind !== 'video' || !source.media) throw new Error('Retained video not found.');
  if (!input.retry && (source.processing || source.interpretations.length)) return source;
  if (input.retry && input.revision !== source.revision) throw new Error('Stale evidence revision.');
  source = (await beginInterpretation(root, source.id, source.revision, input.retry === true));
  const token = source.processing!.token;
  try {
    const task = source.baseline.find(t => t.id === source!.context.task_ids[0]);
    const extra: string[] = [];
    if (task) extra.push('--task-context', JSON.stringify({ id: task.id, text: task.text, quantity: task.quantity, completion_criteria: task.completion_criteria, location: task.location }));
    const raw = await scanRetainedVideo(root,source.media!,Math.min(12,Math.max(1,Number(input.frames)||4)),`review-${source.id}-${token}`,run,extra);
    const lines = Array.isArray(raw.per_frame) ? raw.per_frame : [], times = Array.isArray(raw.frame_times_s) ? raw.frame_times_s : [];
    const observations: Observation[] = lines.flatMap((line, i) => typeof line === 'string' && line.trim() ? [{ id: `frame-${i}`, text: line.slice(0, 4000), start_s: typeof times[i] === 'number' && Number.isFinite(times[i]) && times[i] >= 0 ? times[i] : null,
      end_s: typeof times[i] === 'number' && Number.isFinite(times[i]) && times[i] >= 0 ? times[i] : null,
      confidence: ['low', 'medium', 'high'].includes(String(raw.confidence)) ? raw.confidence as Observation['confidence'] : 'unknown', coverage: 'sampled' as const,
      uncertainty: `Sparse frames do not establish continuous work or completion. ${raw.frame_times_estimated ? 'Frame times estimated. ' : ''}${Array.isArray(raw.unknowns) ? raw.unknowns.join('; ').slice(0, 3000) : 'Unknown coverage.'}` }] : []);
    if (!observations.length) observations.push({ id: 'summary', text: typeof raw.observed_task === 'string' ? raw.observed_task.slice(0, 4000) : 'No usable observation extracted', start_s: null, end_s: null, confidence: 'unknown', coverage: 'sampled', uncertainty: 'No frame-specific evidence. Confirm identity and quantity manually.' });
    source = (await finishInterpretation(root, source.id, token, { origin, model: typeof raw.model === 'string' ? raw.model : 'unknown', prompt_version: typeof raw.prompt_version === 'string' ? raw.prompt_version : 'unknown', observations, metadata: { duration_s: raw.video_duration_s ?? null, recorded_at: raw.recorded_at ?? null, recorded_source: raw.recorded_source ?? 'unknown', video: raw.video_metadata ?? null, frame_times_estimated: raw.frame_times_estimated ?? null }, raw }));
    // A single supported quantitative/blocker claim may be proposed. Invalid model fields remain raw evidence.
    const claim = raw.work_update && typeof raw.work_update === 'object' ? raw.work_update as Record<string, unknown> : null;
    const obs = claim && observations.find(o => o.id === `frame-${claim.frame_index}`);
    if (task && claim && obs && typeof claim.evidence === 'string' && claim.evidence.trim()) {
      const patch: Record<string, unknown> = {}, quantity: Record<string, unknown> = {};
      let kind = 'progress';
      if (claim.remaining_quantity !== null && typeof claim.remaining_quantity === 'number' && task.quantity && claim.unit === task.quantity.unit && claim.remaining_quantity >= 0 && claim.remaining_quantity <= task.quantity.total) Object.assign(quantity, { quantity_mode: 'remaining', quantity_value: claim.remaining_quantity, unit: claim.unit });
      if (typeof claim.blocker === 'string' && claim.blocker.trim()) { patch.execution = 'blocked'; patch.preconditions = [...task.preconditions, { text: claim.blocker.slice(0, 2000), status: 'unmet' }]; kind = 'blocker'; }
      // Never turn the model's completion assertion into completion without a person choosing that proposal.
      if (Object.keys(patch).length || Object.keys(quantity).length) source = (await proposeChange(root, source.id, source.revision, { task_id: task.id, observation_id: obs.id, kind, patch, ...quantity, reason: claim.evidence.slice(0, 4000), uncertainty: obs.uncertainty }));
    }
    return source;
  } catch (error) {
    // Finish may have succeeded before a malformed optional claim; retain that successful interpretation.
    const current = (await reconciliationView(root)).sources.find(s => s.id === source!.id)!;
    if (current.processing?.token === token) return await failInterpretation(root, current.id, token, (error as Error).message);
    if (current.interpretations.length) return current;
    throw error;
  }
}

