/** Provider-neutral reconstruction seam. Runs with pinned OI; no Field Ops/model imports. */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

export const RECONSTRUCTION_VERSION = 'oi-reviewed-reconstruction/1';
const PIN = '50f78e0bef23c5a6958d80c50e9232066ecc11d2';
const string = { type: 'string', minLength: 1, maxLength: 512 };
const id = { ...string, maxLength: 256, pattern: '^[a-zA-Z0-9_.:/-]+$' };
const uuid = { type: 'string', pattern: '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$' };
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const number = { type: 'number' };
const positive = { type: 'number', exclusiveMinimum: 0 };
const vector = { type: 'array', minItems: 3, maxItems: 3, items: number };
const array = (items, maxItems = 100) => ({ type: 'array', maxItems, items });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const nullable = schema => ({ anyOf: [schema, { type: 'null' }] });
const measurement = object({ id, artifact_id: id, anchor_ids: { ...array(id, 2), minItems: 2, uniqueItems: true },
  points: { ...array(vector, 2), minItems: 2 }, measured_m: positive, tolerance_m: positive });
/** Discoverable contract: raw predictions and external measurements never become verification by parsing. */
export const reconstructionSchema = object({
  schema: { const: RECONSTRUCTION_VERSION }, request_id: uuid, scene_id: uuid,
  base_revision: { type: 'integer', minimum: 1, maximum: 2147483646 },
  source: object({ id, run_id: id, revision: { type: 'integer', minimum: 1 }, schema: string,
    artifacts: { ...array(object({ id, uri: string, sha256: digest })), minItems: 1 } }),
  frame: object({ id, units: { enum: ['m', 'cm', 'mm', 'predicted_m'] }, handedness: { enum: ['right', 'left'] }, axes: string,
    direction: { const: 'source-to-oi' }, layout: { const: 'row-major' }, target: { const: 'oi-world-m-Y-up' },
    matrix: { type: 'array', minItems: 16, maxItems: 16, items: number } }),
  scale: object({ predicted_m_per_unit: nullable(positive), calibration: nullable(measurement), holdout: nullable(measurement),
    holdout_independence: { enum: ['not-established', 'reviewer-attested'] } }),
  candidates: { ...array(object({ id, observation_ids: { ...array(id), minItems: 1, uniqueItems: true }, frame_id: id, name: string,
    status: { enum: ['confirmed', 'rejected', 'unreviewed'] }, epistemic_status: { enum: ['observed', 'inferred', 'surveyed'] },
    confidence: nullable({ type: 'number', minimum: 0, maximum: 1 }), unknowns: array(string),
    identity: object({ action: { enum: ['create', 'update'] }, entity_id: nullable(id) }),
    geometry: object({ kind: { enum: ['oi-asset-placement', 'point-cloud', 'mesh', 'region', 'missing-depth'] },
      asset_version: uuid, position: vector, rotation_degrees: vector, artifact_id: id }, ['kind']) })), minItems: 1 },
});

function fail(code, message, details = {}) { throw Object.assign(new Error(message), { code, details, upstream: false }); }
const hash = value => createHash('sha256').update(value).digest('hex');

/** Open only public OI APIs. The standalone entry point enforces the same revision as the app connector. */
async function runtime(root) {
  const actual = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (actual !== PIN) fail('OI_PIN_MISMATCH', `Reconstruction adapter requires OI ${PIN}.`);
  const mod = file => import(pathToFileURL(join(root, file)).href);
  const require = createRequire(join(root, 'package.json'));
  const [{ LocalSceneBackend }, workspace, { mutateScene }, contract, { parseCloudBundle }, { sceneURLs }] = await Promise.all([
    mod('server/local-scene-backend.ts'), mod('src/lib/workspace.ts'), mod('server/scene-mutations.ts'),
    mod('server/mcp-scene-contract.mjs'), mod('src/lib/cloud-storage.ts'), mod('src/lib/scene-links.ts'),
  ]);
  return { LocalSceneBackend, ...workspace, mutateScene, ...contract, parseCloudBundle, sceneURLs,
    ...require('three'), Ajv: require('ajv').default };
}

/** Validate a uniform source-to-world transform and evaluate independent measurement evidence. */
function assessTransform(request, oi) {
  const { Matrix4, Vector3 } = oi, frame = request.frame;
  if (frame.handedness !== 'right') fail('UNSUPPORTED_TRANSFORM', 'Convert reflected/left-handed geometry through a supported OI asset importer first.');
  const matrix = new Matrix4().set(...frame.matrix), e = matrix.elements;
  if (Math.abs(e[3]) > 1e-10 || Math.abs(e[7]) > 1e-10 || Math.abs(e[11]) > 1e-10 || Math.abs(e[15] - 1) > 1e-10)
    fail('INVALID_TRANSFORM', 'Expected an affine source-to-OI matrix.');
  const columns = [0, 4, 8].map(i => new Vector3(e[i], e[i + 1], e[i + 2]));
  const factors = columns.map(v => v.length()), factor = factors[0];
  if (!Number.isFinite(matrix.determinant()) || matrix.determinant() <= 1e-18 || factor < 1e-6 || factor > 1e6)
    fail('INVALID_TRANSFORM', 'Transform is singular, reflected, or outside supported scale bounds.');
  if (factors.some(n => Math.abs(n / factor - 1) > 1e-7) || columns.some((a, i) => columns.some((b, j) => i !== j && Math.abs(a.dot(b) / factor ** 2) > 1e-7)))
    fail('UNSUPPORTED_TRANSFORM', 'Shear/nonuniform scale cannot be represented by OI instance poses.');
  const rotation = matrix.clone();
  for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) rotation.elements[i] /= factor;
  rotation.setPosition(0, 0, 0);
  const transform = point => new Vector3(...point).applyMatrix4(matrix);
  const artifacts = new Set(request.source.artifacts.map(a => a.id));
  const measure = item => {
    if (!item) return null;
    if (!artifacts.has(item.artifact_id)) fail('STALE_EVIDENCE', 'Measurement references an absent artifact.');
    const actual = transform(item.points[0]).distanceTo(transform(item.points[1]));
    if (!Number.isFinite(actual) || actual <= 1e-9) fail('INVALID_MEASUREMENT', 'Measurement needs two distinct finite points.');
    const residual = actual - item.measured_m;
    return { ...item, transformed_length_m: actual, residual_m: residual, passed: Math.abs(residual) <= item.tolerance_m };
  };
  const calibration = measure(request.scale.calibration), holdout = measure(request.scale.holdout);
  let independent = false;
  if (calibration && holdout) {
    const reused = calibration.id === holdout.id || calibration.anchor_ids.some(a => holdout.anchor_ids.includes(a)) ||
      (calibration.points.some(p => holdout.points.some(q => p.every((v, i) => Math.abs(v - q[i]) < 1e-9))));
    if (reused) fail('HOLDOUT_REUSED', 'Calibration anchors cannot serve as independent held-out validation.');
    independent = request.scale.holdout_independence === 'reviewer-attested';
  }
  const status = !calibration ? 'unknown' : !calibration.passed ? 'calibration-failed' :
    !holdout || !independent ? 'calibrated-unverified' : holdout.passed ? 'holdout-passed' : 'holdout-failed';
  return { transform, rotation, evidence: { predicted_m_per_unit: request.scale.predicted_m_per_unit,
    applied_m_per_source_unit: factor, calibration, holdout, independence: request.scale.holdout_independence,
    status, accuracy_certified: false }, canImport: !!calibration?.passed && status !== 'holdout-failed' };
}

/** Project revision-aware bindings without inferring correspondence from labels or proximity. */
function readLineage(pinned, head, oi) {
  const before = oi.readManifest(pinned.document), after = oi.readManifest(head.document);
  const imports = pinned.document.reconstruction_imports ?? [];
  const latest = new Map();
  for (const record of imports) for (const binding of record.bindings) latest.set(`${record.request.source.id}\0${binding.observation_id}`, binding);
  const states = [...latest.values()].map(binding => {
    const a = before.instances.find(i => i.id === binding.entity_id), b = after.instances.find(i => i.id === binding.entity_id);
    const headImports = head.document.reconstruction_imports;
    let currentBinding;
    for (const record of headImports ?? []) for (const candidate of record.bindings)
      if (record.request.source.id === binding.source_id && candidate.observation_id === binding.observation_id) currentBinding = candidate;
    const state = !b ? 'deleted' : !headImports || !currentBinding ? 'lineage-missing' :
      currentBinding.entity_id !== binding.entity_id || a?.cloudVersionId !== b.cloudVersionId ? 'rebound' :
      oi.canonicalJSON(a) !== oi.canonicalJSON(b) ? 'changed' : 'unchanged';
    return { ...binding, state, stale: pinned.revision !== head.revision };
  });
  return { imports, bindings: states };
}

/** Preview and commit share upstream mutation validation. Preview intercepts the public backend save in memory. */
export async function reconstructionOperation(root, op, payload) {
  if (op === 'capabilities') return { schema: RECONSTRUCTION_VERSION, oi_revision: PIN, request_schema: reconstructionSchema,
    supported: ['reviewed immutable OI asset placements', 'explicit similarity transforms', 'revisioned lineage', 'preview', 'commit', 'inspect'],
    unsupported: ['raw point-cloud/mesh/region import', 'left-handed/reflected or sheared assets', 'cloud backend', 'automatic physical identity', 'route certification'],
    geometry_units: 'm', pose_rotation: 'XYZ Euler degrees', requires_existing_scene: true,
    provenance: 'OI local revision metadata; whole-scene replacement/export may omit extension: inspect reports lineage-missing',
    scale: 'Unknown/failed calibration blocks placement. Independent holdout is external evidence, not accuracy certification.' };
  const oi = await runtime(resolve(root));
  if (typeof payload?.dataDir !== 'string' || !payload.dataDir) fail('INVALID_REQUEST', 'dataDir is required.');
  const backend = new oi.LocalSceneBackend(payload.dataDir);
  const links = saved => oi.sceneURLs(saved.id, saved.revision, payload.workbenchOrigin || 'http://127.0.0.1:5173');
  try {
    if (op === 'inspect') {
      if (typeof payload.sceneId !== 'string' || !Number.isSafeInteger(payload.revision) || payload.revision < 1) fail('INVALID_REQUEST', 'Inspect requires sceneId and pinned revision.');
      const pinned = await backend.read(payload.sceneId, payload.revision), head = await backend.read(payload.sceneId);
      return { schema: RECONSTRUCTION_VERSION, scene_id: pinned.id, revision: pinned.revision, head_revision: head.revision,
        ...links(pinned), ...readLineage(pinned, head, oi), mock: false };
    }
    if (!['preview', 'commit'].includes(op)) fail('INVALID_REQUEST', 'Use capabilities, preview, commit, or inspect.');
    const request = payload.request;
    if (Buffer.byteLength(JSON.stringify(request) ?? '') > 512 * 1024) fail('PAYLOAD_TOO_LARGE', 'Evidence request exceeds 512 KiB; retain artifacts externally.');
    const check = new oi.Ajv({ strict: false, strictNumbers: true }).compile(reconstructionSchema);
    if (!check(request)) fail('INVALID_REQUEST', 'Invalid reconstruction contract.', { errors: check.errors });
    const requestDigest = hash(oi.canonicalJSON(request));
    const receipt = await backend.receipt(request.scene_id, request.request_id);
    if (receipt) {
      const record = receipt.document.reconstruction_imports?.find(r => r.request.request_id === request.request_id);
      if (!record || record.request_digest !== requestDigest) fail('REQUEST_ID_REUSED', 'Request ID already names different content.');
      if (op === 'commit' && payload.previewToken !== record.preview_token) fail('PREVIEW_REQUIRED', 'Commit requires the token from the reviewed preview.');
      return { ...record.result, ...links(receipt), revision: receipt.revision, committed: true, replayed: true };
    }
    const head = await backend.read(request.scene_id);
    if (head.revision !== request.base_revision) fail('CONFLICT', 'Scene changed; inspect, review and preview again with a new request ID.', { expected_revision: request.base_revision, actual_revision: head.revision });
    const manifest = oi.readManifest(head.document), assessment = assessTransform(request, oi);
    if (new Set(request.source.artifacts.map(a => a.id)).size !== request.source.artifacts.length) fail('INVALID_REQUEST', 'Artifact IDs must be unique.');
    if (new Set(request.candidates.map(c => c.id)).size !== request.candidates.length) fail('AMBIGUOUS_IDENTITY', 'Candidate IDs must be unique.');
    const prior = head.document.reconstruction_imports ?? [];
    for (const record of prior) if (record.request.source.id === request.source.id && record.request.source.run_id === request.source.run_id && record.request.source.revision > request.source.revision)
      fail('STALE_EVIDENCE', 'A newer revision of this source run has already been imported.');
    for (const record of prior) if (record.request.source.id === request.source.id && record.request.source.run_id === request.source.run_id && record.request.source.revision === request.source.revision && oi.canonicalJSON(record.request.source) !== oi.canonicalJSON(request.source))
      fail('STALE_EVIDENCE', 'The same source run revision cannot name different evidence digests.');
    const observations = new Map(), entities = new Map(), priorBindings = new Map();
    for (const record of prior) if (record.request.source.id === request.source.id)
      for (const b of record.bindings) priorBindings.set(b.observation_id, b.entity_id);
    for (const c of request.candidates.filter(c => c.status === 'confirmed')) {
      for (const observation of c.observation_ids) observations.set(observation, (observations.get(observation) ?? 0) + 1);
      const entity = c.identity.entity_id ?? `recon-${hash(`${request.source.id}\0${c.id}`).slice(0, 32)}`;
      entities.set(entity, (entities.get(entity) ?? 0) + 1);
    }
    const items = [], bindings = [], operations = [];
    for (const c of request.candidates) {
      const entity = c.identity.entity_id ?? `recon-${hash(`${request.source.id}\0${c.id}`).slice(0, 32)}`;
      const reject = (status, code, message) => items.push({ candidate_id: c.id, observation_ids: c.observation_ids, status, code, message });
      if (c.status !== 'confirmed') { reject('rejected', 'NOT_CONFIRMED', 'Only explicitly confirmed candidates are importable.'); continue; }
      if (c.observation_ids.some(o => observations.get(o) > 1) || entities.get(entity) > 1) { reject('rejected', 'AMBIGUOUS_IDENTITY', 'Combine cross-view observations into one reviewed candidate or resolve duplicate correspondences.'); continue; }
      if (c.frame_id !== request.frame.id || (c.geometry.artifact_id && !request.source.artifacts.some(a => a.id === c.geometry.artifact_id))) { reject('rejected', 'STALE_EVIDENCE', 'Candidate frame/artifact is not present in the supplied evidence.'); continue; }
      if (c.geometry.kind !== 'oi-asset-placement') { reject('unsupported', c.geometry.kind === 'missing-depth' ? 'MISSING_DEPTH' : 'UNSUPPORTED_GEOMETRY', 'Retain source evidence; this OI version requires an existing immutable asset.'); continue; }
      if (!c.geometry.position || !c.geometry.rotation_degrees || !c.geometry.asset_version) { reject('rejected', 'MISSING_GEOMETRY', 'An immutable asset, finite source position and explicit orientation are required.'); continue; }
      if (!assessment.canImport) { reject('rejected', 'SCALE_UNVERIFIED', 'Unknown/failed calibration or failed holdout cannot become metric placement.'); continue; }
      const existing = manifest.instances.find(i => i.id === entity);
      if ((c.identity.action === 'update' && (!c.identity.entity_id || !existing)) || (c.identity.action === 'create' && existing) ||
          c.observation_ids.some(o => priorBindings.has(o) && priorBindings.get(o) !== entity)) {
        reject('rejected', 'STALE_IDENTITY', 'Explicit correspondence conflicts with current OI identity; inspect and review before correcting.'); continue;
      }
      const asset = await backend.asset(c.geometry.asset_version);
      if (!asset) { reject('rejected', 'ASSET_UNAVAILABLE', 'Immutable local OI asset version is unavailable.'); continue; }
      const position = assessment.transform(c.geometry.position).toArray();
      const localRotation = new oi.Matrix4().makeRotationFromEuler(new oi.Euler(...c.geometry.rotation_degrees.map(v => v * Math.PI / 180), 'XYZ'));
      const rotation = new oi.Euler().setFromRotationMatrix(assessment.rotation.clone().multiply(localRotation), 'XYZ');
      const fields = { name: c.name, asset: { kind: 'local', version_id: c.geometry.asset_version }, position,
        rotation: [rotation.x, rotation.y, rotation.z].map(v => v * 180 / Math.PI), visible: true };
      operations.push(c.identity.action === 'create' ? { op: 'add_instance', instance: { id: entity, ...fields } } : { op: 'update_instance', instance_id: entity, patch: fields });
      for (const observation_id of c.observation_ids) bindings.push({ source_id: request.source.id, observation_id, candidate_id: c.id, entity_id: entity, entity_kind: 'instance' });
      items.push({ candidate_id: c.id, observation_ids: c.observation_ids, status: 'accepted', entity_id: entity, position, rotation: fields.rotation });
    }
    const previewToken = hash(oi.canonicalJSON({ requestDigest, head: head.document }));
    const result = { schema: RECONSTRUCTION_VERSION, scene_id: head.id, base_revision: head.revision, revision: null,
      preview_token: previewToken, committed: false, replayed: false, can_commit: operations.length > 0,
      items, bindings, scale: assessment.evidence, source: request.source, frame: request.frame,
      loss_report: items.filter(i => i.status !== 'accepted'), warnings: ['Asset geometry stays in its immutable metric local frame; source scale applies to placement only.',
        'Import is not reconstruction accuracy, shape fidelity, or route certification.',
        ...(assessment.evidence.status === 'calibrated-unverified' ? ['Independent holdout verification is missing.'] : [])], mock: false };
    if (op === 'commit' && payload.previewToken !== previewToken) fail('PREVIEW_REQUIRED', 'Commit requires the exact preview token for this request and base revision.');
    if (!operations.length) {
      if (op === 'commit') fail('NOTHING_IMPORTABLE', 'Preview has no accepted placements.', result);
      return result;
    }
    const mutation = { version: 1, request_id: request.request_id, scene_id: request.scene_id, base_revision: request.base_revision,
      agent: 'reviewed-reconstruction', operations };
    oi.validateSceneRequest('astra.mutate_scene', mutation);
    const load = async ref => {
      const version = await backend.asset(ref.version_id);
      if (!version) fail('ASSET_UNAVAILABLE', 'Referenced immutable OI asset is missing.');
      return { asset: oi.parseCloudBundle(await backend.geometry(version)).asset };
    };
    let candidateDocument;
    const previewBackend = Object.create(backend);
    previewBackend.save = async (id, name, document, base, writeId) => {
      candidateDocument = document;
      document.reconstruction_imports = [...prior, { request: structuredClone(request), request_digest: requestDigest,
        preview_token: previewToken, bindings, result }];
      if (Buffer.byteLength(JSON.stringify(document)) > 1024 * 1024) fail('PAYLOAD_TOO_LARGE', 'OI revision metadata exceeds 1 MiB; start a separate scene or reduce evidence references.');
      return { id, name, document, revision: base + 1, last_write_id: writeId };
    };
    await oi.mutateScene(mutation, head, previewBackend, load, requestDigest, () => {}, saved => ({ version: 1, scene_id: saved.id,
      revision_id: saved.revision, ...links(saved), access: 'owner' }));
    if (op === 'preview') return result;
    const saved = await backend.save(head.id, head.name, candidateDocument, request.base_revision, request.request_id);
    return { ...result, revision: saved.revision, ...links(saved), committed: true };
  } finally { backend.close(); }
}

/** Standalone JSON protocol; copy this file alone beside any pinned OI checkout. */
async function main() {
  try {
    const chunks = []; let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length; if (size > 1024 * 1024) fail('PAYLOAD_TOO_LARGE', 'Input exceeds 1 MiB.'); chunks.push(chunk);
    }
    const { op, payload = {} } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    console.log(JSON.stringify({ ok: true, result: await reconstructionOperation(process.env.OI_RUNNER_ROOT || process.cwd(), op, payload) }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, code: error.code || 'RECONSTRUCTION_FAILED', message: error.message, details: error.details ?? null }));
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
