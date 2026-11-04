import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildProcessFromScan, saveRevision, applyCorrection } from './processes.js';
import { initSpot } from './spot-state.js';
import { withDb } from './db.js';
import { spatialCommand, spatialEvidenceView, listSpatialAssociations } from './spatial-evidence.js';
import { oiReferenceReader, type OiReferenceInspection, type OiReference } from './oi-reference.js';
import { OiMockTransport, OiError } from './oi-connector.js';

const target:OiReference={kind:'oi',scene_id:'11111111-1111-4111-8111-111111111111',revision:1,entity_kind:'instance',entity_id:'station'};
/** Synthetic read response; never claims a running OI instance. */
function inspection(patch:Partial<OiReferenceInspection>={}):OiReferenceInspection {return {scene_id:target.scene_id,revision:1,head_revision:1,name:'Synthetic room',entity_state:'present',head_entity_state:'present',changed:false,scale:'unknown',scale_reason:'Physical scale is unverified.',revision_url:'http://localhost:5173/?sceneId='+target.scene_id+'&revision=1',head_url:'http://localhost:5173/?sceneId='+target.scene_id,entities:[{id:'station',name:'Tray station',kind:'instance'}],mock:true,...patch};}
/** Create real SQLite/media fixtures with explicitly synthetic source bytes. */
async function fixture(t:TestContext){const root=await mkdtemp(join(tmpdir(),'spatial-test-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'media'));await writeFile(join(root,'media','clip.mp4'),'synthetic source bytes');
  const p=buildProcessFromScan({id:'process',analysis:{observed_task:'Fill trays',per_frame:['Fill a tray'],frame_times_s:[2]},media:'clip.mp4',eventId:'e',duration_s:20});p.steps[0].evidence.spans=[{start_s:2,end_s:8}];await saveRevision(root,p);await initSpot(root,'bench','Potting bench');
  const command={command:'save',request_id:'create',source:{process_id:p.id,process_revision:p.rev,step_id:p.steps[0].id,start_s:3,end_s:6},target,origin:'human',review:'confirmed',reason:'Operator identifies the tray station'};return {root,p,command};}

test('association persists source checksum, timestamp, exact scene/entity revision and deduplicates retries',async t=>{const {root,command}=await fixture(t);const a=await spatialCommand(root,command);assert.equal(a.source.media,'clip.mp4');assert.match(a.source.sha256,/^[a-f0-9]{64}$/);assert.deepEqual(a.target,target);assert.deepEqual(await spatialCommand(root,command),a);assert.equal((await spatialCommand(root,{...command,request_id:'another-click'})).id,a.id);assert.equal(listSpatialAssociations(root).length,1);
  const view=await spatialEvidenceView(root,async()=>inspection());assert.match(view.associations[0].evidence_url!,/clip.mp4#t=3,6$/);assert.equal(view.associations[0].target_label,'Tray station');assert.equal(view.associations[0].current,false);assert.ok(view.associations[0].issues.some(i=>i.code==='mock_oi'));
  await assert.rejects(spatialCommand(root,{...command,reason:'changed'}),/already used/);
});

test('model identities require explicit review; ambiguity, rejection and stale-review conflicts survive reopening',async t=>{const {root,command}=await fixture(t);await assert.rejects(spatialCommand(root,{...command,origin:'model'}),/Automated/);const a=await spatialCommand(root,{...command,origin:'model',review:'ambiguous'});
  const rejected=await spatialCommand(root,{command:'review',request_id:'reject',id:a.id,revision:1,review:'rejected',reason:'Two similar stations; this is not established'});assert.equal(rejected.history[0].review,'ambiguous');assert.equal(listSpatialAssociations(root)[0].review,'rejected');
  await assert.rejects(spatialCommand(root,{command:'review',request_id:'old',id:a.id,revision:1,review:'confirmed',reason:'Stale click'}),/Stale/);
  await assert.rejects(spatialCommand(root,{...command,request_id:'resurrect',origin:'model',review:'proposed'}),/already exists/);assert.equal(listSpatialAssociations(root).length,1);
});

test('changed process, moved entity, deleted head entity and unavailable OI never relink',async t=>{const {root,p,command}=await fixture(t);const a=await spatialCommand(root,command);await applyCorrection(root,p.id,{steps:{[p.steps[0].id]:{label:'Corrected action'}}},'Correction','operator');
  let v=(await spatialEvidenceView(root,async()=>inspection({head_revision:2,changed:true}))).associations[0];assert.equal(v.current,false);assert.ok(v.issues.some(i=>i.code==='process_stale'));assert.ok(v.issues.some(i=>i.code==='scene_stale'));assert.ok(v.issues.some(i=>i.code==='entity_changed'));assert.deepEqual(v.association.target,target);assert.equal(v.association.source.process_revision,1);
  v=(await spatialEvidenceView(root,async()=>inspection({head_revision:3,head_entity_state:'missing'}))).associations[0];assert.ok(v.issues.some(i=>i.code==='entity_missing_at_head'));
  v=(await spatialEvidenceView(root,async()=>{throw new OiError('OI_ROOT_NOT_FOUND','Runtime unavailable');})).associations[0];assert.ok(v.issues.some(i=>i.code==='oi_unavailable'));assert.ok(v.evidence_url);
  assert.deepEqual(await spatialCommand(root,command),a);await assert.rejects(spatialCommand(root,{...command,request_id:'stale-new'}),/Stale process/);
  const updated=await spatialCommand(root,{...command,request_id:'reanchor',id:a.id,revision:1,source:{...command.source,process_revision:2},target:{...target,revision:3},reason:'Explicitly reviewed current scene and process'});assert.equal(updated.revision,2);assert.equal(updated.history[0].source.process_revision,1);assert.deepEqual(updated.history[0].target,target);
});

test('missing work areas and removed steps preserve original evidence for historical review',async t=>{const {root,p,command}=await fixture(t);const a=await spatialCommand(root,{...command,target:{kind:'spot',spot_id:'bench'}});assert.equal((await spatialEvidenceView(root)).associations[0].current,true);
  withDb(root,db=>db.prepare('DELETE FROM spots WHERE id=?').run('bench'));
  const patch={remove_step_ids:[p.steps[0].id],goals:Object.fromEntries(p.goals.map(g=>[g.id,{step_ids:[]}]))};await applyCorrection(root,p.id,patch,'Step removed after review','operator');
  const v=(await spatialEvidenceView(root)).associations[0];assert.ok(v.issues.some(i=>i.code==='spot_missing'));assert.ok(v.issues.some(i=>i.code==='step_missing'));assert.ok(v.evidence_url);assert.equal(v.association.id,a.id);
});

test('range validation rejects invented intervals, bad revisions and unsafe media; changed bytes disable playback',async t=>{const {root,command}=await fixture(t);
  for(const source of [{...command.source,start_s:-1},{...command.source,end_s:21},{...command.source,end_s:9},{...command.source,start_s:NaN},{...command.source,step_id:'missing'}])await assert.rejects(spatialCommand(root,{...command,source}));
  await spatialCommand(root,command);await writeFile(join(root,'media','clip.mp4'),'different bytes');let v=(await spatialEvidenceView(root,async()=>inspection())).associations[0];assert.equal(v.evidence_url,null);assert.ok(v.issues.some(i=>i.code==='media_changed'));await rm(join(root,'media','clip.mp4'));v=(await spatialEvidenceView(root,async()=>inspection())).associations[0];assert.ok(v.issues.some(i=>i.code==='media_missing'));
});

test('unscaled and unsupported region evidence remain explicit; resolver only performs inspect',async t=>{const {root,command}=await fixture(t);await spatialCommand(root,{...command,target:{...target,entity_kind:'region',entity_id:'room-1'}});
  const transport=new OiMockTransport({inspect:()=>inspection({entity_state:'unsupported',head_entity_state:'unsupported',scale:'unscaled',scale_reason:'No metric calibration supplied.'})});
  const view=await spatialEvidenceView(root,oiReferenceReader(root,transport));assert.ok(view.associations[0].issues.some(i=>i.code==='entity_unsupported'));assert.ok(view.associations[0].issues.some(i=>i.code==='unscaled'));assert.equal(view.associations[0].current,false);assert.deepEqual(transport.calls.map(c=>c.op),['inspect']);
  const bad=new OiMockTransport({inspect:()=>inspection({revision:2})});await assert.rejects(oiReferenceReader(root,bad)(target),/incompatible/);
});
