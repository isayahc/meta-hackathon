/** Integration tests use real pinned OI; unavailable setup is skipped rather than mocked. */
import { test,type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,rm,copyFile,writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { OiRunnerTransport,OiError,readOiIdentity,resolveOiRoot } from './oi-connector.js';
import { readRouteAssessment,type RouteAssessment,type RouteAssessmentRequest } from './route-assessment.js';
const execute=promisify(execFile),adapter=fileURLToPath(new URL('./oi-route-assessment.mjs',import.meta.url));
const sample=fileURLToPath(new URL('../samples/route-assessment-fixture.mjs',import.meta.url));
let root='',reason='';
try{root=resolveOiRoot();if(!(await readOiIdentity(root)).pinned)reason='Use pinned OI.';
  else if(['tsx','three','ajv'].some(dep=>!existsSync(join(root,'node_modules',dep,'package.json'))))reason='Install OI dependencies.';
}catch(error){reason=(error as Error).message;}
const options={skip:reason||false},transport=new OiRunnerTransport(root);
const errorCode=(code:string)=>(e:unknown):boolean=>e instanceof OiError&&e.code===code;
const status=(r:RouteAssessment,id:string):string|undefined=>r.checks.find(c=>c.id===id)?.status;
async function runCode(code:string):Promise<string>{return (await execute(process.execPath,['--import',join(root,'node_modules/tsx/dist/esm/index.mjs'),'--input-type=module','-e',code])).stdout;}
async function seed(t:TestContext,opts:Record<string,boolean>={}):Promise<{request:RouteAssessmentRequest;dataDir:string}>{
  const dir=await mkdtemp(join(tmpdir(),'oi-routes-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  return JSON.parse(await runCode(`import {seedRouteFixture} from ${JSON.stringify(pathToFileURL(sample).href)};console.log(JSON.stringify(await seedRouteFixture(${JSON.stringify(root)},${JSON.stringify(dir)},${JSON.stringify(opts)})))`));
}
const assess=(p:object)=>transport.request<RouteAssessment>('route-assessment',{action:'assess',...p});

test('standalone route fixture reproduces declared lengths with mutation APIs disabled',options,async t=>{
  const dir=await mkdtemp(join(tmpdir(),'route-standalone-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const files=[adapter,fileURLToPath(new URL('./oi-reconstruction.mjs',import.meta.url)),sample,fileURLToPath(new URL('../samples/reconstruction-fixture.mjs',import.meta.url))];
  for(const f of files)await copyFile(f,join(dir,f.split('/').at(-1)!));
  const {stdout}=await execute(process.execPath,['--import',join(root,'node_modules/tsx/dist/esm/index.mjs'),join(dir,'route-assessment-fixture.mjs'),root,join(dir,'data'),join(dir,'oi-route-assessment.mjs')]);
  const result=JSON.parse(stdout);assert.equal(result.status,'passed');assert.equal(result.mutation_attempts,0);
  assert.equal(result.baseline.geometric_path_length_m,8);assert.equal(result.comparison.proposed.geometric_path_length_m,Math.sqrt(32));
  assert.equal(result.baseline.validated_walkable_route_length_m,null);assert.equal(result.baseline.traversability,'unknown');
});

test('explicit bent routes, obstructions and person/cart clearance remain separate checks',options,async t=>{
  const p=await seed(t),baseline=await assess(p);assert.equal(status(baseline,'request-schema'),'passed');
  assert.equal(status(baseline,'obstruction'),'passed');assert.equal(status(baseline,'horizontal-clearance'),'passed');
  assert.equal(status(baseline,'connectivity'),'passed');assert.equal(status(baseline,'physical-traversability'),'unsupported');
  const blocked=structuredClone(p);blocked.request.route=[[-2,0,-2],[2,0,-2],[2,0,2]];
  const b=await assess(blocked);assert.equal(status(b,'obstruction'),'failed');assert.equal(b.geometric_path_length_m,8);assert.equal(b.traversability,'failed');
  const cart=structuredClone(p);cart.request.profile={kind:'cart',width_m:2,margin_m:.1,source:'wide-cart-fixture'};
  const c=await assess(cart);assert.equal(status(c,'horizontal-clearance'),'failed');assert.equal(status(c,'portal:opening:1'),'failed');
  cart.request.profile.width_m=.7;assert.equal(status(await assess(cart),'horizontal-clearance'),'passed');
  cart.request.profile.margin_m=null;assert.equal(status(await assess(cart),'horizontal-clearance'),'unknown');
  const constraint=await assess(await seed(t,{clearanceConstraint:true}));assert.equal(status(constraint,'constraint:minimum-aisle'),'failed');
  const occupied=await assess(await seed(t,{occupied:true}));assert.equal(status(occupied,'obstruction'),'failed');
});

test('window and adjacency cannot become traversability; unknown occupancy stays unknown',options,async t=>{
  const window=await assess(await seed(t,{window:true}));assert.equal(status(window,'connectivity'),'unknown');
  assert.equal(status(window,'obstruction'),'failed');assert.equal(status(window,'portal:divider:1'),'failed');
  const adjacent=await assess(await seed(t,{adjacent:true}));assert.equal(status(adjacent,'connectivity'),'unknown');
  assert.equal(adjacent.traversability,'failed');
  const missing=await assess(await seed(t,{missingObstacle:true}));assert.equal(status(missing,'environment'),'unknown');
  assert.equal(status(missing,'obstruction'),'unknown');assert.equal(missing.geometric_path_length_m,8);
});

test('unknown scale, held-out reuse, missing identity and elevation cannot fabricate meter or route claims',options,async t=>{
  const p=await seed(t),unknown=structuredClone(p);unknown.request.scale.calibration=null;
  const u=await assess(unknown);assert.equal(status(u,'scale'),'unknown');assert.equal(u.geometric_path_length_m,null);
  unknown.request.scale=structuredClone(p.request.scale);unknown.request.scale.holdout=null;
  assert.equal((await assess(unknown)).geometric_path_length_m,null);
  const reused=structuredClone(p);reused.request.scale.holdout=structuredClone(reused.request.scale.calibration);
  await assert.rejects(()=>assess(reused),errorCode('HOLDOUT_REUSED'));
  const elevated=structuredClone(p);elevated.request.route[1][1]=1;
  assert.equal(status(await assess(elevated),'elevation'),'unsupported');assert.equal((await assess(elevated)).geometric_path_length_m,null);
  const missing=structuredClone(p);missing.request.station_ids[0]='removed-station';assert.equal(status(await assess(missing),'identity'),'unknown');
  missing.request.station_ids=['station-a','station-a'];await assert.rejects(()=>assess(missing),errorCode('INVALID_REQUEST'));
  const invalid=structuredClone(p);invalid.request.route[1][0]=Infinity;await assert.rejects(()=>assess(invalid),errorCode('INVALID_REQUEST'));
  invalid.request.route[1]=invalid.request.route[0];await assert.rejects(()=>assess(invalid),errorCode('INVALID_ROUTE'));
});

test('stale sources, geometry loss and changed revisions invalidate assessments without writes',options,async t=>{
  const p=await seed(t),baseline=await assess(p);
  assert.deepEqual(await assess(p),baseline);
  const bad=structuredClone(p);bad.request.space!.sha256='f'.repeat(64);
  await assert.rejects(()=>assess(bad),errorCode('SOURCE_DIGEST_MISMATCH'));
  const moved=structuredClone(p);moved.request.alternative={id:'move-wall',expected_base_revision:2,positions:[{entity_id:'spaceir:route-fixture:divider:0/instance',position:[0,0,-2.5]}]};
  assert.equal(status(await assess(moved),'space-binding'),'unknown');
  const urls={backend:pathToFileURL(join(root,'server/local-scene-backend.ts')).href};
  await runCode(`import {LocalSceneBackend} from ${JSON.stringify(urls.backend)};
    const b=new LocalSceneBackend(${JSON.stringify(p.dataDir)}),s=await b.read(${JSON.stringify(p.request.scene_id)});
    const v=await b.asset(s.document.instances[0].cloudVersionId);const {unlinkSync}=await import('node:fs');
    unlinkSync(${JSON.stringify(p.dataDir)}+'/assets/'+v.files[0].sha256+'.json');b.close();`);
  const missing=await assess(p);assert.equal(status(missing,'environment'),'unknown');
  await runCode(`import {LocalSceneBackend} from ${JSON.stringify(urls.backend)};
    const b=new LocalSceneBackend(${JSON.stringify(p.dataDir)}),s=await b.read(${JSON.stringify(p.request.scene_id)});
    const {randomUUID}=await import('node:crypto');const id=randomUUID();s.document.authoring={via:'test',agent:'test',parent_revision:2,request_id:id,request_digest:'9'.repeat(64)};
    await b.save(s.id,s.name,s.document,2,id);b.close();`);
  const stale=await assess(p);assert.equal(stale.stale,true);assert.equal(status(stale,'revision'),'failed');assert.equal(stale.geometric_path_length_m,null);
  assert.equal(stale.head_revision,3);assert.notEqual(stale.result_digest,baseline.result_digest);
});

test('CLI discovery/assessment emits JSON and incompatible comparisons have no metric delta',options,async t=>{
  const p=await seed(t),cli=fileURLToPath(new URL('../task-routes.js',import.meta.url)),input=join(p.dataDir,'input.json');
  await writeFile(input,JSON.stringify(p));
  const result=JSON.parse((await execute(process.execPath,[cli,'assess','--input',input],{env:{...process.env,OI_ROOT:root}})).stdout);
  assert.equal(readRouteAssessment(result,p.request).geometric_path_length_m,8);
  const caps=JSON.parse((await execute(process.execPath,[cli,'capabilities'],{env:{...process.env,OI_ROOT:root}})).stdout);
  assert.equal(caps.walkable_distance_supported,false);assert.deepEqual(caps.mutation_operations,[]);
  const proposed=structuredClone(p.request);proposed.profile.kind='cart';
  const comparison=await transport.request<{comparable:boolean;geometric_length_delta_m:number|null}>('route-assessment',{action:'compare',dataDir:p.dataDir,baseline:p.request,proposed});
  assert.equal(comparison.comparable,false);assert.equal(comparison.geometric_length_delta_m,null);
  proposed.alternative={id:'stale',expected_base_revision:1,positions:[{entity_id:'station-b',position:[4,0,2]}]};
  await assert.rejects(()=>assess({...p,request:proposed}),errorCode('CONFLICT'));
  assert.throws(()=>readRouteAssessment({...result,validated_walkable_route_length_m:8},p.request),/unsupported/);
});
