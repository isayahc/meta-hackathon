// Live-OI integration: exercises the PINNED OpenIndustries implementation
// (validate + compile + local commit) through the real runner transport.
// Needs OI_ROOT at the pinned commit with node_modules installed; otherwise
// the suite skips with setup instructions (see doc/oi-boundary.md).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import {
  OiError,
  OiRunnerTransport,
  buildSpaceIr,
  readOiIdentity,
  resolveOiRoot,
  type FloorPlanObservations,
  type OiCompiled,
  type OiCommitted,
  type OiValidation,
} from './oi-connector.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..');

async function availability(): Promise<{ ok: true; oiRoot: string } | { ok: false; reason: string }> {
  let oiRoot: string;
  try {
    oiRoot = resolveOiRoot();
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  const identity = await readOiIdentity(oiRoot);
  if (!identity.pinned) {
    return { ok: false, reason: `OI checkout ${identity.actualSha ?? 'unknown'} is not the pinned commit ${identity.pinnedSha.slice(0, 12)}.` };
  }
  for (const dep of ['tsx', 'three', 'ajv']) {
    if (!existsSync(join(oiRoot, 'node_modules', dep, 'package.json'))) {
      return { ok: false, reason: `OI checkout lacks node_modules/${dep} (run npm install in ${oiRoot}).` };
    }
  }
  return { ok: true, oiRoot };
}

async function loadFixture(name: string): Promise<{ obs: FloorPlanObservations; digest: string }> {
  const raw = await readFile(join(DIST, 'samples', name), 'utf8');
  return { obs: JSON.parse(raw) as FloorPlanObservations, digest: createHash('sha256').update(raw).digest('hex') };
}

const avail = await availability();

describe('oi live integration (pinned OI)', { skip: !avail.ok ? (avail as { reason: string }).reason : undefined }, () => {
  it('validates the scaled cabin fixture in OI', async () => {
    if (!avail.ok) return;
    const { obs, digest } = await loadFixture('floorplan-cabin-observations.json');
    const spaceIr = buildSpaceIr(obs, { sourceId: 'cabin-fixture', digestSha256: digest });
    const transport = new OiRunnerTransport(avail.oiRoot);
    const validation = await transport.request<OiValidation>('validate', { spaceIr });
    assert.equal(validation.valid, true);
  });

  it('compiles walls to bindings and keeps equipment as diagnostics', async () => {
    if (!avail.ok) return;
    const { obs, digest } = await loadFixture('floorplan-cabin-observations.json');
    const spaceIr = buildSpaceIr(obs, { sourceId: 'cabin-fixture', digestSha256: digest });
    const transport = new OiRunnerTransport(avail.oiRoot);
    const compiled = await transport.request<OiCompiled>('compile', { spaceIr });
    // Four outer walls plus the door-split partition (two segments).
    assert.equal(compiled.bindings.length, 6);
    assert.match(compiled.source_sha256, /^[0-9a-f]{64}$/);
    const codes = compiled.diagnostics.map((d) => d.code);
    assert.ok(codes.includes('UNCOMPILED_OCCUPANCY'), `expected UNCOMPILED_OCCUPANCY in ${codes.join(',')}`);
  });

  it('commits the compiled space to a local OI backend and reads it back', async () => {
    if (!avail.ok) return;
    const { obs, digest } = await loadFixture('floorplan-cabin-observations.json');
    const spaceIr = buildSpaceIr(obs, { sourceId: 'cabin-fixture', digestSha256: digest });
    const transport = new OiRunnerTransport(avail.oiRoot);
    const compiled = await transport.request<OiCompiled>('compile', { spaceIr });
    const dataDir = await mkdtemp(join(tmpdir(), 'oi-scenes-'));
    try {
      const sceneId = randomUUID();
      const committed = await transport.request<OiCommitted>('commit', {
        workspace: compiled.workspace,
        name: 'integration-cabin',
        sceneId,
        baseRevision: 0,
        requestId: randomUUID(),
        dataDir,
        workbenchOrigin: 'http://127.0.0.1:5173',
        agent: 'oi-integration-test',
      });
      assert.equal(committed.scene_id, sceneId);
      assert.equal(committed.revision, 1);
      assert.match(committed.revision_url, new RegExp(`sceneId=${sceneId}&revision=1`));
      const head = await transport.request<{ revision: number }>('head', { sceneId, dataDir });
      assert.equal(head.revision, 1);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('surfaces OI uncertainty errors for the unscaled fixture', async () => {
    if (!avail.ok) return;
    const { obs, digest } = await loadFixture('floorplan-unscaled-observations.json');
    const spaceIr = buildSpaceIr(obs, { sourceId: 'unscaled-fixture', digestSha256: digest });
    const transport = new OiRunnerTransport(avail.oiRoot);
    const validation = await transport.request<OiValidation>('validate', { spaceIr });
    assert.equal(validation.valid, true);
    await assert.rejects(() => transport.request<OiCompiled>('compile', { spaceIr }), (e: unknown) => e instanceof OiError && e.code === 'UNSCALED_SITE');
  });
});
