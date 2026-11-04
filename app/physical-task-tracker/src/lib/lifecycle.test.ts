/** Lifecycle contracts: real persistence/services, synthetic observations, no ports or live inference. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lifecycleFixture } from './lifecycle-fixture.js';
import { lifecycleCommand, captureEpisode, lifecycleDigest, validateEpisode, validateBundle, validateDataset, policyInput, inferPolicy, episodeProblems, type Episode, type Dataset, type Bundle, type Evaluation } from './lifecycle.js';
import { applyCorrection } from './processes.js';
import { withDb, setDoc } from './db.js';
import { evaluateTrial, recordTrialVisit } from './outcomes.js';
import type { OiReferenceReader } from './oi-reference.js';
async function fixture(t:TestContext){const root=await mkdtemp(join(tmpdir(),'lifecycle-'));t.after(()=>rm(root,{recursive:true,force:true}));return lifecycleFixture(root);}
function capture(trial:Awaited<ReturnType<typeof lifecycleFixture>>['trial'],followup=false){return {command:'capture',trial_id:trial.id,trial_revision:trial.revision,visit_id:followup?trial.followups[0].id:trial.baseline!.id,mode:'synthetic',reviewer:'Fixture reviewer',reason:'Invented tray observations for software regression',expected_status:followup?'improved':'unknown',permissions:{metadata_export:true,media_export:false,training:false,authority:'Fixture author'}};}
async function dataset(root:string,episodes:Episode[],split='test'):Promise<Dataset>{return await lifecycleCommand(root,{command:'dataset',id:'tray-review',version:1,inclusion_criteria:'Synthetic reviewed baseline and follow-up; no farmer validation.',members:episodes.map(e=>({id:e.id,revision:e.revision,split}))}) as Dataset;}
async function exported(root:string):Promise<Bundle>{return await lifecycleCommand(root,{command:'export',id:'tray-review',version:1}) as Bundle;}
test('baseline and linked follow-up retain predictions, reviewed corrections, unknowns and normalized outcome independently',async t=>{
 const {root,trial,follow}=await fixture(t);const base=await captureEpisode(root,capture(trial)),updated=follow(trial),next=await captureEpisode(root,capture(updated,true));
 assert.equal(base.role,'baseline');assert.equal(base.trial.followups.length,0);assert.equal(next.trial_id,base.trial_id);assert.equal(next.transition.subsequent_state,null);assert.equal(next.trial.assessment.decision,'accepted');assert.equal(next.transition.observed.intervention_applied,true);assert.ok(next.trial.baseline!.process_snapshot.corrections.length);assert.equal(next.trial.assessment.comparisons[0].status,'projection');assert.equal(next.sources[0].checksum,null);
 const result=inferPolicy(policyInput(next));assert.equal(result.status,'improved');assert.equal(result.metrics[0].baseline,2);assert.equal(result.metrics[0].followup,1.2);assert.equal(result.completed,false);assert.equal(result.action,'review_result');assert.match(result.next_action,/Review/);assert.equal(validateEpisode(next).id,next.id);
});
test('dataset splits group baseline/follow-up, same session, same media digest, and workflow aliases',async t=>{
 const {root,trial,follow}=await fixture(t),base=await captureEpisode(root,capture(trial)),next=await captureEpisode(root,capture(follow(trial),true));
 await assert.rejects(()=>lifecycleCommand(root,{command:'dataset',id:'leak',version:1,inclusion_criteria:'Bad split',members:[{id:base.id,revision:1,split:'development'},{id:next.id,revision:1,split:'test'}]}),/Split leakage/);
 for(const kind of ['session','checksum','workflow']){const other=structuredClone(base);other.id='other';other.trial_id='other-trial';other.trial.id='other-trial';other.sources[0].session='other-session';other.sources[0].identity='other-source';
 if(kind==='session')other.sources[0].session=base.sources[0].session;
 if(kind==='checksum'){base.sources[0].checksum='a'.repeat(64);other.sources[0].checksum='a'.repeat(64);}
 if(kind==='workflow'){base.workflow_id='same-workflow';other.workflow_id='same-workflow';}
 assert.throws(()=>validateDataset({schema:'workflow-dataset/1',id:'split',version:1,created_at:new Date().toISOString(),inclusion_criteria:'Fixture',members:[{id:base.id,revision:1,digest:lifecycleDigest(base),split:'development'},{id:other.id,revision:1,digest:lifecycleDigest(other),split:'test'}]},[base,other]),/Split leakage/);}
});
test('actual held-out evaluation excludes answer annotations and selection/inference never changes tasks or trials',async t=>{
 const {root,trial,follow}=await fixture(t),updated=follow(trial),e=await captureEpisode(root,capture(updated,true));await dataset(root,[e]);
 const input=policyInput(e);assert.equal(input.decisions.length,0);assert.equal(input.corrections.length,0);assert.equal(input.review_snapshot,null);assert.equal(input.baseline!.source_snapshot,null);assert.equal(JSON.stringify(input).includes(e.review.reason),false);
 const poisoned=structuredClone(e);poisoned.review.expected_status='worse';poisoned.trial.decisions=[{decision:'keep',reason:'ANSWER',revision_plan:null,at:new Date().toISOString(),evidence_digest:evaluateTrial(updated).evidence_digest,followup_id:updated.followups[0].id}];assert.deepEqual(policyInput(poisoned),input);
 await assert.rejects(()=>lifecycleCommand(root,{command:'infer',id:e.id,revision:1}),/Select/);
 const report=await lifecycleCommand(root,{command:'evaluate',id:'tray-review',version:1,split:'test'}) as Evaluation;assert.equal(report.passed,1);assert.equal(report.total,1);assert.equal(report.results[0].mode,'synthetic');assert.equal(report.policy.type,'explicit_rules');
 await lifecycleCommand(root,{command:'select',evaluation_id:report.id,reviewer:'Operator',reason:'Software baseline only'});
 const run=await lifecycleCommand(root,{command:'infer',id:e.id,revision:1}) as any;assert.equal(run.mode,'replay');assert.equal(run.human_decision,'pending');assert.equal(run.performed_action,null);assert.equal(run.outcome,null);
 const state=withDb(root,db=>JSON.parse((db.prepare('SELECT body FROM docs WHERE key=?').get(`intervention-trial:${trial.id}`) as {body:string}).body));assert.deepEqual(state,updated);
});
test('round-trip archive preserves identities and evidence; replay works without canonical stores, live promotion does not',async t=>{
 const {root,trial,follow}=await fixture(t);const base=await captureEpisode(root,capture(trial)),next=await captureEpisode(root,capture(follow(trial),true));await dataset(root,[base,next]);await lifecycleCommand(root,{command:'evaluate',id:'tray-review',version:1,split:'test'});const bundle=await exported(root);
 assert.equal(bundle.manifest.media,'references_only');const reopened=join(root,'archive');await lifecycleCommand(reopened,{command:'import',bundle});await lifecycleCommand(reopened,{command:'import',bundle});assert.deepEqual(await exported(reopened),bundle);
 const replay=await lifecycleCommand(reopened,{command:'replay',bundle}) as any;assert.equal(replay.archive_only,true);assert.equal(replay.results[1].prediction.status,'improved');assert.equal(replay.results[0].prediction.status,'unknown');
 const view=await lifecycleCommand(reopened,{command:'view'}) as any;assert.ok(view.episodes.every((x:any)=>x.issues.length));await assert.rejects(()=>lifecycleCommand(reopened,{command:'select',evaluation_id:bundle.evaluations[0].id,reviewer:'X',reason:'No canonical evidence'}),/unavailable/);
 const invalid=structuredClone(bundle);invalid.episodes[0].review.reason='Tampered';assert.throws(()=>validateBundle(invalid),/checksum/);
 const conflict=structuredClone(bundle);conflict.episodes[0].review.reason='Different signed-off annotation';conflict.dataset.members[0].digest=lifecycleDigest(conflict.episodes[0]);conflict.evaluations=[];conflict.manifest.digest=lifecycleDigest({dataset:conflict.dataset,episodes:conflict.episodes,evaluations:[]});await assert.rejects(()=>lifecycleCommand(reopened,{command:'import',bundle:conflict}),/collision/);assert.deepEqual(await exported(reopened),bundle);
});
test('corrections append episodes, keep original predictions and invalidate datasets/evaluations without editing history',async t=>{
 const {root,trial,follow,visit}=await fixture(t);let updated=follow(trial);const old=await captureEpisode(root,capture(updated,true));await dataset(root,[old]);const report=await lifecycleCommand(root,{command:'evaluate',id:'tray-review',version:1,split:'test'}) as Evaluation;await lifecycleCommand(root,{command:'select',evaluation_id:report.id,reviewer:'X',reason:'Test'});
 updated=recordTrialVisit(root,{request_id:'fix-lifecycle',id:updated.id,revision:updated.revision,role:'followup',visit_id:updated.followups[0].id,visit:visit('after',30),reason:'Correct stopwatch transcription'});
 assert.ok((await episodeProblems(root,old)).some(x=>x.includes('corrected')));const next=await captureEpisode(root,{...capture(updated,true),expected_status:'worse',reason:'Corrected stopwatch'});assert.equal(next.id,old.id);assert.equal(next.revision,2);assert.equal(next.previous_digest,lifecycleDigest(old));assert.equal(next.trial.corrections.at(-1)!.before!.measurements[0].value,12);assert.equal(old.trial.followups[0].measurements[0].value,12);
 await assert.rejects(()=>lifecycleCommand(root,{command:'evaluate',id:'tray-review',version:1,split:'test'}),/corrected|superseded/);await assert.rejects(()=>lifecycleCommand(root,{command:'infer',id:next.id,revision:2}),/Selected evaluation stale/);
 const view=await lifecycleCommand(root,{command:'view'}) as any;assert.deepEqual(view.evaluations[0],report);
});
test('missing sources, invalid references, stale process and impossible success claims are rejected',async t=>{
 const {root,trial,doc}=await fixture(t);await assert.rejects(()=>captureEpisode(root,{...capture(trial),visit_id:'missing'}),/Visit not found/);await assert.rejects(()=>captureEpisode(root,{...capture(trial),workflow_id:'unknown-workflow'}),/Invalid workflow/);await assert.rejects(()=>captureEpisode(root,{...capture(trial),mode:'live'}),/Replay/);
 const e=await captureEpisode(root,capture(trial)),bad=structuredClone(e);bad.transition.subsequent_state={complete:true} as any;assert.throws(()=>validateEpisode(bad),/unknown/);
 await applyCorrection(root,doc.id,{title:'Corrected title'},'Operator corrected process');assert.ok((await episodeProblems(root,e)).some(x=>x.includes('Process')));
 withDb(root,db=>db.prepare('DELETE FROM sessions WHERE sid=?').run('before'));assert.ok((await episodeProblems(root,e)).some(x=>x.includes('Session evidence')));
});
test('media permissions are independent and a failing held-out target cannot promote a candidate',async t=>{
 const {root,trial}=await fixture(t);const e=await captureEpisode(root,{...capture(trial),expected_status:'improved',permissions:{metadata_export:false,media_export:true,training:false,authority:'Owner'}});await dataset(root,[e]);await assert.rejects(()=>exported(root),/not permitted/);
 const report=await lifecycleCommand(root,{command:'evaluate',id:'tray-review',version:1,split:'test'}) as Evaluation;assert.equal(report.passed,0);assert.equal(report.results[0].prediction.status,'unknown');assert.equal(report.results[0].prediction.completed,false);await assert.rejects(()=>lifecycleCommand(root,{command:'select',evaluation_id:report.id,reviewer:'X',reason:'Cannot promote'}),/passing/);await assert.rejects(()=>lifecycleCommand(root,{command:'evaluate',id:'tray-review',version:1,split:'development'}),/held-out/);
});
test('spatial revisions use the OI reader, stay immutable, and cannot silently rebind missing entities',async t=>{
 const {root,trial,doc}=await fixture(t),e=await captureEpisode(root,capture(trial));const association:any={schema:'spatial-evidence/1',id:'space-link',revision:1,source:{process_id:doc.id,process_revision:doc.rev},target:{kind:'oi',scene_id:'12345678-1234-1234-1234-123456789012',revision:1,entity_kind:'instance',entity_id:'bench'},review:'confirmed'};setDoc(root,'spatial-association:space-link',association);e.spatial=[association];
 const reader=(head=1,entity='present'):OiReferenceReader=>async()=>({scene_id:association.target.scene_id,revision:1,head_revision:head,entity_state:entity as any,head_entity_state:entity as any,mock:false,name:'Bench',changed:head!==1,scale:'unknown',scale_reason:'No scale claim',revision_url:'',head_url:'',entities:[]});
 assert.deepEqual(await episodeProblems(root,e,reader()),[]);assert.ok((await episodeProblems(root,e,reader(2))).some(x=>x.includes('OI reference')));assert.ok((await episodeProblems(root,e,reader(1,'missing'))).length);assert.equal((e.spatial[0].target as any).revision,1);
});
test('unknown adoption, estimated timing and unmatched conditions never become confirmed success',async t=>{
 const {root,trial,follow,visit}=await fixture(t);const v=visit('after',12);v.measurements[0].kind='estimated';let updated=follow(trial,v);let e=await captureEpisode(root,{...capture(updated,true),expected_status:'unknown'});assert.equal(inferPolicy(policyInput(e)).status,'unknown');
 v.measurements[0].kind='measured';v.context.intervention_applied=null as any;updated=recordTrialVisit(root,{request_id:'adoption',id:updated.id,revision:updated.revision,role:'followup',visit_id:updated.followups[0].id,visit:v,reason:'Use unknown'});e=await captureEpisode(root,{...capture(updated,true),expected_status:'inconclusive'});assert.equal(inferPolicy(policyInput(e)).status,'inconclusive');assert.equal(inferPolicy(policyInput(e)).completed,false);
});

test('forged evaluation counts/predictions cannot be imported even after rehashing the bundle',async t=>{
 const {root,trial}=await fixture(t),e=await captureEpisode(root,capture(trial));await dataset(root,[e]);await lifecycleCommand(root,{command:'evaluate',id:'tray-review',version:1,split:'test'});const bundle=await exported(root);bundle.evaluations[0].results[0].prediction.status='improved';bundle.manifest.digest=lifecycleDigest({dataset:bundle.dataset,episodes:bundle.episodes,evaluations:bundle.evaluations});assert.throws(()=>validateBundle(bundle),/does not reproduce/);
});
test('export never includes embedded media and distinguishes unknown recording time from observed visit time',async t=>{
 const {root,trial}=await fixture(t),e=await captureEpisode(root,capture(trial));assert.equal(e.sources[0].recorded_at,null);assert.equal(e.sources[0].observed_at,trial.baseline!.observed_at);await dataset(root,[e]);const bundle=await exported(root);bundle.episodes[0].review.reason='data:image/png;base64,ZmFrZQ==';assert.throws(()=>validateBundle(bundle),/embedded media/);
 const bad=structuredClone(e);bad.sources[0].session='different-session';assert.throws(()=>validateEpisode(bad),/identity\/timestamp/);
});
test('selection preserves the previous working record and stale markers do not rewrite scores',async t=>{
 const {root,trial,doc}=await fixture(t),e=await captureEpisode(root,capture(trial));await dataset(root,[e]);const r=await lifecycleCommand(root,{command:'evaluate',id:'tray-review',version:1,split:'test'}) as Evaluation;
 const first=await lifecycleCommand(root,{command:'select',evaluation_id:r.id,reviewer:'First',reason:'First review'}) as any;const next=await lifecycleCommand(root,{command:'select',evaluation_id:r.id,reviewer:'Second',reason:'Independent review'}) as any;assert.equal(next.previous_selection_id,first.id);
 await applyCorrection(root,doc.id,{title:'Corrected process'},'Changed process');const view=await lifecycleCommand(root,{command:'view'}) as any;assert.equal(view.evaluation_status[0].stale,true);assert.deepEqual(view.evaluations[0],r);assert.ok(view.selections.some((s:any)=>s.id===first.id));
});

test('retained source and frame checksums survive export; changed or missing bytes block reuse',async t=>{
 const {root,input,visit}=await fixture(t);const {writeFile}=await import('node:fs/promises');const {retainVisitEvidence}=await import('./visit-evidence.js');const {appendSession}=await import('./spot-state.js');const {registerTrial}=await import('./outcomes.js');
 const path=join(root,'synthetic.png');await writeFile(path,'invented source bytes');const retained=await retainVisitEvidence(root,path,['data:image/png;base64,ZmFrZQ==']);await appendSession(root,'bench',{same_location:true,visit_evidence:{after:retained}},'retained');const v=visit();v.reference.session_id='retained';const trial=registerTrial(root,{...input,request_id:'retained-trial',baseline:v});const e=await captureEpisode(root,capture(trial));assert.equal(e.sources[0].checksum,retained.source!.checksum);assert.equal(e.sources[0].assets.length,2);await dataset(root,[e]);const b=await exported(root);assert.deepEqual(b.episodes[0].sources,e.sources);assert.equal(JSON.stringify(b).includes('invented source bytes'),false);
 await rm(join(root,'media',retained.frames[0].media));assert.ok((await episodeProblems(root,e)).some(s=>s.includes('media missing')));await assert.rejects(()=>lifecycleCommand(root,{command:'evaluate',id:'tray-review',version:1,split:'test'}),/media missing/);
});
