/** Capture/perception evidence owns no OI geometry, scene IDs, or spatial verdicts. */
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, copyFile, lstat } from 'node:fs/promises';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withRecords } from './records.js';

const execute = promisify(execFile);
export class WalkthroughError extends Error {}
export interface CaptureRequest {
  images?: string[]; video?: string; max_frames?: number; prompts?: string[]; mode: 'capture' | 'live';
}
export interface CaptureFrame {
  id: string; source_index: number; timestamp_s: number | null; file: string; sha256: string;
  sharpness: number; width: number; height: number; model_image?: string; geometry?: string;
  model_width?: number; model_height?: number;
}
export interface Observation {
  id: string; frame_id: string; prompt: string; score: number; box: number[]; mask: string; overlay: string;
  motion: 'dynamic' | 'unverified'; track_id: null; entity_id: null;
  predicted_centroid: number[] | null; point_count: number; valid_fraction: number; geometry_status: 'predicted' | 'missing_depth';
}
export interface CaptureReport {
  schema: 'walkthrough-observations/1'; source: 'capture' | 'live' | 'replay'; status: 'captured' | 'inferred' | 'failed';
  frames: CaptureFrame[]; observations: Observation[]; artifacts: Array<{ file: string; sha256: string }>;
  sources: unknown[]; prompts: string[]; warnings: string[]; coordinates: Record<string, unknown>;
  scale: { status: 'unverified'; calibration: null; holdout: null }; stats: Record<string, unknown>; error?: string;
}
export interface ObservationReview {
  observation_id: string; decision: 'confirmed' | 'rejected'; station: string | null;
  static_confirmed: boolean; rationale: string; at: string;
}
export interface ScaleMeasurement {
  frame_id: string; a: [number, number]; b: [number, number]; measured_m: number; source: string;
}
export interface WalkthroughRun {
  id: string; revision: number; created_at: string; report: CaptureReport;
  reviews: ObservationReview[]; measurements: { calibration: ScaleMeasurement; holdout: ScaleMeasurement } | null;
}
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new WalkthroughError(message); }
function record(value: unknown): Record<string, unknown> { check(value && typeof value === 'object' && !Array.isArray(value), 'Expected an object.'); return value as Record<string, unknown>; }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function safeName(value: unknown): asserts value is string { check(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value) && basename(value) === value, 'Invalid artifact name.'); }
function text(value: unknown): asserts value is string { check(typeof value === 'string' && value.trim().length > 0 && value.length <= 1000, 'Nonempty text required.'); }
function items(value: unknown): asserts value is unknown[] { check(Array.isArray(value), 'Expected an array.'); }
function sha(value: unknown): void { check(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), 'Invalid SHA-256.'); }

/** Validate the worker boundary, including replay files and frame/mask correspondence. */
export function parseCaptureReport(value: unknown): CaptureReport {
  const r = record(value);
  check(r.schema === 'walkthrough-observations/1', 'Unsupported walkthrough schema.');
  check(['capture', 'live', 'replay'].includes(String(r.source)), 'Invalid source type.');
  check(['captured', 'inferred', 'failed'].includes(String(r.status)), 'Invalid run status.');
  for (const key of ['frames', 'observations', 'artifacts', 'sources', 'prompts', 'warnings']) items(r[key]);
  check((r.frames as unknown[]).length >= 2 && (r.frames as unknown[]).length <= 12, 'Expected 2–12 selected frames.');
  check((r.observations as unknown[]).length <= 9600, 'Too many observations.');
  const artifacts = new Map<string, string>();
  for (const raw of r.artifacts as unknown[]) { const a = record(raw); safeName(a.file); sha(a.sha256); check(!artifacts.has(a.file), 'Duplicate artifact.'); artifacts.set(a.file, a.sha256 as string); }
  const artifact = (name: unknown): void => { safeName(name); check(artifacts.has(name), `Missing artifact ${name}.`); };
  const frames = new Map<string, CaptureFrame>();
  let previous = -1;
  for (const raw of r.frames as unknown[]) {
    const f = record(raw); safeName(f.id); check(!frames.has(f.id), 'Duplicate frame identity.');
    check(Number.isInteger(f.source_index) && (f.source_index as number) > previous, 'Frame source indices must retain increasing original order.'); previous = f.source_index as number;
    check(f.timestamp_s === null || (finite(f.timestamp_s) && f.timestamp_s >= 0), 'Invalid frame timestamp.');
    check(finite(f.width) && f.width > 0 && finite(f.height) && f.height > 0 && finite(f.sharpness) && f.sharpness >= 0, 'Invalid image size or sharpness.');
    artifact(f.file); sha(f.sha256); check(artifacts.get(f.file as string) === f.sha256, 'Frame digest mismatch.');
    if (f.model_image !== undefined) { artifact(f.model_image); check(finite(f.model_width) && f.model_width > 0 && finite(f.model_height) && f.model_height > 0, 'Missing model image dimensions.'); }
    if (f.geometry !== undefined) artifact(f.geometry);
    frames.set(f.id, f as unknown as CaptureFrame);
  }
  const ids = new Set<string>();
  for (const raw of r.observations as unknown[]) {
    const o = record(raw); safeName(o.id); check(!ids.has(o.id), 'Duplicate observation.'); ids.add(o.id);
    const f = frames.get(String(o.frame_id)); check(f?.geometry && f.model_image, 'Observation has no aligned frame geometry.');
    text(o.prompt); check(finite(o.score) && o.score >= 0 && o.score <= 1, 'Invalid mask confidence.');
    check(Array.isArray(o.box) && o.box.length === 4 && o.box.every(finite), 'Invalid mask box.');
    check(o.box[0] >= 0 && o.box[1] >= 0 && o.box[2] >= o.box[0] && o.box[3] >= o.box[1] && o.box[2] <= f.model_width! && o.box[3] <= f.model_height!, 'Mask is outside its aligned image.');
    artifact(o.mask); artifact(o.overlay);
    check(o.motion === 'dynamic' || o.motion === 'unverified', 'Staticness requires operator review.');
    check(o.track_id === null && o.entity_id === null, 'Image masks cannot assert track or OI identity.');
    check(Number.isInteger(o.point_count) && (o.point_count as number) >= 0 && finite(o.valid_fraction) && o.valid_fraction >= 0 && o.valid_fraction <= 1, 'Invalid geometry coverage.');
    check(o.predicted_centroid === null || (Array.isArray(o.predicted_centroid) && o.predicted_centroid.length === 3 && o.predicted_centroid.every(finite)), 'Invalid predicted point.');
    check(o.geometry_status === (o.predicted_centroid === null ? 'missing_depth' : 'predicted'), 'Inconsistent depth status.');
  }
  check((r.prompts as unknown[]).every((p) => typeof p === 'string') && (r.warnings as unknown[]).every((p) => typeof p === 'string'), 'Invalid prompts/warnings.');
  const scale = record(r.scale); check(scale.status === 'unverified' && scale.calibration === null && scale.holdout === null, 'Worker cannot certify scale.');
  const coordinates = record(r.coordinates);
  check(coordinates.frame === 'mapanything-world' && coordinates.units === 'predicted_m' && coordinates.oi_transform === null, 'Unsupported world coordinate contract.');
  record(r.stats);
  if (r.status !== 'inferred') check((r.observations as unknown[]).length === 0, 'Unfinished inference cannot publish observations.');
  if (r.source === 'capture') check(r.status !== 'inferred', 'Capture cannot claim inference.');
  check(coordinates.camera_convention === 'opencv-cam2world-x-right-y-down-z-forward', 'Unsupported camera convention.');
  if (r.source === 'live') check(r.status === 'inferred', 'Live source requires completed inference.');
  return structuredClone(value) as CaptureReport;
}
function directory(root: string, id: string): string { check(/^[a-f0-9-]{36}$/.test(id), 'Invalid walkthrough ID.'); return join(root, 'walkthroughs', id); }
async function verifyArtifacts(dir: string, report: CaptureReport): Promise<void> {
  for (const a of report.artifacts) {
    const path = join(dir, a.file); const stat = await lstat(path); check(stat.isFile() && !stat.isSymbolicLink(), 'Artifact must be a regular file.');
    const hash = createHash('sha256').update(await readFile(path)).digest('hex'); check(hash === a.sha256, `Artifact digest mismatch: ${a.file}.`);
  }
}
async function persist(root: string, id: string, report: CaptureReport): Promise<WalkthroughRun> {
  const run: WalkthroughRun = { id, revision: 1, created_at: new Date().toISOString(), report, reviews: [], measurements: null };
  await withRecords(root, (db) => db.insert('docs', { key: `walkthrough:${id}`, body: JSON.stringify(run), updated_at: run.created_at }));
  return run;
}

/** Invoke the configured Python worker; failures never become replay or successful geometry. */
export async function captureWalkthrough(root: string, input: CaptureRequest): Promise<WalkthroughRun> {
  check(input.mode === 'capture' || input.mode === 'live', 'Unsupported capture mode.');
  const id = randomUUID(); const dir = directory(root, id);
  await mkdir(join(root, 'walkthroughs'), { recursive: true });
  const requestPath = join(root, 'walkthroughs', `${id}-request.json`);
  await writeFile(requestPath, JSON.stringify({ ...input, schema: 'walkthrough-request/1' }));
  try {
    await execute(process.env.WALKTHROUGH_PYTHON || 'python3', [fileURLToPath(new URL('../workers/walkthrough.py', import.meta.url)), requestPath, dir],
      { timeout: 900000, maxBuffer: 1024 * 1024 });
  } catch { throw new WalkthroughError('Walkthrough worker failed. Check Python/Pillow/NumPy and ffmpeg setup; no model results were saved.'); }
  const report = parseCaptureReport(JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')));
  await verifyArtifacts(dir, report);
  return await persist(root, id, report);
}

/** Import an offline bundle only as replay, even if its original source says live. */
export async function replayWalkthrough(root: string, manifest: string): Promise<WalkthroughRun> {
  const report = parseCaptureReport(JSON.parse(await readFile(manifest, 'utf8')));
  await verifyArtifacts(dirname(manifest), report);
  report.source = 'replay';
  const id = randomUUID(); const dir = directory(root, id); await mkdir(dir, { recursive: true });
  for (const a of report.artifacts) await copyFile(join(dirname(manifest), a.file), join(dir, a.file));
  await verifyArtifacts(dir, report);
  await writeFile(join(dir, 'run.json'), JSON.stringify(report));
  return await persist(root, id, report);
}

/** Read persisted evidence and operator revision history. */
export async function readWalkthrough(root: string, id: string): Promise<WalkthroughRun> {
  directory(root, id);
  return await withRecords(root, (db) => {
    const row = db.first('docs', { where: { key: `walkthrough:${id}` }, fields: ["body"] }) as { body: string } | undefined;
    check(row, 'Walkthrough not found.'); return JSON.parse(row.body) as WalkthroughRun;
  });
}
export async function listWalkthroughs(root: string): Promise<WalkthroughRun[]> {
  const keys = await withRecords(root, (db) => db.select('docs', { prefix: { key: "walkthrough:" }, order: ["-updated_at"], fields: ["key"] }) as Array<{ key: string }>);
  return await Promise.all(keys.map(async ({ key }) => (await readWalkthrough(root, key.slice('walkthrough:'.length)))));
}

/** Apply a revision-checked operator review without mutating raw model artifacts. */
export async function reviewWalkthrough(root: string, id: string, expectedRevision: number, raw: unknown): Promise<WalkthroughRun> {
  directory(root, id); const patch = record(raw);
  return await withRecords(root, (db) => {
    
    try {
      const row = db.first('docs', { where: { key: `walkthrough:${id}` }, fields: ["body"] }) as { body: string } | undefined;
      check(row, 'Walkthrough not found.'); const run = JSON.parse(row.body) as WalkthroughRun;
      check(run.revision === expectedRevision, 'Stale review revision; reload before saving.');
      if (patch.observation_id !== undefined) {
        const observation = run.report.observations.find((o) => o.id === patch.observation_id); check(observation, 'Unknown observation.');
        check(patch.decision === 'confirmed' || patch.decision === 'rejected', 'Invalid review decision.'); text(patch.rationale);
        if (patch.decision === 'confirmed') {
          text(patch.station); check(patch.static_confirmed === true && observation.motion !== 'dynamic', 'Dynamic or unverified objects cannot become stations.');
          check(observation.predicted_centroid !== null, 'Missing depth: observation cannot be spatially confirmed.');
        }
        run.reviews.push({ observation_id: observation.id, decision: patch.decision, station: patch.decision === 'confirmed' ? String(patch.station) : null,
          static_confirmed: patch.decision === 'confirmed', rationale: patch.rationale, at: new Date().toISOString() });
      } else if (patch.measurements !== undefined) {
        const measurements = record(patch.measurements);
        for (const key of ['calibration', 'holdout']) {
          const m = record(measurements[key]); const frame = run.report.frames.find((f) => f.id === m.frame_id); check(frame, 'Unknown measurement frame.');
          text(m.source); check(finite(m.measured_m) && m.measured_m > 0, 'Measurement must be positive meters.');
          for (const end of ['a', 'b']) check(Array.isArray(m[end]) && (m[end] as unknown[]).length === 2 && (m[end] as unknown[]).every(finite) && (m[end] as number[])[0] >= 0 && (m[end] as number[])[0] < frame.width && (m[end] as number[])[1] >= 0 && (m[end] as number[])[1] < frame.height, 'Measurement pixel outside original frame.');
          check(JSON.stringify(m.a) !== JSON.stringify(m.b), 'Measurement endpoints must differ.');
        }
        const c = measurements.calibration as ScaleMeasurement, h = measurements.holdout as ScaleMeasurement;
        const pair = (m: ScaleMeasurement): string => [JSON.stringify(m.a), JSON.stringify(m.b)].sort().join('|');
        check(c.frame_id !== h.frame_id || pair(c) !== pair(h), 'Holdout must not reuse the calibration pair.');
        run.measurements = measurements as unknown as WalkthroughRun['measurements'];
      } else throw new WalkthroughError('Review or measurements required.');
      run.revision++;
      db.update('docs', { key: `walkthrough:${id}` }, { body: JSON.stringify(run), updated_at: new Date().toISOString() });
       return run;
    } catch (error) {  throw error; }
  });
}

/** Read a current reviewed run and recheck retained artifact bytes before handoff. */
export async function verifiedWalkthrough(root: string, id: string): Promise<WalkthroughRun> {
  const run = await readWalkthrough(root, id);
  await verifyArtifacts(directory(root, id), run.report);
  check((await readWalkthrough(root, id)).revision === run.revision, 'Walkthrough changed during evidence verification.');
  return run;
}

/** Export consumer evidence for #53; no import, transform or feasibility claim is made. */
export async function walkthroughHandoff(root: string, id: string): Promise<Record<string, unknown>> {
  const run = await readWalkthrough(root, id);
  const latest = new Map(run.reviews.map((r) => [r.observation_id, r]));
  return { schema: 'fieldops-walkthrough-handoff/1', run_id: id, run_revision: run.revision, source: run.report.source,
    status: 'requires_reviewed_import_plan', import_contract: 'oi-reviewed-reconstruction/1', coordinates: run.report.coordinates, scale_status: 'unverified', measurements: run.measurements,
    stations: run.report.observations.filter((o) => latest.get(o.id)?.decision === 'confirmed').map((o) => ({ observation: o, review: latest.get(o.id) })),
    artifacts: run.report.artifacts, frames: run.report.frames, stats: run.report.stats,
    unresolved: ['Supply explicit source-to-OI transform, 3D measurement anchors and immutable asset correspondences; preview with task-reconstruction', 'Route/clearance checks: #54', 'Link committed scene revision/instance IDs with task-spatial', 'Scale fit and independent validation pending; distances remain unverified'],
  };
}

/** Return only manifest-listed PNG evidence; arbitrary project paths are never served. */
export async function walkthroughImage(root: string, id: string, name: string): Promise<Buffer> {
  safeName(name); const run = await readWalkthrough(root, id);
  check(name.endsWith('.png') && run.report.artifacts.some((a) => a.file === name), 'Image artifact not found.');
  const path = join(directory(root, id), name); check((await lstat(path)).isFile() && !(await lstat(path)).isSymbolicLink(), 'Invalid image artifact.');
  const bytes = await readFile(path);
  check(createHash('sha256').update(bytes).digest('hex') === run.report.artifacts.find((a) => a.file === name)!.sha256, 'Image evidence has changed on disk.');
  return bytes;
}

