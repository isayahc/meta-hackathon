import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OiError,
  OiMockTransport,
  OI_PIN_SHA,
  OI_REPO,
  OI_SPACE_IR_SCHEMA,
  OI_SPACE_IR_VERSION,
  buildSpaceIr,
  resolveOiRoot,
  runFloorPlanFlow,
  type FloorPlanObservations,
} from './oi-connector.js';

const CABIN: FloorPlanObservations = {
  site: { width_m: 8, depth_m: 6, height_m: 2.7 },
  siteEvidence: 'test-declared',
  rooms: [
    { label: 'living', polygon: [[0, 0], [1, 0], [1, 0.5], [0, 0.5]] },
    { label: 'bunk', polygon: [[0, 0.5], [1, 0.5], [1, 1], [0, 1]] },
  ],
  walls: [
    { label: 'partition', kind: 'partition', regions: ['living', 'bunk'], path: [[0, 0.5], [1, 0.5]], thickness_m: 0.12, height_m: 2.7 },
  ],
  openings: [{ wall: 0, kind: 'door', span: [0.4, 0.6] }],
  equipment: [{ label: 'stove', region: 'bunk', polygon: [[0.1, 0.6], [0.2, 0.6], [0.2, 0.7], [0.1, 0.7]] }],
  unresolved: ['windows unreadable'],
};

const SRC = { sourceId: 'test.png', digestSha256: 'ab'.padEnd(64, 'c') };

describe('buildSpaceIr', () => {
  it('shapes scaled observations into a SpaceIR v0.1 envelope', () => {
    const doc = buildSpaceIr(CABIN, SRC);
    assert.equal(doc.schema_id, OI_SPACE_IR_SCHEMA);
    assert.equal(doc.schema_version, OI_SPACE_IR_VERSION);
    assert.deepEqual(doc.site, { frame_id: 'world', width_m: 8, depth_m: 6, height_m: 2.7 });
    assert.deepEqual(doc.frames, [{ id: 'world', units: 'm', axes: 'XZ' }]);
    assert.equal(doc.regions.length, 2);
    assert.equal(doc.boundaries.length, 1);
    assert.equal(doc.portals.length, 1);
    assert.equal(doc.occupancies.length, 1);
    assert.deepEqual(doc.spatial_relations, []);
  });

  it('converts normalized coords to centered world meters', () => {
    const doc = buildSpaceIr(CABIN, SRC);
    // u=1 -> x=+4, v=0 -> z=-3 for an 8x6 site.
    assert.deepEqual((doc.regions[0] as { polygon: Array<[number, number]> | null }).polygon?.[1], [4, -3]);
    assert.deepEqual((doc.boundaries[0] as { path: unknown }).path, [[-4, 0], [4, 0]]);
  });

  it('resolves labels to stable ids and wires references', () => {
    const doc = buildSpaceIr(CABIN, SRC);
    const regionIds = doc.regions.map((r) => r.id);
    assert.deepEqual(regionIds, ['room-living', 'room-bunk']);
    assert.deepEqual((doc.boundaries[0] as { region_ids: unknown }).region_ids, ['room-living', 'room-bunk']);
    const portal = doc.portals[0] as { boundary_id: unknown; connects: unknown; traversable: unknown };
    assert.equal(portal.boundary_id, 'wall-partition');
    assert.deepEqual(portal.connects, ['room-living', 'room-bunk']);
    assert.equal(portal.traversable, true);
    assert.equal((doc.occupancies[0] as { region_id: unknown }).region_id, 'room-bunk');
  });

  it('attaches one evidence record per entity with source digest', () => {
    const doc = buildSpaceIr(CABIN, SRC);
    // 2 rooms + 1 wall + 1 portal + 1 occupancy
    assert.equal(doc.evidence.length, 5);
    for (const ev of doc.evidence) {
      assert.equal(ev.source_id, 'test.png');
      assert.equal(ev.digest_sha256, SRC.digestSha256);
      assert.equal(ev.status, 'observed');
    }
  });

  it('omits geometry but keeps topology when unscaled', () => {
    const doc = buildSpaceIr({ ...CABIN, site: null }, SRC);
    assert.equal(doc.site, null);
    assert.equal((doc.regions[0] as { polygon: unknown }).polygon, null);
    assert.equal((doc.boundaries[0] as { path: unknown }).path, null);
    assert.equal(doc.regions.length, 2);
    assert.ok(doc.unresolved.some((u) => /no metric scale/i.test(u)));
    assert.ok(doc.unresolved.includes('windows unreadable'));
  });

  it('is deterministic for replay', () => {
    const src = { ...SRC, capturedAt: '2026-01-01T00:00:00.000Z' };
    const a = JSON.stringify(buildSpaceIr(CABIN, src));
    const b = JSON.stringify(buildSpaceIr(structuredClone(CABIN), src));
    assert.equal(a, b);
  });

  it('rejects unknown room references with an actionable code', () => {
    assert.throws(
      () => buildSpaceIr({ ...CABIN, walls: [{ regions: ['attic'], path: [[0, 0], [1, 1]] }] }, SRC),
      (e: unknown) => e instanceof OiError && e.code === 'OBS_UNRESOLVED_REFERENCE'
    );
    assert.throws(
      () => buildSpaceIr({ ...CABIN, equipment: [{ label: 'x', region: 'attic', polygon: null }] }, SRC),
      (e: unknown) => e instanceof OiError && e.code === 'OBS_UNRESOLVED_REFERENCE'
    );
  });

  it('rejects malformed shapes', () => {
    assert.throws(
      () => buildSpaceIr({ ...CABIN, openings: [{ wall: 7, kind: 'door', span: [0, 1] }] }, SRC),
      (e: unknown) => e instanceof OiError && e.code === 'OBS_BAD_SHAPE'
    );
    assert.throws(
      () => buildSpaceIr({ ...CABIN, rooms: [{ label: '', polygon: null }] }, SRC),
      (e: unknown) => e instanceof OiError && e.code === 'OBS_BAD_SHAPE'
    );
    assert.throws(
      () => buildSpaceIr({ ...CABIN, site: { width_m: NaN, depth_m: 1, height_m: 1 } }, SRC),
      (e: unknown) => e instanceof OiError && e.code === 'OBS_BAD_SHAPE'
    );
  });
});

describe('resolveOiRoot', () => {
  it('fails with setup guidance when OI_ROOT is unset', () => {
    assert.throws(() => resolveOiRoot({}), (e: unknown) => e instanceof OiError && e.code === 'OI_ROOT_NOT_FOUND');
  });

  it('fails when OI_ROOT is not a directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oi-root-'));
    try {
      assert.throws(() => resolveOiRoot({ OI_ROOT: join(dir, 'nope') }), (e: unknown) => e instanceof OiError && e.code === 'OI_ROOT_NOT_FOUND');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails when the checkout lacks pinned interface files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oi-root-'));
    try {
      assert.throws(() => resolveOiRoot({ OI_ROOT: dir }), (e: unknown) => e instanceof OiError && e.code === 'OI_LAYOUT_UNSUPPORTED');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resolves a checkout carrying the pinned markers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oi-root-'));
    try {
      for (const rel of [
        'packages/space-ir/src/index.ts',
        'src/lib/space-ir-compiler.ts',
        'src/lib/workspace.ts',
        'server/local-scene-backend.ts',
        'server/mcp-scene-contract.mjs',
        'src/lib/scene-links.ts',
      ]) {
        await mkdir(join(dir, ...rel.split('/').slice(0, -1)), { recursive: true });
        await writeFile(join(dir, rel), '// marker');
      }
      assert.equal(resolveOiRoot({ OI_ROOT: dir }), dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('runFloorPlanFlow', () => {
  const base = {
    observations: CABIN,
    source: SRC,
    run: { model: 'test', promptVersion: 'floorplan-v1', mock: true },
    oi: { root: '<mock>', dataDir: join(tmpdir(), 'oi-scenes-test'), sceneName: 'test-scene' },
  };

  it('runs validate -> compile -> commit and records the pin', async () => {
    const flow = await runFloorPlanFlow({ ...base, transport: new OiMockTransport() });
    assert.equal(flow.oiIdentity.repo, OI_REPO);
    assert.equal(flow.oiIdentity.pinnedSha, OI_PIN_SHA);
    assert.equal(flow.validation.valid, true);
    assert.equal(flow.committed.revision, 1);
    assert.equal(flow.committed.name, 'test-scene');
    assert.match(flow.committed.revision_url, /sceneId=/);
  });

  it('raises OI rejections with upstream finding codes', async () => {
    const transport = new OiMockTransport({
      validate: () => ({ valid: false, findings: [{ code: 'SITE', path: 'site', message: 'bad site', severity: 'error' }] }),
    });
    await assert.rejects(() => runFloorPlanFlow({ ...base, transport }), (e: unknown) => e instanceof OiError && e.code === 'OI_SPACE_IR_INVALID' && /SITE@site/.test(e.message));
  });

  it('propagates upstream compile failures untouched', async () => {
    const transport = new OiMockTransport({
      compile: () => {
        throw new OiError('UNSCALED_SITE', 'Metric site dimensions required.', { upstream: true });
      },
    });
    await assert.rejects(
      () => runFloorPlanFlow({ ...base, transport }),
      (e: unknown) => e instanceof OiError && e.code === 'UNSCALED_SITE' && e.upstream === true
    );
  });

  it('propagates upstream commit conflicts untouched', async () => {
    const transport = new OiMockTransport({
      commit: () => {
        throw new OiError('CONFLICT', 'Scene has changed.', { upstream: true, details: { current_revision: 2 } });
      },
    });
    await assert.rejects(
      () => runFloorPlanFlow({ ...base, transport }),
      (e: unknown) => e instanceof OiError && e.code === 'CONFLICT' && (e.details as { current_revision: number }).current_revision === 2
    );
  });

  it('records every transport call for offline assertions', async () => {
    const transport = new OiMockTransport();
    await runFloorPlanFlow({ ...base, transport });
    assert.deepEqual(transport.calls.map((c) => c.op), ['validate', 'compile', 'commit']);
    assert.equal((transport.calls[2]?.payload as { baseRevision: unknown }).baseRevision, 0);
  });
});
