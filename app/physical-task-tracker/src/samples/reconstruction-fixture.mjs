/** Deterministic, provider-neutral OI fixture. Only this file, the adapter, and pinned OI are needed. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

/** Import metric fixture geometry and create an empty OI scene using upstream public APIs. */
export async function seedFixture(root, dataDir) {
  const mod = file => import(pathToFileURL(join(root, file)).href);
  const [{ LocalSceneBackend }, { finalizeAsset }, { makeManifest }] = await Promise.all([
    mod('server/local-scene-backend.ts'), mod('src/lib/scene.ts'), mod('src/lib/workspace.ts'),
  ]);
  const sceneId = randomUUID(), backend = new LocalSceneBackend(dataDir);
  try {
    // A surveyed fixture tetrahedron, never a stand-in for a reconstructed object's geometry.
    const vertices = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
    const asset = finalizeAsset({ id: 'reviewed-fixture-station', name: 'Surveyed fixture station',
      source: { kind: 'generated', generator: 'oi-fixture', filename: 'fixture.json', digest: createHash('sha256').update(JSON.stringify(vertices)).digest('hex') },
      parts: [{ id: 'body', name: 'Surveyed body', vertices, indices: [0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3], metadata: {} }],
      hierarchy: { id: 'root', name: 'Fixture', partIds: ['body'], children: [] }, warnings: [] });
    const version = await backend.persistAsset(asset);
    const document = { ...makeManifest({ room: [10, 10, 3], items: [], animation: { duration: 10, loop: false, tracks: [] } }),
      authoring: { via: 'fixture', agent: 'fixture', parent_revision: null, request_id: sceneId, request_digest: '0'.repeat(64) } };
    await backend.save(sceneId, 'Reviewed reconstruction fixture', document, 0, sceneId);
    const request = {
      schema: 'oi-reviewed-reconstruction/1', request_id: randomUUID(), scene_id: sceneId, base_revision: 1,
      source: { id: 'survey-fixture', run_id: 'survey-1', revision: 1, schema: 'survey-observations/1',
        artifacts: [{ id: 'survey', uri: 'fixture://survey-1/anchors', sha256: createHash('sha256').update('fixture-survey-v1').digest('hex') }] },
      frame: { id: 'survey-world', units: 'mm', handedness: 'right', axes: 'X right, Y up, Z backward',
        direction: 'source-to-oi', layout: 'row-major', target: 'oi-world-m-Y-up',
        matrix: [0, 0, 0.001, 2, 0, 0.001, 0, 0, -0.001, 0, 0, 4, 0, 0, 0, 1] },
      scale: { predicted_m_per_unit: 0.0011,
        calibration: { id: 'calibration', artifact_id: 'survey', anchor_ids: ['a', 'b'], points: [[0, 0, 0], [1000, 0, 0]], measured_m: 1, tolerance_m: 0.001 },
        holdout: { id: 'holdout', artifact_id: 'survey', anchor_ids: ['c', 'd'], points: [[0, 0, 1000], [0, 0, 3000]], measured_m: 2, tolerance_m: 0.001 },
        holdout_independence: 'reviewer-attested' },
      candidates: [{ id: 'station-one', observation_ids: ['view-a', 'view-b'], frame_id: 'survey-world', name: 'Reviewed station',
        status: 'confirmed', epistemic_status: 'surveyed', confidence: null, unknowns: ['Fixture only; no real reconstruction accuracy claim.'],
        identity: { action: 'create', entity_id: null },
        geometry: { kind: 'oi-asset-placement', asset_version: version, position: [1000, 0, 2000], rotation_degrees: [0, 0, 0], artifact_id: 'survey' } }],
    };
    return { request, dataDir, sceneId, version };
  } finally { backend.close(); }
}

/** Exercise preview, idempotent import, reopen and a revisioned correction without the Field Ops app. */
export async function runFixture(root, dataDir, adapter) {
  const { reconstructionOperation } = await import(pathToFileURL(adapter).href);
  const seeded = await seedFixture(root, dataDir), { request, sceneId } = seeded;
  const preview = await reconstructionOperation(root, 'preview', { dataDir, request });
  assert.equal(preview.scale.status, 'holdout-passed'); assert.equal(preview.committed, false);
  assert.deepEqual(preview.items[0].position, [4, 0, 3]);
  assert.ok(Math.abs(preview.items[0].rotation[1] - 90) < 1e-8);
  const payload = { dataDir, request, previewToken: preview.preview_token };
  const committed = await reconstructionOperation(root, 'commit', payload);
  assert.equal(committed.revision, 2);
  const retry = await reconstructionOperation(root, 'commit', payload);
  assert.equal(retry.revision, 2); assert.equal(retry.replayed, true);
  const correction = structuredClone(request);
  correction.request_id = randomUUID(); correction.base_revision = 2; correction.source.revision = 2;
  correction.candidates[0].identity = { action: 'update', entity_id: committed.bindings[0].entity_id };
  correction.candidates[0].geometry.position[0] += 1000;
  const correctedPreview = await reconstructionOperation(root, 'preview', { dataDir, request: correction });
  const corrected = await reconstructionOperation(root, 'commit', { dataDir, request: correction, previewToken: correctedPreview.preview_token });
  assert.equal(corrected.revision, 3); assert.equal(corrected.bindings[0].entity_id, committed.bindings[0].entity_id);
  const reopened = await reconstructionOperation(root, 'inspect', { dataDir, sceneId, revision: 2 });
  assert.equal(reopened.bindings[0].state, 'changed'); assert.equal(reopened.head_revision, 3);
  assert.deepEqual(reopened.imports[0].request, request);
  assert.equal((await reconstructionOperation(root, 'commit', payload)).revision, 2);
  return { status: 'passed', mode: 'deterministic fixture with real pinned OI', live_inference: false,
    dataDir, request, preview, committed, corrected, reopened };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [root, dataDir, adapter] = process.argv.slice(2);
    if (!root || !dataDir || !adapter) throw new Error('Pass absolute OI checkout, data directory and adapter .mjs paths.');
    console.log(JSON.stringify(await runFixture(root, dataDir, adapter)));
  } catch (error) { console.error(error); process.exitCode = 1; }
}
