/** Durable reconciliation scenarios: real SQLite transactions, no model/network dependency. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addGoal, listGoals } from './goals.js';
import { createTask, editTask, planningView, configurePlanning, proposePlan, decidePlan, changeBlock } from './task-planning.js';
import { withDb } from './db.js';
import { ingestEvidence, beginInterpretation, finishInterpretation, failInterpretation, associateEvidence, proposeChange, reviewChanges, rebaseChange, manualUpdate, reconciliationView, reconciliationPlan, type EvidenceSource } from './reconciliation.js';
import { reconcileVideo } from './reconciliation-video.js';

function project(t: { after(fn: () => void): void }): string { const root = mkdtempSync(join(tmpdir(), 'reconcile-')); t.after(() => rmSync(root, { recursive: true, force: true })); mkdirSync(join(root, 'media')); writeFileSync(join(root, 'media', 'clip.mp4'), 'synthetic video bytes; model runner is mocked'); return root; }
function task(root: string, id = 'trays') { return createTask(root, { text: id, active_minutes: 30, estimate_source: 'operator', completion_criteria: '50 trays filled and checked', quantity: { total: 50, remaining: 50, unit: 'trays' } }, id); }
function evidence(root: string, taskId: string, media = 'clip.mp4'): EvidenceSource {
  let s = ingestEvidence(root, { kind: 'video', media, recorded_at: '2026-01-01T09:00:00Z', context: { task_ids: [taskId], occurrence: 'morning batch' } });
  s = beginInterpretation(root, s.id, s.revision);
  s = finishInterpretation(root, s.id, s.processing!.token, { origin: 'replay', model: 'fixture', prompt_version: 'test/1', observations: [{ id: 'o1', text: 'Some trays are filled', start_s: 1, end_s: 1, confidence: 'medium', uncertainty: 'Only one frame; remaining quantity requires confirmation', coverage: 'sampled' }] });
  return associateEvidence(root, s.id, s.revision, taskId, 'confirmed', 'Operator identifies this batch');
}
function progress(root: string, s: EvidenceSource, taskId: string, remaining = 30): EvidenceSource { return proposeChange(root, s.id, s.revision, { task_id: taskId, observation_id: 'o1', kind: 'progress', patch: { execution: 'paused' }, quantity_mode: 'remaining', quantity_value: remaining, unit: 'trays', reason: 'Count remaining trays', uncertainty: 'Review the count' }); }
function accept(root: string, s: EvidenceSource, key = 'accept') { return reviewChanges(root, s.id, s.revision, key, [{ change_id: s.changes.at(-1)!.id, decision: 'accepted', reason: 'Confirmed current count against all trays', current_confirmed: true }]); }

test('review changes existing canonical task once; retains evidence, history, original estimate and goal outcome', async t => {
  const root = project(t), goal = await addGoal(root, { text: 'Prepare trays' }); let target = task(root);
  target = editTask(root, target.id, target.revision, { links: [{ goal_id: goal.id, explanation: 'Produces trays', origin: 'human', review: 'confirmed' }] }, 'Link goal');
  let s = progress(root, evidence(root, target.id), target.id); const rev = s.revision;
  assert.equal(planningView(root).tasks[0].quantity!.remaining, 50);
  const decisions = [{ change_id: s.changes[0].id, decision: 'accepted', reason: 'Count verified now', current_confirmed: true }];
  s = reviewChanges(root, s.id, rev, 'one', decisions); reviewChanges(root, s.id, rev, 'one', decisions);
  const view = planningView(root); assert.equal(view.tasks.length, 1); assert.equal(view.tasks[0].quantity!.remaining, 30); assert.equal(view.tasks[0].original_minutes, 30); assert.equal(view.tasks[0].revision, target.revision + 1);
  assert.equal((await listGoals(root))[0].status, 'open'); assert.equal(s.changes[0].before.quantity && (s.changes[0].before.quantity as any).remaining, 50);
  assert.throws(()=>reviewChanges(root, s.id, rev, 'one', [{ ...decisions[0], reason: 'Changed payload' }]), /reused/);
});
test('exact repeated upload and interpretation revision cannot resurrect a rejected suggestion', t => {
  const root=project(t), target=task(root); let s=progress(root,evidence(root,target.id),target.id);
  s=reviewChanges(root,s.id,s.revision,'reject',[{change_id:s.changes[0].id,decision:'rejected',reason:'Wrong count'}]);
  writeFileSync(join(root,'media','copy.mp4'),'synthetic video bytes; model runner is mocked');
  assert.equal(ingestEvidence(root,{kind:'video',media:'copy.mp4'}).id,s.id);
  s=beginInterpretation(root,s.id,s.revision);s=finishInterpretation(root,s.id,s.processing!.token,{origin:'replay',model:'another-model',prompt_version:'test/2',observations:[{id:'o1',text:'Another interpretation of the same frame',start_s:1,end_s:1,confidence:'high',uncertainty:'Same source',coverage:'sampled'}]});
  s=progress(root,s,target.id);assert.equal(s.changes.length,1);assert.equal(s.changes[0].status,'rejected');assert.equal(s.interpretations.length,2);assert.equal(planningView(root).tasks.length,1);
});
test('late/unknown-time footage stays historical unless operator explicitly confirms current state', t => {
  const root=project(t), target=task(root),s=progress(root,evidence(root,target.id),target.id);
  assert.throws(()=>reviewChanges(root,s.id,s.revision,'late',[{change_id:s.changes[0].id,decision:'accepted',reason:'Old clip'}]),/Historical/);
  assert.equal(planningView(root).tasks[0].revision,target.revision);
  assert.ok(reconciliationView(root).sources[0].review[0].warnings.some(w=>w.includes('historical')));
});
test('stale analysis cannot overwrite manual edits; explicit rebase preserves original proposal', t => {
  const root=project(t),target=task(root);let s=progress(root,evidence(root,target.id),target.id);
  manualUpdate(root,{request_id:'manual',task_id:target.id,task_revision:target.revision,report:'Counted 40 remaining',patch:{quantity:{total:50,remaining:40,unit:'trays'}}});
  assert.throws(()=>accept(root,s),/Stale/);
  s=rebaseChange(root,s.id,s.revision,s.changes[0].id,'Review against new count');assert.equal(s.changes[0].status,'rejected');assert.equal((s.changes[1].before.quantity as any).remaining,40);
  s=reviewChanges(root,s.id,s.revision,'rebase-accept',[{change_id:s.changes[1].id,decision:'corrected',reason:'New total verified',correction:{quantity:{total:50,remaining:35,unit:'trays'}},current_confirmed:true,overlap:'same',overlap_reason:'Same batch, total replaces prior count'}]);
  assert.equal(planningView(root).tasks[0].quantity!.remaining,35);
});
test('partial independent decisions persist; rejected identity blocks dependent update', t=>{
  const root=project(t),a=task(root,'a'),b=task(root,'b');let s=evidence(root,a.id);
  s=associateEvidence(root,s.id,s.revision,b.id,'rejected','Not this batch');s=progress(root,s,a.id);s=progress(root,s,b.id);
  assert.throws(()=>reviewChanges(root,s.id,s.revision,'bad',[{change_id:s.changes[1].id,decision:'accepted',reason:'Bad association',current_confirmed:true}]),/Confirm task occurrence/);
  s=reviewChanges(root,s.id,s.revision,'partial',[{change_id:s.changes[0].id,decision:'accepted',reason:'Verified count for a',current_confirmed:true},{change_id:s.changes[1].id,decision:'deferred',reason:'Identify b first'}]);
  assert.equal(s.stage,'needs_review');assert.equal(planningView(root).tasks.find(t=>t.id===a.id)!.quantity!.remaining,30);assert.equal(planningView(root).tasks.find(t=>t.id===b.id)!.quantity!.remaining,50);
});
test('coherent completion clears all remaining work and demands explicit success confirmation', t=>{
  const root=project(t),target=task(root);let s=evidence(root,target.id);
  s=proposeChange(root,s.id,s.revision,{task_id:target.id,observation_id:'o1',kind:'completion',patch:{execution:'done'},reason:'Person verified completion criteria'});
  assert.equal((s.changes[0].patch.quantity as any).remaining,0);assert.equal(s.changes[0].patch.remaining_minutes,0);
  assert.throws(()=>reviewChanges(root,s.id,s.revision,'bad',[{change_id:s.changes[0].id,decision:'accepted',reason:'Clip ended'}]),/Historical|confirm/);
  accept(root,s);assert.equal(planningView(root).tasks[0].execution,'done');assert.equal(planningView(root).tasks[0].quantity!.remaining,0);
});
test('overlapping interpretation cannot add quantity twice; separate clips require explicit overlap resolution', t=>{
  const root=project(t),target=task(root);let s=evidence(root,target.id);
  s=proposeChange(root,s.id,s.revision,{task_id:target.id,observation_id:'o1',kind:'progress',patch:{},quantity_mode:'incremental',quantity_value:10,unit:'trays',reason:'Ten reported trays'});s=accept(root,s);
  s=proposeChange(root,s.id,s.revision,{task_id:target.id,observation_id:'o1',kind:'progress',patch:{},quantity_mode:'incremental',quantity_value:5,unit:'trays',reason:'Different inference'});
  s=rebaseChange(root,s.id,s.revision,s.changes.at(-1)!.id,'Check revised inference');assert.throws(()=>accept(root,s,'second'),/interval already applied/);
  writeFileSync(join(root,'media','reencoded.mp4'),'different bytes possibly same footage');let other=progress(root,evidence(root,target.id,'reencoded.mp4'),target.id,25);
  assert.throws(()=>accept(root,other,'other'),/overlap/);
  other=reviewChanges(root,other.id,other.revision,'total',[{change_id:other.changes[0].id,decision:'accepted',reason:'Current remaining total counted',current_confirmed:true,overlap:'same',overlap_reason:'Same batch; remaining is a total not an increment'}]);
  assert.equal(planningView(root).tasks[0].quantity!.remaining,25);
});
test('invalid units/quantities and inconsistent edits roll back the entire selected subset',t=>{
  const root=project(t),a=task(root,'a'),b=task(root,'b');let s=evidence(root,a.id);s=associateEvidence(root,s.id,s.revision,b.id,'confirmed','Both tasks visible');
  assert.throws(()=>proposeChange(root,s.id,s.revision,{task_id:a.id,observation_id:'o1',kind:'progress',patch:{},quantity_mode:'remaining',quantity_value:5,unit:'cells',reason:'Wrong unit'}),/unit/);
  s=progress(root,s,a.id);s=progress(root,s,b.id);
  assert.throws(()=>reviewChanges(root,s.id,s.revision,'atomic',[{change_id:s.changes[0].id,decision:'accepted',reason:'Valid',current_confirmed:true},{change_id:s.changes[1].id,decision:'corrected',reason:'Invalid',current_confirmed:true,correction:{execution:'invalid'}}]),/execution/);
  assert.equal(planningView(root).tasks.find(t=>t.id===a.id)!.quantity!.remaining,50);assert.ok(reconciliationView(root).sources[0].changes.every(c=>c.status==='proposed'));
});
test('failed persistence rolls back both task mutation and review decision',t=>{
  const root=project(t),target=task(root),s=progress(root,evidence(root,target.id),target.id);
  withDb(root,db=>db.exec("CREATE TRIGGER interrupt_review BEFORE UPDATE ON docs WHEN NEW.key LIKE 'evidence-source:%' BEGIN SELECT RAISE(ABORT, 'simulated interrupted apply'); END"));
  assert.throws(()=>accept(root,s),/interrupted apply/);assert.equal(planningView(root).tasks[0].quantity!.remaining,50);
  withDb(root,db=>db.exec('DROP TRIGGER interrupt_review'));accept(root,s);assert.equal(planningView(root).tasks[0].quantity!.remaining,30);
});
test('manual report is atomic/idempotent, no redundant review, no fabricated actual duration',t=>{
  const root=project(t),target=task(root),command={request_id:'m1',task_id:target.id,task_revision:target.revision,report:'I paused with 25 trays remaining',patch:{execution:'paused',quantity:{total:50,remaining:25,unit:'trays'}}};
  const s=manualUpdate(root,command);assert.equal(manualUpdate(root,command).id,s.id);assert.equal(s.stage,'applied');assert.equal(planningView(root).tasks[0].actuals.length,0);
  assert.throws(()=>manualUpdate(root,{...command,report:'Different'}),/reused/);
});
test('accepted/pinned schedule unchanged; blocker propagates through dependencies; unrelated evidence leaves plan fresh',t=>{
  const root=project(t),a=task(root,'a'),b=task(root,'b');editTask(root,b.id,b.revision,{dependencies:[a.id]},'Depends on a');
  configurePlanning(root,1,{timezone:'UTC',person:'operator',max_minutes:180,availability:[{start:'2030-01-10T09:00:00Z',end:'2030-01-10T12:00:00Z'}],resources:{}});
  const plan=proposePlan(root,'2030-01-10','2030-01-10T08:00:00Z');decidePlan(root,plan.id,'accepted','Fixture','2030-01-10T08:00:00Z');
  let view=planningView(root);changeBlock(root,view.schedule.blocks[0].id,view.schedule.revision,'pin','Keep commitment');
  proposePlan(root,'2030-01-10','2030-01-10T08:00:00Z');view=planningView(root);const blocks=structuredClone(view.schedule.blocks);
  const s=evidence(root,a.id);assert.equal(planningView(root).latest_plan!.stale,false);
  manualUpdate(root,{request_id:'blocked',task_id:a.id,task_revision:a.revision,report:'Tool unavailable now',patch:{execution:'blocked'}});
  assert.deepEqual(planningView(root).schedule.blocks,blocks);assert.equal(planningView(root).latest_plan!.stale,true);
  const effects=reconciliationPlan(root,'2030-01-10','2030-01-10T08:00:00Z') as any;assert.ok(effects.plan.conflicts.length);assert.ok(effects.plan.deferred.some((d:any)=>d.task_id===b.id));
  const review=reconciliationView(root).sources.find(s=>s.kind==='manual')!.review[0];assert.ok(review.affected_tasks.includes(b.id));assert.equal(review.block_ids.length,2);
});
test('processing retries retain clip and reject late completion from interrupted worker',t=>{
  const root=project(t),target=task(root);let s=ingestEvidence(root,{kind:'video',media:'clip.mp4',context:{task_ids:[target.id]}});s=beginInterpretation(root,s.id,s.revision);const oldToken=s.processing!.token;
  assert.throws(()=>beginInterpretation(root,s.id,s.revision),/already active/);s=beginInterpretation(root,s.id,s.revision,true);
  assert.throws(()=>finishInterpretation(root,s.id,oldToken,{}),/Stale processing/);s=failInterpretation(root,s.id,s.processing!.token,'Fixture provider failed');assert.equal(s.stage,'failed_retryable');assert.equal(s.media,'clip.mp4');
});
test('real video adapter with injected model stores observations and proposal but no new tasks; duplicate skips runner',async t=>{
  const root=project(t),target=task(root);let calls=0;
  const runner=async (_file:string,args:string[])=>{calls++;assert.ok(args.includes('--task-context'));return {model:'fixture-model',prompt_version:'fixture/1',per_frame:['Thirty trays remain'],frame_times_s:[2],confidence:'medium',unknowns:['Hidden trays'],work_update:{frame_index:0,remaining_quantity:30,unit:'trays',evidence:'Count visible trays'},video_duration_s:10};};
  let s=await reconcileVideo(root,{media:'clip.mp4',task_id:target.id},runner);assert.equal(s.stage,'needs_review');assert.equal(s.changes.length,1);assert.equal(s.associations.length,0);assert.equal(planningView(root).tasks[0].quantity!.remaining,50);
  s=await reconcileVideo(root,{media:'clip.mp4',task_id:target.id},runner);assert.equal(calls,1);assert.equal(planningView(root).tasks.length,1);
});
test('unrelated/insufficient footage retains unknowns and asks for association without inventing completion',async t=>{
  const root=project(t);task(root);const s=await reconcileVideo(root,{media:'clip.mp4'},async()=>({per_frame:[],observed_task:'Sky',unknowns:['No work visible']}));assert.equal(s.changes.length,0);assert.match(reconciliationView(root).sources[0].next_action,/Choose/);assert.equal(planningView(root).tasks[0].execution,'open');
});
test('malformed observations fail transactionally; unsupported fields cannot mutate task identity or spatial state',t=>{
  const root=project(t),target=task(root);let s=evidence(root,target.id);assert.throws(()=>proposeChange(root,s.id,s.revision,{task_id:target.id,observation_id:'missing',kind:'progress',patch:{execution:'done'},reason:'No source'}),/observation/);
  assert.throws(()=>proposeChange(root,s.id,s.revision,{task_id:target.id,observation_id:'o1',kind:'progress',patch:{id:'replacement'},reason:'No identity replacement'}),/Unsupported/);
  s=beginInterpretation(root,s.id,s.revision);assert.throws(()=>finishInterpretation(root,s.id,s.processing!.token,{origin:'model',model:'m',prompt_version:'p',observations:[{id:'bad',text:'bad',start_s:4,end_s:2,coverage:'sampled',confidence:'low',uncertainty:''}]}),/interval/);
});

test('no-change disposition preserves unrelated evidence and recording metadata',async t=>{
  const {retainEvidence}=await import('./reconciliation.js');const root=project(t);
  let s=await reconcileVideo(root,{media:'clip.mp4'},async()=>({per_frame:['Sky'],frame_times_s:[1],video_duration_s:10,recorded_at:'2026-01-01T08:00:00Z',recorded_source:'container',video_metadata:{width:1920,height:1080}}));
  assert.equal(s.duration_s,10);assert.equal(s.recorded_at,'2026-01-01T08:00:00.000Z');assert.equal(s.metadata!.video && (s.metadata!.video as any).width,1920);
  s=retainEvidence(root,s.id,s.revision,'No work visible');assert.equal(s.stage,'no_material_change');assert.match(reconciliationView(root).sources[0].next_action,/No operational/);
});
test('reviewed process revision uses canonical process store; stale inputs rejected and old revisions preserved',async t=>{
  const {proposeRelated,reviewRelated}=await import('./reconciliation.js');
  const {buildProcessFromScan,saveRevision,readProcess,applyCorrection}=await import('./processes.js');
  const {setDoc,getDoc}=await import('./db.js');const root=project(t);
  const proc=buildProcessFromScan({id:'trays',analysis:{observed_task:'Fill trays',per_frame:['Fill tray'],frame_times_s:[1],video_duration_s:10},media:'clip.mp4'});await saveRevision(root,proc);
  let target=task(root);target=editTask(root,target.id,target.revision,{process:{id:proc.id,revision:1,step_id:proc.steps[0].id}},'Link process');
  let s=evidence(root,target.id);const proposed=structuredClone(proc);proposed.rev=2;proposed.steps[0].label='Fill at the potting bench';
  s=proposeRelated(root,s.id,s.revision,{kind:'process_revision',task_id:target.id,process_id:proc.id,base_revision:1,observation_id:'o1',proposal:proposed,reason:'Follow-up clarifies location'});
  setDoc(root,'plan',{process_basis:[{process_id:proc.id,rev:1}],stale:false});
  s=reviewRelated(root,s.id,s.revision,{change_id:s.related![0].id,decision:'accepted',reason:'Current process confirmed',current_confirmed:true});
  assert.equal((await readProcess(root,proc.id)).rev,2);assert.equal((await readProcess(root,proc.id,1)).steps[0].label,proc.steps[0].label);assert.equal((getDoc(root,'plan') as any).stale,true);assert.equal(planningView(root).tasks[0].process!.revision,1);
  const proposed3=structuredClone(await readProcess(root,proc.id));proposed3.rev=3;proposed3.title='Another proposal';
  s=proposeRelated(root,s.id,s.revision,{kind:'process_revision',task_id:target.id,process_id:proc.id,base_revision:2,observation_id:'o1',proposal:proposed3,reason:'Pending correction'});
  await applyCorrection(root,proc.id,{title:'Concurrent human correction'},'Operator edit');
  assert.throws(()=>reviewRelated(root,s.id,s.revision,{change_id:s.related![1].id,decision:'accepted',reason:'Stale',current_confirmed:true}),/Stale process/);
});
test('friction remains a reviewable finding; spatial handoff never reports an external mutation as applied',async t=>{
  const {proposeRelated,reviewRelated}=await import('./reconciliation.js');const root=project(t),target=task(root);let s=evidence(root,target.id);
  for(const kind of ['friction','spatial']){s=proposeRelated(root,s.id,s.revision,{kind,task_id:target.id,observation_id:'o1',proposal:{summary:kind==='friction'?'Repeated trips visible; duration unknown':'Possible obstruction; needs OI scene check'},reason:'Source-backed finding'});s=reviewRelated(root,s.id,s.revision,{change_id:s.related!.at(-1)!.id,decision:'accepted',reason:'Retain for follow-up'});}
  assert.equal(s.related![0].status,'recorded');assert.equal(s.related![1].status,'pending_external');assert.match(reconciliationView(root).sources[0].next_action,/no external mutation/);assert.equal(planningView(root).tasks[0].revision,target.revision);
});

test('completion rejects contradictory remaining quantities; legacy task completion does not invent duration',t=>{
  const root=project(t),target=task(root);const s=evidence(root,target.id);
  assert.throws(()=>proposeChange(root,s.id,s.revision,{task_id:target.id,observation_id:'o1',kind:'completion',patch:{execution:'done'},quantity_mode:'remaining',quantity_value:10,unit:'trays',reason:'Contradictory claim'}),/Completion conflicts/);
  const legacy=createTask(root,{text:'Legacy action',completion_criteria:'Operator checks output'},'legacy');
  manualUpdate(root,{request_id:'legacy-done',task_id:legacy.id,task_revision:legacy.revision,report:'Output checked',patch:{execution:'done'}});
  const current=planningView(root).tasks.find(t=>t.id===legacy.id)!;assert.equal(current.execution,'done');assert.equal(current.remaining_minutes,0);assert.equal(current.active_minutes,null);assert.equal(current.actuals.length,0);
});
