/** Thin consumer adapter. OI alone validates poses, applies transforms and persists revisions. */
import { createHash } from 'node:crypto';
import { OiRunnerTransport, resolveOiRoot, type OiTransport } from './oi-connector.js';
import { verifiedWalkthrough } from './walkthrough.js';

export type ReconstructionVector = [number, number, number];
export interface ReconstructionMeasurement {
  id: string; artifact_id: string; anchor_ids: [string, string]; points: [ReconstructionVector, ReconstructionVector];
  measured_m: number; tolerance_m: number;
}
export interface ReconstructionCandidate {
  id: string; observation_ids: string[]; frame_id: string; name: string;
  status: 'confirmed' | 'rejected' | 'unreviewed'; epistemic_status: 'observed' | 'inferred' | 'surveyed';
  confidence: number | null; unknowns: string[];
  identity: { action: 'create' | 'update'; entity_id: string | null };
  geometry: { kind: 'oi-asset-placement' | 'point-cloud' | 'mesh' | 'region' | 'missing-depth';
    asset_version?: string; position?: ReconstructionVector; rotation_degrees?: ReconstructionVector; artifact_id?: string };
}
export interface ReconstructionRequest {
  schema: 'oi-reviewed-reconstruction/1'; request_id: string; scene_id: string; base_revision: number;
  source: { id: string; run_id: string; revision: number; schema: string; artifacts: Array<{id: string; uri: string; sha256: string}> };
  frame: { id: string; units: 'm' | 'cm' | 'mm' | 'predicted_m'; handedness: 'right' | 'left'; axes: string;
    direction: 'source-to-oi'; layout: 'row-major'; target: 'oi-world-m-Y-up'; matrix: number[] };
  scale: { predicted_m_per_unit: number | null; calibration: ReconstructionMeasurement | null;
    holdout: ReconstructionMeasurement | null; holdout_independence: 'not-established' | 'reviewer-attested' };
  candidates: ReconstructionCandidate[];
}
export interface ReconstructionResult {
  schema: string; scene_id: string; base_revision: number; revision: number | null; preview_token: string;
  committed: boolean; replayed: boolean; can_commit: boolean;
  items: Array<{ candidate_id: string; status: string; code?: string; entity_id?: string; position?: number[]; rotation?: number[] }>;
  bindings: Array<{ source_id: string; observation_id: string; candidate_id: string; entity_id: string; entity_kind: 'instance' }>;
  scale: { status: string; accuracy_certified: false; [key: string]: unknown };
  loss_report: unknown[]; warnings: string[]; mock: false;
}

/** Execute the discoverable JSON interface in the pinned OI runtime, with no application server. */
export async function reconstructionCommand(action: 'capabilities' | 'preview' | 'commit' | 'inspect', payload: Record<string, unknown>,
  transport: OiTransport = new OiRunnerTransport(resolveOiRoot())): Promise<unknown> {
  const request = payload.request as ReconstructionRequest | undefined;
  if ((action === 'preview' || action === 'commit') && request?.source?.schema === 'walkthrough-observations/1') {
    if (typeof payload.projectRoot !== 'string') throw new Error('Walkthrough imports require projectRoot so current reviews and evidence can be rechecked.');
    const current = await prepareWalkthroughReconstruction(payload.projectRoot, request.source.run_id, request.source.revision, request);
    if (JSON.stringify(current.source) !== JSON.stringify(request.source)) throw new Error('Walkthrough provenance changed; prepare a fresh import request.');
  }
  const { projectRoot: _projectRoot, ...oiPayload } = payload;
  return transport.request('reconstruction', { ...oiPayload, action });
}

/** Package explicitly reviewed MapAnything evidence. No centroid-to-shape or pixel-to-world inference is performed. */
export async function prepareWalkthroughReconstruction(root: string, runId: string, runRevision: number,
  plan: Omit<ReconstructionRequest, 'source'>): Promise<ReconstructionRequest> {
  const run = await verifiedWalkthrough(root, runId);
  if (run.revision !== runRevision) throw new Error('Walkthrough changed; reread and review the current run revision.');
  if (!Array.isArray(plan.candidates) || plan.frame?.id !== 'mapanything-world' || plan.frame.units !== 'predicted_m')
    throw new Error('Walkthrough plans must explicitly name the mapanything-world frame and predicted_m units.');
  const reviews = new Map(run.reviews.map(r => [r.observation_id, r]));
  const candidates = plan.candidates.map(candidate => {
    if (!Array.isArray(candidate.observation_ids) || !candidate.observation_ids.length) throw new Error('Reviewed observation IDs are required.');
    const observations = candidate.observation_ids.map(id => {
      const observation = run.report.observations.find(o => o.id === id), review = reviews.get(id);
      if (!observation || review?.decision !== 'confirmed' || !review.static_confirmed || observation.motion === 'dynamic')
        throw new Error('Every proposed observation must have a current confirmed static review.');
      if (observation.geometry_status !== 'predicted' || !observation.predicted_centroid || observation.point_count <= 0)
        throw new Error('Depth-derived evidence is missing; no authoritative placement can be proposed.');
      return observation;
    });
    return { ...candidate, status: 'confirmed' as const, epistemic_status: 'inferred' as const,
      confidence: Math.min(...observations.map(o => o.score)),
      unknowns: [...candidate.unknowns, 'Asset correspondence, pose and 3D anchors are explicitly supplied by the reviewer; masks/centroids do not establish object geometry.',
        `Source mode: ${run.report.source}; image frames: ${observations.map(o => o.frame_id).join(', ')}.`] };
  });
  return { ...plan, candidates, source: { id: `walkthrough:${run.id}`, run_id: run.id, revision: run.revision, schema: run.report.schema,
    artifacts: [{ id: 'reviewed-run', uri: `fieldops://walkthrough/${run.id}?revision=${run.revision}`,
      sha256: createHash('sha256').update(JSON.stringify(run)).digest('hex') },
    ...run.report.artifacts.map(a => ({ id: a.file, uri: `fieldops://walkthrough/${run.id}/artifact/${a.file}`, sha256: a.sha256 }))] } };
}
