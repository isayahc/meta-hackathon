/** Deterministic association replay: synthetic clip and OI responses, real project persistence. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { buildProcessFromScan, saveRevision, applyCorrection } from '../dist/lib/processes.js';
import { spatialCommand, spatialEvidenceView, listSpatialAssociations } from '../dist/lib/spatial-evidence.js';
import { oiReferenceReader } from '../dist/lib/oi-reference.js';
import { OiMockTransport } from '../dist/lib/oi-connector.js';
const root=resolve(process.argv[2]||'');if(!process.argv[2])throw new Error('Pass a new absolute project directory.');await mkdir(root);await mkdir(join(root,'media'));
await writeFile(join(root,'media','synthetic.mp4'),'Synthetic non-playable source fixture, not actual farm footage.');
const p=buildProcessFromScan({id:'spatial-trays',analysis:{observed_task:'Synthetic tray preparation',per_frame:['Use scoop at tray station'],frame_times_s:[4]},media:'synthetic.mp4',eventId:'synthetic',duration_s:10});await saveRevision(root,p);
const target={kind:'oi',scene_id:'11111111-1111-4111-8111-111111111111',revision:1,entity_kind:'instance',entity_id:'station'};
const input={command:'save',request_id:'fixture-association',source:{process_id:p.id,process_revision:1,step_id:p.steps[0].id,start_s:4,end_s:4},target,origin:'model',review:'ambiguous',reason:'Synthetic cross-visit identity requires review'};
const a=await spatialCommand(root,input);assert.equal((await spatialCommand(root,input)).id,a.id);
await spatialCommand(root,{command:'review',request_id:'fixture-review',id:a.id,revision:1,review:'confirmed',reason:'Synthetic operator identifies the original station'});
const response={scene_id:target.scene_id,revision:1,head_revision:2,name:'Synthetic OI room',entity_state:'present',head_entity_state:'present',changed:true,scale:'unscaled',scale_reason:'Synthetic fixture has no calibration.',revision_url:'http://localhost:5173/?sceneId='+target.scene_id+'&revision=1',head_url:'http://localhost:5173/?sceneId='+target.scene_id,entities:[{id:'station',name:'Tray station',kind:'instance'}],mock:true};
const transport=new OiMockTransport({inspect:()=>response});
await applyCorrection(root,p.id,{steps:{[p.steps[0].id]:{label:'Corrected scoop step'}}},'Synthetic correction','operator');
const changed=await spatialEvidenceView(root,oiReferenceReader(root,transport));assert.ok(changed.associations[0].issues.some(i=>i.code==='scene_stale'));assert.ok(changed.associations[0].issues.some(i=>i.code==='process_stale'));assert.equal(changed.associations[0].association.target.revision,1);
response.head_entity_state='missing';const deleted=await spatialEvidenceView(root,oiReferenceReader(root,transport));assert.ok(deleted.associations[0].issues.some(i=>i.code==='entity_missing_at_head'));assert.ok(deleted.associations[0].evidence_url);
assert.equal((await listSpatialAssociations(root)).length,1);assert.ok(transport.calls.every(c=>c.op==='inspect'));
await writeFile(join(root,'association-evidence.json'),JSON.stringify({mode:'synthetic OI/clip fixture; not live inference or spatial validation',changed,deleted},null,2));
console.log(JSON.stringify({passed:true,canonical_associations:1,automatic_relinks:0,oi_mutations:0,mode:'synthetic OI and media; real SQLite persistence'}));

