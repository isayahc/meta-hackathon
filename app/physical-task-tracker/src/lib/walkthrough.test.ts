/** Offline artifact, review, API and CLI contract tests. No model or Python dependency. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from '../serve-dashboard.js';
import { parseCaptureReport, replayWalkthrough, readWalkthrough, reviewWalkthrough, walkthroughHandoff, walkthroughImage, type CaptureReport } from './walkthrough.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=', 'base64');
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'walkthrough-contract-')); t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, 'bundle'); await mkdir(bundle);
  await writeFile(join(bundle, 'image.png'), PNG);
  await writeFile(join(bundle, 'geometry.bin'), 'Synthetic contract placeholder, not model output');
  const hash = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
  const report: CaptureReport = {
    schema: 'walkthrough-observations/1', source: 'replay', status: 'inferred',
    frames: [0, 4].map(i => ({ id: `frame-${i}`, source_index: i, timestamp_s: i / 2, file: 'image.png', sha256: hash(PNG), sharpness: 30,
      width: 1, height: 1, model_width: 1, model_height: 1, model_image: 'image.png', geometry: 'geometry.bin' })),
    observations: [{ id: 'o0', frame_id: 'frame-4', prompt: 'workbench', score: .8, box: [0, 0, 1, 1], mask: 'image.png', overlay: 'image.png',
      motion: 'unverified', track_id: null, entity_id: null, predicted_centroid: [1, 2, 3], point_count: 1, valid_fraction: 1, geometry_status: 'predicted' }],
    artifacts: [{ file: 'image.png', sha256: hash(PNG) }, { file: 'geometry.bin', sha256: hash('Synthetic contract placeholder, not model output') }],
    sources: [], prompts: ['workbench'], warnings: ['Synthetic contract fixture'],
    coordinates: { frame: 'mapanything-world', camera_convention: 'opencv-cam2world-x-right-y-down-z-forward', units: 'predicted_m', oi_transform: null },
    scale: { status: 'unverified', calibration: null, holdout: null }, stats: { synthetic: true },
  };
  const manifest = join(bundle, 'run.json'); await writeFile(manifest, JSON.stringify(report));
  return { root, bundle, report, manifest };
}
const confirm = { observation_id: 'o0', decision: 'confirmed', station: 'Tray filling station', static_confirmed: true, rationale: 'Operator confirms this station.' };

async function api(root: string, method: string, path: string, body?: unknown) {
  const server = createServer(root); let status = 0; let bytes = Buffer.alloc(0);
  const req = { method, url: path, async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); } };
  const res = { writeHead(s: number) { status = s; }, end(b: string | Buffer = '') { bytes = Buffer.from(b); } };
  await (server.listeners('request')[0] as unknown as (req: IncomingMessage, res: ServerResponse) => Promise<void>)(req as IncomingMessage, res as unknown as ServerResponse);
  return { status, bytes, json: path.includes('/images/') && status === 200 ? null : JSON.parse(bytes.toString()) };
}

test('replay preserves frame identity and forces honest replay provenance', async t => {
  const { root, report, manifest } = await fixture(t);
  report.source = 'live'; await writeFile(manifest, JSON.stringify(report));
  const run = await replayWalkthrough(root, manifest);
  assert.equal(run.report.source, 'replay');
  assert.equal(run.report.observations[0].frame_id, 'frame-4');
  assert.equal(run.report.frames[1].timestamp_s, 2);
  assert.equal(readWalkthrough(root, run.id).report.scale.status, 'unverified');
  const exportData = walkthroughHandoff(root, run.id);
  assert.equal(exportData.status, 'awaiting_oi_contract');
  assert.deepEqual(exportData.stations, []);
});

test('artifact traversal, mismatched hashes and missing files are rejected', async t => {
  const { root, report, manifest, bundle } = await fixture(t);
  const bad = structuredClone(report); bad.artifacts[0].file = '../secret.png';
  assert.throws(() => parseCaptureReport(bad), /artifact name/);
  await writeFile(join(bundle, 'image.png'), 'changed');
  await assert.rejects(() => replayWalkthrough(root, manifest), /digest mismatch/);
  await rm(join(bundle, 'image.png'));
  await assert.rejects(() => replayWalkthrough(root, manifest), /ENOENT/);
});

test('worker cannot fabricate frame links, calibrated scale, OI IDs or successful capture', async t => {
  const { report } = await fixture(t);
  for (const change of [
    (r: CaptureReport) => { r.observations[0].frame_id = 'missing'; },
    (r: CaptureReport) => { r.frames[1].source_index = 0; },
    (r: CaptureReport) => { r.observations[0].predicted_centroid = [NaN, 0, 0]; },
    (r: CaptureReport) => { r.observations[0].box = [0, 0, 100, 100]; },
    (r: CaptureReport) => { r.coordinates.units = 'meters'; },
    (r: CaptureReport) => { r.coordinates.oi_transform = [1]; },
    (r: CaptureReport) => { r.source = 'capture'; },
    (r: CaptureReport) => { r.status = 'failed'; },
  ]) { const r = structuredClone(report); change(r); assert.throws(() => parseCaptureReport(r)); }
});

test('reviews preserve raw artifacts, persist corrections and reject stale edits', async t => {
  const { root, manifest } = await fixture(t); const run = await replayWalkthrough(root, manifest);
  const initial = await readFile(join(root, 'walkthroughs', run.id, 'run.json'), 'utf8');
  const reviewed = reviewWalkthrough(root, run.id, 1, confirm);
  assert.equal(reviewed.revision, 2);
  assert.equal(readWalkthrough(root, run.id).reviews[0].station, 'Tray filling station');
  const handoff = walkthroughHandoff(root, run.id);
  assert.equal((handoff.stations as unknown[]).length, 1);
  assert.equal(handoff.run_revision, 2);
  assert.equal(handoff.scale_status, 'unverified');
  assert.throws(() => reviewWalkthrough(root, run.id, 1, confirm), /Stale/);
  reviewWalkthrough(root, run.id, 2, { ...confirm, decision: 'rejected', rationale: 'Ambiguous identity on review.' });
  assert.equal((walkthroughHandoff(root, run.id).stations as unknown[]).length, 0);
  assert.equal(await readFile(join(root, 'walkthroughs', run.id, 'run.json'), 'utf8'), initial);
});

test('moving objects and missing depth cannot be confirmed as stations', async t => {
  const { root, report, manifest } = await fixture(t);
  report.observations[0].motion = 'dynamic'; await writeFile(manifest, JSON.stringify(report));
  const run = await replayWalkthrough(root, manifest);
  assert.throws(() => reviewWalkthrough(root, run.id, 1, confirm), /Dynamic/);
  report.observations[0].motion = 'unverified'; report.observations[0].predicted_centroid = null; report.observations[0].geometry_status = 'missing_depth';
  await writeFile(manifest, JSON.stringify(report));
  const missing = await replayWalkthrough(root, manifest);
  assert.throws(() => reviewWalkthrough(root, missing.id, 1, confirm), /Missing depth/);
});

test('calibration and holdout inputs remain separate and never certify scale locally', async t => {
  const { root, manifest } = await fixture(t); const run = await replayWalkthrough(root, manifest);
  const calibration = { frame_id: 'frame-0', a: [0, 0], b: [.5, .5], measured_m: 1, source: 'Tape measurement A' };
  const holdout = { ...calibration, a: [.5, .5], b: [0, 0] };
  assert.throws(() => reviewWalkthrough(root, run.id, 1, { measurements: { calibration, holdout } }), /reuse/);
  holdout.frame_id = 'frame-4'; holdout.source = 'Independent tape measurement B';
  const reviewed = reviewWalkthrough(root, run.id, 1, { measurements: { calibration, holdout } });
  assert.equal(reviewed.measurements?.holdout.source, 'Independent tape measurement B');
  assert.equal(walkthroughHandoff(root, run.id).scale_status, 'unverified');
});

test('API review, image access, stale conflicts and handoff use persisted evidence', async t => {
  const { root, manifest } = await fixture(t); const run = await replayWalkthrough(root, manifest);
  assert.equal((await api(root, 'GET', '/api/walkthroughs')).json.runs.length, 1);
  const path = `/api/walkthroughs/${run.id}`;
  assert.equal((await api(root, 'GET', path + '/images/image.png')).status, 200);
  assert.equal((await api(root, 'GET', path + '/images/geometry.bin')).status, 400);
  assert.equal((await api(root, 'POST', path + '/review', { revision: 1, patch: confirm })).status, 200);
  assert.equal((await api(root, 'POST', path + '/review', { revision: 1, patch: confirm })).status, 409);
  assert.equal((await api(root, 'GET', path + '/handoff')).json.stations.length, 1);
  assert.equal((await api(root, 'POST', '/api/walkthroughs', { imagesData: [], mode: 'capture' })).status, 400);
  await writeFile(join(root, 'walkthroughs', run.id, 'image.png'), 'tampered');
  await assert.rejects(() => walkthroughImage(root, run.id, 'image.png'), /changed on disk/);
});

test('real CLI replay/show/handoff round trip emits JSON without model inference', async t => {
  const { root, manifest } = await fixture(t);
  const cli = fileURLToPath(new URL('../task-walkthrough.js', import.meta.url));
  const exec = promisify(execFile);
  const { stdout } = await exec(process.execPath, [cli, 'replay', '--root', root, '--manifest', manifest]);
  const run = JSON.parse(stdout);
  assert.equal(run.report.source, 'replay');
  const handoff = await exec(process.execPath, [cli, 'handoff', '--root', root, '--id', run.id]);
  assert.equal(JSON.parse(handoff.stdout).run_revision, 1);
});
