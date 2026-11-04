/** Real pinned-OI tests: no model packages, sockets or mocked spatial verdicts. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { OiRunnerTransport, OiError, readOiIdentity, resolveOiRoot } from './oi-connector.js';
import type { ReconstructionRequest, ReconstructionResult } from './reconstruction.js';
const execute = promisify(execFile);
const adapter = fileURLToPath(new URL('./oi-reconstruction.mjs', import.meta.url));
const sample = fileURLToPath(new URL('../samples/reconstruction-fixture.mjs', import.meta.url));
let root = '', reason = '';
try {
  root = resolveOiRoot();
  if (!(await readOiIdentity(root)).pinned) reason = 'OI_ROOT must point to the documented pinned revision.';
  else if (!existsSync(join(root, 'node_modules/tsx/dist/esm/index.mjs'))) reason = 'Install pinned OI dependencies.';
} catch (error) { reason = (error as Error).message; }
const options = { skip: reason || false };
const transport = new OiRunnerTransport(root);
const code = (expected: string) => (e: unknown): boolean => e instanceof OiError && e.code === expected;
async function seed(t: TestContext): Promise<{request: ReconstructionRequest; dataDir: string}> {
  const dataDir = await mkdtemp(join(tmpdir(), 'reconstruction-contract-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const { stdout } = await execute(process.execPath, ['--import', join(root, 'node_modules/tsx/dist/esm/index.mjs'), '--input-type=module', '-e',
    `import {seedFixture} from ${JSON.stringify(pathToFileURL(sample).href)}; console.log(JSON.stringify(await seedFixture(${JSON.stringify(root)},${JSON.stringify(dataDir)})))`]);
  return JSON.parse(stdout);
}
const preview = (payload: object) => transport.request<ReconstructionResult>('reconstruction', { action: 'preview', ...payload });
const commit = (payload: object) => transport.request<ReconstructionResult>('reconstruction', { action: 'commit', ...payload });
async function head(payload: {dataDir: string; request: ReconstructionRequest}): Promise<number> {
  return (await transport.request<{revision:number}>('head', {dataDir: payload.dataDir, sceneId: payload.request.scene_id})).revision;
}

interface Inspection {
  revision: number; head_revision: number; imports: Array<{request: ReconstructionRequest}>;
  bindings: Array<{entity_id: string; state: string; stale: boolean}>;
}

test('standalone fixture needs only the adapter, fixture and OI; reopens lineage after correction', options, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'reconstruction-standalone-')); t.after(() => rm(dir, {recursive:true,force:true}));
  const standalone = join(dir, 'adapter.mjs'), fixture = join(dir, 'fixture.mjs');
  await copyFile(adapter, standalone); await copyFile(sample, fixture);
  const {stdout} = await execute(process.execPath, ['--import', join(root, 'node_modules/tsx/dist/esm/index.mjs'), fixture, root, join(dir, 'oi-data'), standalone],
    { env: { ...process.env, META_API_KEY: '', HF_HUB_OFFLINE: '1' }, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout);
  assert.equal(result.status, 'passed'); assert.equal(result.live_inference, false);
  assert.equal(result.preview.scale.predicted_m_per_unit, .0011);
  assert.equal(result.preview.scale.applied_m_per_source_unit, .001);
  assert.equal(result.preview.scale.holdout.residual_m, 0); assert.equal(result.preview.scale.accuracy_certified, false);
  assert.equal(result.reopened.imports[0].request.frame.units, 'mm');
});

test('preview cannot write; exact token required; retry cannot overwrite head or duplicate identities', options, async t => {
  const p = await seed(t);
  const inspect = () => transport.request('reconstruction', {action:'inspect',dataDir:p.dataDir,sceneId:p.request.scene_id,revision:1});
  const before = await inspect();
  const view = await preview(p); assert.equal(await head(p), 1);
  assert.equal(view.items[0].status, 'accepted'); assert.deepEqual(view.items[0].position, [4,0,3]);
  assert.deepEqual(await inspect(), before);
  await assert.rejects(() => commit(p), code('PREVIEW_REQUIRED'));
  const altered = structuredClone(p); altered.request.candidates[0].geometry.position![0] += 500;
  await assert.rejects(() => commit({...altered,previewToken:view.preview_token}), code('PREVIEW_REQUIRED'));
  const accepted = await commit({...p,previewToken:view.preview_token}); assert.equal(accepted.revision, 2);
  const retry = await commit({...p,previewToken:view.preview_token}); assert.equal(retry.revision, 2); assert.equal(retry.replayed, true);
  const stale = structuredClone(p); stale.request.request_id = randomUUID();
  await assert.rejects(() => preview(stale), code('CONFLICT'));
  const reused = structuredClone(p); reused.request.candidates[0].name = 'Different';
  await assert.rejects(() => commit({...reused,previewToken:view.preview_token}), code('REQUEST_ID_REUSED'));
  stale.request.base_revision = 2;
  const duplicated = await preview(stale); assert.equal(duplicated.can_commit, false); assert.equal(duplicated.items[0].code, 'STALE_IDENTITY');
  const staleEvidence = structuredClone(p); staleEvidence.request.request_id = randomUUID(); staleEvidence.request.base_revision = 2;
  staleEvidence.request.source.artifacts[0].sha256 = 'f'.repeat(64);
  await assert.rejects(() => preview(staleEvidence), code('STALE_EVIDENCE'));
  assert.equal(await head(p), 2);
});

test('scale evidence never substitutes calibration for independent holdout or certifies unknown geometry', options, async t => {
  const p = await seed(t);
  const unknown = structuredClone(p); unknown.request.scale.calibration = null;
  const u = await preview(unknown); assert.equal(u.scale.status, 'unknown'); assert.equal(u.items[0].code, 'SCALE_UNVERIFIED');
  await assert.rejects(() => commit({...unknown,previewToken:u.preview_token}), code('NOTHING_IMPORTABLE'));
  const noHoldout = structuredClone(p); noHoldout.request.scale.holdout = null;
  assert.equal((await preview(noHoldout)).scale.status, 'calibrated-unverified');
  const unattested = structuredClone(p); unattested.request.scale.holdout_independence = 'not-established';
  assert.equal((await preview(unattested)).scale.status, 'calibrated-unverified');
  const reused = structuredClone(p); reused.request.scale.holdout = structuredClone(reused.request.scale.calibration);
  await assert.rejects(() => preview(reused), code('HOLDOUT_REUSED'));
  reused.request.scale.holdout!.id = 'renamed'; reused.request.scale.holdout!.anchor_ids = ['renamed-a', 'renamed-b'];
  await assert.rejects(() => preview(reused), code('HOLDOUT_REUSED'));
  const bad = structuredClone(p); bad.request.scale.holdout!.measured_m = 3;
  const failed = await preview(bad); assert.equal(failed.scale.status, 'holdout-failed'); assert.equal(failed.can_commit, false);
  bad.request.scale.calibration!.measured_m = 2; assert.equal((await preview(bad)).scale.status, 'calibration-failed');
  assert.equal(await head(p), 1);
});

test('invalid transforms, missing depth, unsupported geometry, stale evidence and ambiguous views are explicit', options, async t => {
  const p = await seed(t);
  for (const [matrix, expected] of [
    [Array(16).fill(0), 'INVALID_TRANSFORM'],
    [[1,1,0,0,0,1,0,0,0,0,1,0,0,0,0,1], 'UNSUPPORTED_TRANSFORM'],
    [[1,0,0,0,0,2,0,0,0,0,1,0,0,0,0,1], 'UNSUPPORTED_TRANSFORM'],
    [[1,0,0,0,0,1,0,0,0,0,1,0,0,0,1,1], 'INVALID_TRANSFORM'],
    [[NaN,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1], 'INVALID_REQUEST'],
  ] as Array<[number[],string]>) {
    const invalid = structuredClone(p); invalid.request.frame.matrix = matrix;
    await assert.rejects(() => preview(invalid), code(expected));
  }
  const mixed = structuredClone(p);
  for (const kind of ['missing-depth','point-cloud','mesh','region'] as const) {
    mixed.request.candidates.push({...structuredClone(p.request.candidates[0]),id:kind,observation_ids:[kind],geometry:{kind}});
  }
  const result = await preview(mixed); assert.equal(result.items.filter(i=>i.status==='unsupported').length,4);
  assert.equal(result.items.find(i=>i.candidate_id==='missing-depth')!.code,'MISSING_DEPTH');
  const ambiguous = structuredClone(p); ambiguous.request.candidates.push({...structuredClone(p.request.candidates[0]),id:'other'});
  assert.ok((await preview(ambiguous)).items.every(i=>i.code==='AMBIGUOUS_IDENTITY'));
  const missingAsset = structuredClone(p); missingAsset.request.candidates[0].geometry.asset_version = randomUUID();
  assert.equal((await preview(missingAsset)).items[0].code,'ASSET_UNAVAILABLE');
  const missing = structuredClone(p); missing.request.candidates[0].geometry.position = [Infinity,0,0];
  await assert.rejects(() => preview(missing), code('INVALID_REQUEST'));
  missing.request.candidates[0].geometry.position = undefined;
  assert.equal((await preview(missing)).items[0].code,'MISSING_GEOMETRY');
  const stale = structuredClone(p); stale.request.candidates[0].frame_id = 'old-frame';
  assert.equal((await preview(stale)).items[0].code,'STALE_EVIDENCE');
  assert.equal(await head(p), 1);
  const imported = await commit({...mixed,previewToken:result.preview_token});
  assert.equal(imported.revision,2); assert.equal(imported.loss_report.length,4); assert.equal(imported.bindings.length,2);
});

test('normal OI mutations preserve evidence; moved, rebound and deleted bindings invalidate old associations', options, async t => {
  const p = await seed(t), view = await preview(p), first = await commit({...p,previewToken:view.preview_token});
  const entity = first.bindings[0].entity_id;
  const inspect = () => transport.request<Inspection>('reconstruction',{action:'inspect',dataDir:p.dataDir,sceneId:p.request.scene_id,revision:2});
  const mutate = async (revision: number, operations: unknown[], rebind = false): Promise<void> => {
    const script = `
      import {LocalSceneBackend} from ${JSON.stringify(pathToFileURL(join(root,'server/local-scene-backend.ts')).href)};
      import {mutateScene} from ${JSON.stringify(pathToFileURL(join(root,'server/scene-mutations.ts')).href)};
      import {parseCloudBundle} from ${JSON.stringify(pathToFileURL(join(root,'src/lib/cloud-storage.ts')).href)};
      const backend=new LocalSceneBackend(${JSON.stringify(p.dataDir)}), head=await backend.read(${JSON.stringify(p.request.scene_id)});
      const operations=${JSON.stringify(operations)};
      if(${rebind}){const original=parseCloudBundle(await backend.geometry(await backend.asset(head.document.instances[0].cloudVersionId))).asset;
        original.id='replacement-asset'; original.name='Reviewed replacement'; const version=await backend.persistAsset(original);
        operations[0].patch.asset={kind:'local',version_id:version};}
      await mutateScene({version:1,request_id:${JSON.stringify(randomUUID())},scene_id:head.id,base_revision:${revision},agent:'test',operations},head,backend,
        async ref=>({asset:parseCloudBundle(await backend.geometry(await backend.asset(ref.version_id))).asset}), 'a'.repeat(64),()=>{},
        saved=>({version:1,scene_id:saved.id,revision_id:saved.revision,...backend.urls(saved.id,saved.revision),access:'owner'})); backend.close();`;
    await execute(process.execPath,['--import',join(root,'node_modules/tsx/dist/esm/index.mjs'),'--input-type=module','-e',script]);
  };
  await mutate(2,[{op:'update_instance',instance_id:entity,patch:{position:[5,0,3]}}]);
  const moved = await inspect(); assert.equal(moved.bindings[0].state,'changed'); assert.equal(moved.bindings[0].stale,true);
  assert.deepEqual(moved.imports[0].request,p.request);
  await mutate(3,[{op:'update_instance',instance_id:entity,patch:{name:'Rebound'}}],true);
  assert.equal((await inspect()).bindings[0].state,'rebound');
  await mutate(4,[{op:'remove_instance',instance_id:entity}]);
  assert.equal((await inspect()).bindings[0].state,'deleted');
  assert.equal((await commit({...p,previewToken:view.preview_token})).revision,2); assert.equal(await head(p),5);
});

test('CLI preview and discovery use JSON without starting the app', options, async t => {
  const p = await seed(t), cli = fileURLToPath(new URL('../task-reconstruction.js', import.meta.url));
  const env = {...process.env,OI_ROOT:root};
  const capabilities = JSON.parse((await execute(process.execPath,[cli,'capabilities'],{env})).stdout);
  assert.equal(capabilities.schema,'oi-reviewed-reconstruction/1'); assert.equal(capabilities.requires_existing_scene,true);
  const input = join(p.dataDir,'request.json'); await writeFile(input,JSON.stringify(p));
  const result = JSON.parse((await execute(process.execPath,[cli,'preview','--input',input],{env})).stdout);
  assert.equal(result.can_commit,true); assert.equal(result.committed,false);
});
