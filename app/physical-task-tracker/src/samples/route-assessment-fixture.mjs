/** Provider-neutral OI route fixture; expected lengths are declared before any assessment. */
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join,resolve } from 'node:path';
import { seedFixture } from './reconstruction-fixture.mjs';
export const EXPECTED={bent_length_m:8,straight_length_m:Math.sqrt(32),door_width_m:2};

/** Seed a two-station scene through OI APIs. Options exercise explicit incomplete/portal evidence. */
export async function seedRouteFixture(root,dataDir,options={}) {
  const {sceneId,version}=await seedFixture(root,dataDir),mod=file=>import(pathToFileURL(join(root,file)).href);
  const [{LocalSceneBackend},{compileSpaceIR},{makeManifest,canonicalJSON},{parseCloudBundle}]=await Promise.all([
    mod('server/local-scene-backend.ts'),mod('src/lib/space-ir-compiler.ts'),mod('src/lib/workspace.ts'),mod('src/lib/cloud-storage.ts')]);
  const space={schema_id:'mapped-assembly.space-ir',schema_version:'0.1.0',id:'route-fixture',revision:'1',
    site:{frame_id:'world',width_m:10,depth_m:10,height_m:3},frames:[{id:'world',units:'m',axes:'XZ'}],
    regions:[{id:'left',kind:'room',frame_id:'world',polygon:[[-5,-5],[0,-5],[0,5],[-5,5]]},
      {id:'right',kind:'room',frame_id:'world',polygon:[[0,-5],[5,-5],[5,5],[0,5]]}],
    boundaries:[{id:'divider',kind:'partition',region_ids:['left','right'],frame_id:'world',path:[[0,-5],[0,5]],thickness_m:.1,height_m:3}],
    portals:options.adjacent?[]:[{id:'opening',kind:options.window?'window':'door',boundary_id:'divider',connects:['left','right'],span:[.4,.6],traversable:!options.window}],
    spatial_relations:[{id:'adjacent',kind:'adjacent',from:'left',to:'right'}],
    occupancies:options.missingObstacle?[{id:'unknown-obstacle',region_id:'left',frame_id:'world',polygon:null}]:
      options.occupied?[{id:'tray-stack',region_id:'left',frame_id:'world',polygon:[[-2.4,-1.3],[-1.6,-1.3],[-1.6,-.7],[-2.4,-.7]]}]:[],
    constraints:options.clearanceConstraint?[{id:'minimum-aisle',kind:'clearance',region_id:'left',minimum_m:2.2,authority:'fixture-required-aisle-width'}]:[],evidence:[],unresolved:[]};
  const backend=new LocalSceneBackend(dataDir);
  try{
    const compiled=await compileSpaceIR(space),workspace=compiled.workspace;
    const asset=parseCloudBundle(await backend.geometry(await backend.asset(version))).asset;
    workspace.items.push(...[['station-a',[-3,0,-2]],['station-b',[3,0,2]]].map(([id,position])=>({id,name:id,asset,position,rotation:[0,0,0],visible:true,cloudVersionId:version})));
    for(const item of workspace.items)item.cloudVersionId=await backend.persistAsset(item.asset);
    const document={...makeManifest(workspace),authoring:{via:'fixture',agent:'fixture',parent_revision:1,request_id:randomUUID(),request_digest:'1'.repeat(64)}};
    await backend.save(sceneId,'Route fixture',document,1,document.authoring.request_id);
    const request={schema:'oi-route-assessment/1',scene_id:sceneId,revision:2,frame:'oi-world-m-Y-up',station_ids:['station-a','station-b'],
      route:[[-2,0,-2],[-2,0,0],[2,0,0],[2,0,2]],profile:{kind:'person',width_m:.6,margin_m:.1,source:'fixture-profile'},
      evidence:[{id:'survey',uri:'fixture://survey',sha256:createHash('sha256').update('canonical-world fixture anchors').digest('hex')}],
      scale:{predicted_m_per_unit:null,calibration:{id:'calibration',artifact_id:'survey',anchor_ids:['a','b'],points:[[-4,0,-4],[-3,0,-4]],measured_m:1,tolerance_m:.001},
        holdout:{id:'holdout',artifact_id:'survey',anchor_ids:['c','d'],points:[[3,0,4],[4,0,4]],measured_m:1,tolerance_m:.001},holdout_independence:'reviewer-attested'},
      environment:{coverage:'complete',source:'Explicit deterministic fixture; no real environment claim.',unknowns:[]},
      space:{document:space,sha256:createHash('sha256').update(canonicalJSON(space)).digest('hex'),from_region:'left',to_region:'right',source:'OI fixture compilation'},alternative:null};
    return {request,dataDir};
  }finally{backend.close();}
}

/** Run repeatability and counterfactual checks with mutation methods made unusable during evaluation. */
export async function runRouteFixture(root,dataDir,adapter) {
  const {routeOperation}=await import(pathToFileURL(adapter).href),seeded=await seedRouteFixture(root,dataDir);
  const {LocalSceneBackend}=await import(pathToFileURL(join(root,'server/local-scene-backend.ts')).href);
  const backend=new LocalSceneBackend(dataDir),before=await backend.read(seeded.request.scene_id);
  const beforeAssets=await backend.list(0);backend.close();
  const save=LocalSceneBackend.prototype.save,persist=LocalSceneBackend.prototype.persistAsset;
  let mutationAttempts=0;
  LocalSceneBackend.prototype.save=LocalSceneBackend.prototype.persistAsset=async()=>{mutationAttempts++;throw new Error('Assessment attempted a scene write');};
  try{
    const baseline=await routeOperation(root,'assess',seeded);
    assert.equal(baseline.geometric_path_length_m,EXPECTED.bent_length_m);
    assert.equal(baseline.checks.find(c=>c.id==='space-binding').status,'passed');
    assert.equal(baseline.checks.find(c=>c.id==='horizontal-clearance').status,'passed');
    assert.equal(baseline.validated_walkable_route_length_m,null);assert.equal(baseline.traversability,'unknown');
    assert.deepEqual(await routeOperation(root,'assess',seeded),baseline);
    const proposed=structuredClone(seeded.request);proposed.route=[[-2,0,-2],[2,0,2]];
    proposed.alternative={id:'proposed-station-position',expected_base_revision:2,positions:[{entity_id:'station-b',position:[3.5,0,2]}]};
    const comparison=await routeOperation(root,'compare',{dataDir,baseline:seeded.request,proposed});
    assert.equal(comparison.proposed.geometric_path_length_m,EXPECTED.straight_length_m);
    assert.equal(comparison.geometric_length_delta_m,EXPECTED.straight_length_m-EXPECTED.bent_length_m);
    const reopened=new LocalSceneBackend(dataDir);
    try{assert.deepEqual(await reopened.read(before.id),before);assert.deepEqual(await reopened.list(0),beforeAssets);}finally{reopened.close();}
    assert.equal(mutationAttempts,0);
    return {status:'passed',mode:'deterministic fixture with real pinned OI',live_inference:false,expected:EXPECTED,
      request:seeded.request,baseline,comparison,mutation_attempts:mutationAttempts};
  }finally{LocalSceneBackend.prototype.save=save;LocalSceneBackend.prototype.persistAsset=persist;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{const [root,dataDir,adapter]=process.argv.slice(2);if(!root||!dataDir||!adapter)throw new Error('Pass absolute OI root, new data directory and route adapter path.');
    console.log(JSON.stringify(await runRouteFixture(root,dataDir,adapter)));
  }catch(e){console.error(e);process.exitCode=1;}
}
