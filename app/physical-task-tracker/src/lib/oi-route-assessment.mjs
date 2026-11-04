/** Read-only route assessment seam, executed inside pinned OI. No Field Ops/model dependency. */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assessTransform, reconstructionSchema } from './oi-reconstruction.mjs';
const PIN = '50f78e0bef23c5a6958d80c50e9232066ecc11d2';
export const ROUTE_SCHEMA = 'oi-route-assessment/1';
const str = {type:'string',minLength:1,maxLength:512};
const id = {...str,maxLength:256};
const num = {type:'number',minimum:-1e6,maximum:1e6};
const positive = {type:'number',exclusiveMinimum:0,maximum:100};
const vector = {type:'array',minItems:3,maxItems:3,items:num};
const array = (items,maxItems=100) => ({type:'array',items,maxItems});
const object = (properties,required=Object.keys(properties)) => ({type:'object',additionalProperties:false,properties,required});
const nullable = schema => ({anyOf:[schema,{type:'null'}]});
export const routeSchema = object({
  schema:{const:ROUTE_SCHEMA}, scene_id:reconstructionSchema.properties.scene_id,
  revision:{type:'integer',minimum:1}, frame:{const:'oi-world-m-Y-up'},
  station_ids:{...array(id,2),minItems:2,uniqueItems:true},
  route:{...array(vector,200),minItems:2},
  profile:object({kind:{enum:['person','cart']},width_m:nullable(positive),margin_m:nullable({type:'number',minimum:0,maximum:10}),source:str}),
  evidence:reconstructionSchema.properties.source.properties.artifacts,
  scale:reconstructionSchema.properties.scale,
  environment:object({coverage:{enum:['complete','partial']},source:str,unknowns:array(str)}),
  space:nullable(object({document:{type:'object'},sha256:{type:'string',pattern:'^[a-f0-9]{64}$'},
    from_region:id,to_region:id,source:str})),
  alternative:nullable(object({id,expected_base_revision:{type:'integer',minimum:1},
    positions:{...array(object({entity_id:id,position:vector})),minItems:1}})),
});
const fail = (code,message) => {throw Object.assign(new Error(message),{code,upstream:false});};
const hash = text => createHash('sha256').update(text).digest('hex');

/** Load upstream frame, manifest, asset and plan operations; no scene write interface is exposed to evaluation. */
async function runtime(root) {
  if(execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==PIN) fail('OI_PIN_MISMATCH',`Use pinned OI ${PIN}.`);
  const mod = file => import(pathToFileURL(join(root,file)).href), require=createRequire(join(root,'package.json'));
  const [backend,workspace,space,compiler,plan,cloud,links] = await Promise.all([
    mod('server/local-scene-backend.ts'),mod('src/lib/workspace.ts'),mod('packages/space-ir/src/index.ts'),
    mod('src/lib/space-ir-compiler.ts'),mod('src/lib/plan-projection.ts'),mod('src/lib/cloud-storage.ts'),mod('src/lib/scene-links.ts'),
  ]);
  return {...backend,...workspace,...space,...compiler,...plan,...cloud,...links,...require('three'),Ajv:require('ajv').default};
}

/** Finite segment separation using OI's Three primitives, including endpoints and collinear contact. */
function separation(a,b,c,d,oi) {
  const v = p => new oi.Vector3(p[0],0,p[1]), A=v(a),B=v(b),C=v(c),D=v(d);
  const ab=new oi.Line3(A,B),cd=new oi.Line3(C,D),scratch=new oi.Vector3();
  let distance=Math.min(cd.closestPointToPoint(A,true,scratch).distanceTo(A),cd.closestPointToPoint(B,true,scratch).distanceTo(B),
    ab.closestPointToPoint(C,true,scratch).distanceTo(C),ab.closestPointToPoint(D,true,scratch).distanceTo(D));
  const length=A.distanceTo(B), onRay=new oi.Vector3(),onEdge=new oi.Vector3();
  if(length>1e-10) {
    const ray=new oi.Ray(A,B.clone().sub(A).normalize());
    const squared=ray.distanceSqToSegment(C,D,onRay,onEdge);
    if(onRay.distanceTo(A)<=length+1e-8) distance=Math.min(distance,Math.sqrt(Math.max(0,squared)));
  }
  return distance;
}

/** Conservative distance to the upstream plan footprint or an explicit SpaceIR occupied polygon. */
function polygonDistance(a,b,polygon,oi) {
  if(oi.planContains(a,polygon)||oi.planContains(b,polygon))return 0;
  return Math.min(...polygon.map((p,i)=>separation(a,b,p,polygon[(i+1)%polygon.length],oi)));
}

/** Pure assessment over a single pinned snapshot and verified immutable geometry. */
async function evaluate(request,saved,head,backend,oi,origin) {
  const checks=[],add=(id,status,reason,details={})=>checks.push({id,status,reason,...details});
  const inputDigest=hash(oi.canonicalJSON(request));
  const result={schema:ROUTE_SCHEMA,validator:{name:'oi-route-adapter',version:1,oi_revision:PIN},input_digest:inputDigest,
    scene_id:saved.id,revision:saved.revision,head_revision:head.revision,alternative_id:request.alternative?.id??null,
    scene_digest:hash(oi.canonicalJSON(saved.document)),...oi.sceneURLs(saved.id,saved.revision,origin),
    view_scope:'accepted revision only; in-memory alternatives are not rendered by these links',
    checks,geometric_path_length_m:null,validated_walkable_route_length_m:null,segments:[],scale:null,
    assumptions:{profile:request.profile,environment:request.environment,evidence:request.evidence,
      elevation:'Flat Y=0 X/Z paths only; no inferred slope, stairs or vertical clearance.',
      geometry:'All instances count, including hidden objects. Conservative OI plan envelopes can overestimate obstructions.',
      endpoints:'Reviewed station IDs identify the workflow; supplied endpoint access points are not automatically certified.'},
    traversability:'unknown',stale:head.revision!==saved.revision,mutations:0,mock:false};
  const finish=()=>{result.traversability=checks.some(c=>c.status==='failed')?'failed':'unknown';
    result.result_digest=hash(oi.canonicalJSON(result));return result;};
  add('request-schema','passed','Versioned request schema is valid; this is not feasibility.');
  if(result.stale){add('revision','failed','Accepted scene changed; re-review and reassess.',{expected:request.revision,actual:head.revision});return finish();}
  add('revision','passed','Assessment is tied to the current immutable revision.');
  const document=structuredClone(saved.document),manifest=oi.readManifest(document);
  if(request.station_ids.some(id=>!manifest.instances.some(i=>i.id===id))){add('identity','unknown','A station is missing/deleted; no proximity-based relinking.');return finish();}
  add('identity','passed','Both distinct station instance IDs resolve at the pinned revision.');
  if(request.alternative){
    if(request.alternative.expected_base_revision!==saved.revision)fail('CONFLICT','Alternative expected base revision differs from its pinned scene.');
    const ids=request.alternative.positions.map(p=>p.entity_id);
    if(new Set(ids).size!==ids.length)fail('AMBIGUOUS_IDENTITY','Alternative repeats a target identity.');
    for(const move of request.alternative.positions){const item=document.instances.find(i=>i.id===move.entity_id);
      if(!item)fail('STALE_IDENTITY','Alternative references a missing instance.');item.position=[...move.position];}
    oi.readManifest(document);
  }
  const scale=assessTransform({frame:{handedness:'right',matrix:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]},
    source:{artifacts:request.evidence},scale:request.scale},oi);
  result.scale=scale.evidence;
  const metric=scale.evidence.status==='holdout-passed';
  add('scale',metric?'passed':scale.evidence.status.endsWith('failed')?'failed':'unknown',
    metric?'Independent held-out anchors support metric calculations under the declared tolerances; accuracy is not certified.':'Metric claims require calibrated canonical-world anchors and an independent passing holdout.');
  if(request.route.some(p=>Math.abs(p[1])>1e-8)){add('elevation','unsupported','This version supports only flat Y=0 routes.');return finish();}
  add('elevation','passed','Route is explicitly horizontal at Y=0.');
  const vectors=request.route.map(p=>new oi.Vector3(...p));
  const lengths=vectors.slice(1).map((p,i)=>p.distanceTo(vectors[i]));
  if(lengths.some(n=>n<=1e-9))fail('INVALID_ROUTE','Consecutive route points must be distinct.');
  if(metric)result.geometric_path_length_m=lengths.reduce((sum,n)=>sum+n,0);
  add('geometric-length',metric?'passed':'unknown',metric?'Sum of supplied polyline segments; not straight-line or walkable-route distance.':'No verified meter-distance claim for unverified scale.');
  if(!metric)return finish();
  const versions=new Map(),missing=[];
  for(const item of document.instances){
    if(versions.has(item.cloudVersionId))continue;
    try{const version=await backend.asset(item.cloudVersionId);if(!version)throw new Error('Missing asset');
      versions.set(item.cloudVersionId,oi.parseCloudBundle(await backend.geometry(version)).asset);
    }catch{missing.push(item.id);}
  }
  const workspace=oi.hydrateManifest(oi.readManifest(document),[],versions);
  // Display visibility is not a claim that a physical obstacle ceased to exist.
  workspace.items.forEach(i=>{i.visible=true;});
  const projection=oi.projectWorkspacePlan(workspace,null);
  const radius=request.profile.width_m===null||request.profile.margin_m===null?null:request.profile.width_m/2+request.profile.margin_m;
  const segments=request.route.slice(1).map((b,i)=>({index:i,from:request.route[i],to:b,length_m:lengths[i],obstructions:[],clearance_violations:[]}));
  result.segments=segments;
  const gaps=[...request.environment.unknowns,...missing.map(id=>`Missing geometry: ${id}`)];
  if(document.animation.tracks.length)gaps.push('Animated geometry is assessed at its base pose only; motion is unsupported.');
  const occupiedPolygons=projection.footprints.filter(f=>!f.missing).map(f=>f.points);
  let space=null,sourceAligned=false;
  if(request.space){
    const validation=oi.validateSpaceIR(request.space.document);
    add('space-schema',validation.valid?'passed':'failed','Upstream SpaceIR schema/topology validation.',{findings:validation.findings});
    if(validation.valid){
      space=request.space.document;
      if(hash(oi.canonicalSpaceJSON(space))!==request.space.sha256)fail('SOURCE_DIGEST_MISMATCH','SpaceIR digest differs from supplied source.');
      try{
        const compiled=await oi.compileSpaceIR(space), expected=oi.makeManifest(compiled.workspace);
        sourceAligned=expected.instances.length>0&&expected.instances.every(item=>{
          const actual=document.instances.find(i=>i.id===item.id),asset=document.assets.find(a=>a.id===item.assetId),ref=expected.assets.find(a=>a.id===item.assetId);
          return actual&&oi.canonicalJSON(actual.position)===oi.canonicalJSON(item.position)&&oi.canonicalJSON(actual.rotation)===oi.canonicalJSON(item.rotation)&&actual.assetId===item.assetId&&asset?.source.digest===ref?.source.digest;
        });
        // Validate actual immutable geometry metadata too, not just a client-editable manifest source digest.
        sourceAligned=sourceAligned&&expected.instances.every(item=>{
          const actual=document.instances.find(i=>i.id===item.id),asset=versions.get(actual?.cloudVersionId),expectedAsset=compiled.workspace.items.find(i=>i.id===item.id)?.asset;
          return asset&&expectedAsset&&oi.canonicalJSON(asset.parts)===oi.canonicalJSON(expectedAsset.parts);
        });
        gaps.push(...compiled.diagnostics.filter(d=>!['OPENING_ONLY','UNCOMPILED_OCCUPANCY'].includes(d.code)).map(d=>d.message));
      }catch{gaps.push('SpaceIR could not be compiled against the accepted scene.');}
      add('space-binding',sourceAligned?'passed':'unknown',sourceAligned?'Compiled boundary identities/poses/geometry match this scene or in-memory alternative.':'SpaceIR boundaries do not match authoritative scene geometry; topology checks are unavailable.');
    }
  }else add('space-schema','unknown','No SpaceIR source supplied; connectivity/portal semantics remain unknown.');
  const xz=p=>[p[0],p[2]];
  for(const footprint of projection.footprints){
    if(footprint.missing){gaps.push(`Unsupported/missing footprint: ${footprint.instanceId}`);continue;}
    for(const segment of segments){const d=polygonDistance(xz(segment.from),xz(segment.to),footprint.points,oi);
      if(d<=1e-8)segment.obstructions.push({entity_id:footprint.instanceId,basis:'conservative-plan-envelope'});
      if(radius!==null&&d<=radius+1e-8)segment.clearance_violations.push({entity_id:footprint.instanceId,separation_m:d,required_m:radius,basis:'conservative-plan-envelope'});
    }
  }
  if(space&&sourceAligned){
    const origin=oi.resolveMetricPoint(space.frames.find(f=>f.id===space.site.frame_id),[0,0]);
    const point=(frame,p)=>{const f=space.frames.find(f=>f.id===frame);const q=f?oi.resolveMetricPoint(f,p):null;return q&&origin?[q[0]-origin[0],q[1]-origin[1]]:null;};
    const polygon=entity=>entity.polygon?.map(p=>point(entity.frame_id,p));
    const from=space.regions.find(r=>r.id===request.space.from_region),to=space.regions.find(r=>r.id===request.space.to_region);
    const fromPoly=from&&polygon(from),toPoly=to&&polygon(to);
    if(!from||!to||!fromPoly?.every(Boolean)||!toPoly?.every(Boolean))add('connectivity','unknown','Missing region identities or geometry.');
    else{
      const endpoints=oi.planContains(xz(request.route[0]),fromPoly)&&oi.planContains(xz(request.route.at(-1)),toPoly);
      const reachable=oi.accessibleRegions({...space,portals:space.portals.filter(p=>p.kind!=='window')},from.id).includes(to.id);
      add('connectivity',!endpoints?'failed':reachable?'passed':'unknown',!endpoints?'Supplied access points do not lie in the declared regions.':reachable?'Explicit traversable portals connect endpoint regions; this alone is not reachability.':'Adjacency or a window does not establish traversable connectivity.');
    }
    for(const occupancy of space.occupancies){const poly=polygon(occupancy);
      if(!poly?.every(Boolean)){gaps.push(`Unknown occupancy geometry: ${occupancy.id}`);continue;}
      occupiedPolygons.push(poly);
      for(const segment of segments){const d=polygonDistance(xz(segment.from),xz(segment.to),poly,oi);
        if(d<=1e-8)segment.obstructions.push({entity_id:occupancy.id,basis:'explicit-SpaceIR-occupancy'});
        if(radius!==null&&d<=radius+1e-8)segment.clearance_violations.push({entity_id:occupancy.id,separation_m:d,required_m:radius,basis:'explicit-SpaceIR-occupancy'});
      }
    }
    for(const boundary of space.boundaries){
      const a=boundary.path&&point(boundary.frame_id,boundary.path[0]),b=boundary.path&&point(boundary.frame_id,boundary.path[1]);
      if(!a||!b){gaps.push(`Unknown boundary: ${boundary.id}`);continue;}
      for(const segment of segments){if(separation(xz(segment.from),xz(segment.to),a,b,oi)>1e-8)continue;
        const openings=space.portals.filter(p=>p.boundary_id===boundary.id);
        const crossing=openings.filter(p=>{
          const lo=a.map((v,i)=>v+(b[i]-v)*p.span[0]),hi=a.map((v,i)=>v+(b[i]-v)*p.span[1]);
          return separation(xz(segment.from),xz(segment.to),lo,hi,oi)<=1e-8;
        });
        if(crossing.length!==1||crossing[0].kind==='window'||!crossing[0].traversable){
          segment.obstructions.push({entity_id:boundary.id,basis:'nontraversable-or-ambiguous-boundary-crossing'});
          add(`portal:${boundary.id}:${segment.index}`,'failed','Route crosses a wall, window, nontraversable or ambiguous portal.');
        }else{
          const portal=crossing[0],width=Math.hypot(b[0]-a[0],b[1]-a[1])*(portal.span[1]-portal.span[0]);
          add(`portal:${portal.id}:${segment.index}`,radius===null?'unknown':width<=radius*2+1e-8?'failed':'passed',
            'Declared traversable opening width; lintel height, door state and access remain unverified.',{width_m:width,required_m:radius===null?null:radius*2});
        }
      }
    }
    for(const constraint of space.constraints){
      const region=space.regions.find(r=>r.id===constraint.region_id),area=region&&polygon(region);
      const applicable=area?.every(Boolean)?segments.filter(s=>polygonDistance(xz(s.from),xz(s.to),area,oi)<=1e-8):null;
      const required=constraint.minimum_m===null?null:Math.max(constraint.minimum_m/2,radius??0);
      const violation=required!==null&&applicable?.some(s=>occupiedPolygons.some(poly=>polygonDistance(xz(s.from),xz(s.to),poly,oi)<=required+1e-8));
      add(`constraint:${constraint.id}`,constraint.kind!=='clearance'?'unsupported':required===null||!applicable?'unknown':violation?'failed':gaps.length?'unknown':'passed',
        'Declared minimum horizontal width against supported geometry on segments touching this region; conservative envelopes and boundary contact count as violations.',
        {authority:constraint.authority,minimum_m:constraint.minimum_m,segments:applicable?.map(s=>s.index)??[]});
    }
    gaps.push(...space.unresolved);
  }
  if(space&&!sourceAligned)gaps.push('SpaceIR semantics/occupancies are not bound to current geometry.');
  const obstructed=segments.some(s=>s.obstructions.length),narrow=segments.some(s=>s.clearance_violations.length);
  add('obstruction',obstructed?'failed':gaps.length?'unknown':'passed','Supported explicit occupancies and conservative OI plan envelopes only.');
  add('horizontal-clearance',radius===null?'unknown':narrow?'failed':gaps.length?'unknown':'passed',radius===null?'Profile width/margin evidence is incomplete.':'Swept circular horizontal profile against supported footprints; no turning-radius or vertical-clearance claim.');
  const boundaryViolation=segments.some(s=>[s.from,s.to].some(p=>Math.abs(p[0])+(radius??0)>projection.room.width/2||Math.abs(p[2])+(radius??0)>projection.room.depth/2));
  add('planning-envelope',boundaryViolation?'failed':radius===null?'unknown':'passed','Route/profile must remain inside the declared OI planning envelope.');
  add('environment',request.environment.coverage==='complete'&&!gaps.length?'passed':'unknown','Coverage is an external reviewer assertion, not inferred from visibility.',{gaps:[...new Set(gaps)]});
  add('physical-traversability','unsupported','Floor support, slope, headroom, dynamic obstacles, door state and cart turning radius are not certified by the pinned interfaces.');
  return finish();
}

/** Discover, assess or compare; query code calls read/asset/geometry only. */
export async function routeOperation(root,op,payload={}) {
  if(op==='capabilities')return {schema:ROUTE_SCHEMA,oi_revision:PIN,request_schema:routeSchema,
    operations:['assess','compare'],supported:['flat supplied polyline length','conservative OI footprint obstruction/width','explicit SpaceIR occupancy and portal checks','in-memory translations'],
    unsupported:['shortest path','full physical traversability','vertical clearance','cart turning radius','unscaled distances'],mutation_operations:[],walkable_distance_supported:false};
  if(!['assess','compare'].includes(op))fail('INVALID_REQUEST','Use capabilities, assess or compare.');
  const oi=await runtime(resolve(root)),check=new oi.Ajv({strict:false,strictNumbers:true}).compile(routeSchema);
  const requests=op==='compare'?[payload.baseline,payload.proposed]:[payload.request];
  if(Buffer.byteLength(JSON.stringify(payload))>1024*1024)fail('PAYLOAD_TOO_LARGE','Assessment input exceeds 1 MiB.');
  for(const request of requests)if(!check(request))fail('INVALID_REQUEST','Invalid route assessment contract: '+JSON.stringify(check.errors));
  for(const request of requests)if(new Set(request.evidence.map(e=>e.id)).size!==request.evidence.length)fail('AMBIGUOUS_EVIDENCE','Evidence IDs must be unique.');
  if(op==='compare'&&(requests[0].scene_id!==requests[1].scene_id||requests[0].revision!==requests[1].revision||requests[0].alternative!==null))
    fail('CONFLICT','Compare an accepted baseline and proposal against the same scene revision.');
  if(typeof payload.dataDir!=='string'||!existsSync(join(payload.dataDir,'scenes.sqlite')))fail('SCENE_UNAVAILABLE','An existing local OI scene store is required.');
  const backend=new oi.LocalSceneBackend(payload.dataDir);
  try{
    const saved=await backend.read(requests[0].scene_id,requests[0].revision),head=await backend.read(requests[0].scene_id);
    const results=[];
    for(const request of requests)results.push(await evaluate(request,saved,head,backend,oi,payload.workbenchOrigin||'http://127.0.0.1:5173'));
    const after=await backend.read(saved.id);
    if(after.revision!==head.revision)fail('CONFLICT','Scene changed while assessing; discard and reassess.');
    if(op==='assess')return results[0];
    const comparable=oi.canonicalJSON(requests[0].station_ids)===oi.canonicalJSON(requests[1].station_ids)&&oi.canonicalJSON(requests[0].evidence)===oi.canonicalJSON(requests[1].evidence)&&oi.canonicalJSON(requests[0].profile)===oi.canonicalJSON(requests[1].profile)&&oi.canonicalJSON(requests[0].scale)===oi.canonicalJSON(requests[1].scale)&&results.every(r=>r.geometric_path_length_m!==null);
    return {schema:ROUTE_SCHEMA,baseline:results[0],proposed:results[1],geometric_length_delta_m:comparable?results[1].geometric_path_length_m-results[0].geometric_path_length_m:null,
      comparable,mutations:0,decision:'not-adopted',note:'Geometric difference is not validated walkable distance or realized savings.'};
  }finally{backend.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{const chunks=[];let size=0;for await(const chunk of process.stdin){size+=chunk.length;if(size>1024*1024)fail('PAYLOAD_TOO_LARGE','Input exceeds 1 MiB.');chunks.push(chunk);}
    const {op,payload}=JSON.parse(Buffer.concat(chunks).toString('utf8'));console.log(JSON.stringify({ok:true,result:await routeOperation(process.env.OI_RUNNER_ROOT||process.cwd(),op,payload)}));
  }catch(e){console.log(JSON.stringify({ok:false,code:e.code||'ASSESSMENT_FAILED',message:e.message}));process.exitCode=1;}
}
