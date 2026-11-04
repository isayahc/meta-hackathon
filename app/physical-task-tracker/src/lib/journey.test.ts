/** Cross-feature journey contracts use the real SQLite store, never an alternate task model. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureJourney, journeyCommand, journeyView, type Journey } from './journey.js';
import { planningView, configurePlanning, proposePlan, decidePlan, recordWork, saveCommitment, editTask } from './task-planning.js';
import { associateEvidence, reviewChanges, reconciliationView, type EvidenceSource } from './reconciliation.js';
import { applyCorrection, readProcess } from './processes.js';
import { withDb } from './db.js';
const raw = { observed_task:'Prepare trays', per_frame:['Fill tray using a shovel','Carry filled tray'], frame_times_s:[1,5], video_duration_s:10, confidence:'medium', unknowns:['Unseen work and desired quantity unknown'], suggested_next_steps:['Seed trays'], model:'synthetic test',prompt_version:'journey-test/1' };
function project(t: {after(fn:()=>void):void}): string { const root=mkdtempSync(join(tmpdir(),'journey-'));mkdirSync(join(root,'media'));writeFileSync(join(root,'media','synthetic.mp4'),'Synthetic byte fixture; not playable footage');t.after(()=>rmSync(root,{recursive:true,force:true}));return root; }
function send(root:string,j:Journey,command:Record<string,unknown>,request=crypto.randomUUID()):Journey { return journeyCommand(root,{id:j.id,revision:j.revision,request_id:request,reason:'Synthetic operator decision',...command}) as Journey; }
async function captured(root:string):Promise<Journey>{return captureJourney(root,{media:'synthetic.mp4'},async()=>raw);}
function review(root:string,j:Journey):Journey {const c=journeyView(root).workflows.find(w=>w.workflow.id===j.id)!.clips[0];return send(root,j,{command:'review',source_id:c.source_id,process_revision:c.process!.rev});}
function goal(root:string,j:Journey):Journey{return send(root,j,{command:'goal',goal:{text:'Prepare 50 trays',success_criteria:'50 trays pass inspection',weight:3},desired_improvement:'Reduce carrying'});}
function retain(root:string,j:Journey):Journey{return send(root,j,{command:'method',decision:'retain'});}
function task(root:string,j:Journey):Journey {const c=journeyView(root).workflows.find(w=>w.workflow.id===j.id)!.clips[0];return send(root,j,{command:'task',future_confirmed:true,task:{text:'Fill 50 trays',completion_criteria:'50 filled trays inspected',active_minutes:60,estimate_source:'Synthetic operator estimate',quantity:{total:50,remaining:50,unit:'trays'},process:{id:c.process!.id,revision:c.process!.rev,step_id:c.process!.steps[0].id},links:[{goal_id:j.goal_ids[0],origin:'human',review:'confirmed',explanation:'Produces the intended trays'}]}});}

test('complete loop: capture → correction → goal → retained practice → plan → partial work → follow-up → replan',async t=>{
 const root=project(t);let j=await captured(root),view=journeyView(root);assert.equal(view.planning.tasks.length,0);assert.equal(view.planning.goals.length,0);assert.equal(view.workflows[0].stage,'review');
 const clip=view.workflows[0].clips[0],original=clip.process!;
 j=send(root,j,{command:'correct',source_id:clip.source_id,process_revision:1,patch:{steps:{[original.steps[0].id]:{label:'Fill tray with the existing scoop'}}}});
 assert.equal((await readProcess(root,original.id,1)).steps[0].label,'Fill tray using a shovel');assert.equal((await readProcess(root,original.id)).steps[0].label,'Fill tray with the existing scoop');
 j=review(root,j);j=goal(root,j);j=retain(root,j);j=task(root,j);let state=planningView(root),work=state.tasks[0];
 assert.equal(work.dependencies.length,0);assert.equal(work.execution,'open');assert.equal(work.links[0].review,'confirmed');assert.equal(j.task_ids[0],work.id);
 configurePlanning(root,state.schedule.revision,{timezone:'UTC',person:'operator',resources:{},max_minutes:180,availability:[{start:'2030-01-10T09:00:00Z',end:'2030-01-10T12:00:00Z'}]});
 saveCommitment(root,{id:'break',title:'Fixed break',start:'2030-01-10T10:00:00Z',end:'2030-01-10T10:15:00Z',blocking:true,resources:[]});
 const plan=proposePlan(root,'2030-01-10','2030-01-10T08:00:00Z');assert.equal(plan.blocks.length,1);decidePlan(root,plan.id,'accepted','Synthetic operator accepts','2030-01-10T08:00:00Z');
 const today=journeyView(root,'2030-01-10T09:00:00Z').today;assert.equal(today.task!.id,work.id);assert.equal(today.accepted,true);assert.equal(today.goals[0].id,j.goal_ids[0]);
 work=recordWork(root,work.id,work.revision,{id:'partial',start:'2026-01-01T09:00:00Z',end:'2026-01-01T09:20:00Z',quantity:20,remaining_minutes:40,done:false,outcome:'Synthetic interruption after 20 trays'});
 assert.equal(work.execution,'paused');assert.equal(work.quantity!.remaining,30);
 writeFileSync(join(root,'media','followup.mp4'),'Second distinct synthetic byte fixture');
 j=await captureJourney(root,{media:'followup.mp4',workflow_id:j.id,revision:j.revision,role:'followup',task_id:work.id},async()=>({...raw,work_update:{frame_index:0,remaining_quantity:30,unit:'trays',evidence:'Synthetic count claim requires review'}}));
 let follow: EvidenceSource=reconciliationView(root).sources.find(s=>s.context.task_ids.includes(work.id))!;
 assert.equal(journeyView(root).workflows[0].stage,'followup');assert.equal(planningView(root).tasks.length,1);
 follow=associateEvidence(root,follow.id,follow.revision,work.id,'confirmed','Same synthetic batch');
 follow=reviewChanges(root,follow.id,follow.revision,'review-followup',[{change_id:follow.changes[0].id,decision:'corrected',correction:{quantity:{total:50,remaining:28,unit:'trays'}},reason:'Synthetic person verifies 28 remain',current_confirmed:true}]);
 work=planningView(root).tasks[0];assert.equal(work.quantity!.remaining,28);assert.equal(work.actuals.length,1);
 editTask(root,work.id,work.revision,{execution:'open',remaining_minutes:35},'Resume after interruption');
 const replan=proposePlan(root,'2030-01-10','2030-01-10T08:00:00Z');assert.equal(replan.blocks.length,1);assert.equal(replan.blocks[0].active_minutes,35);assert.equal(replan.input_snapshot.events[0].title,'Fixed break');decidePlan(root,replan.id,'accepted','Accept changed remaining work','2030-01-10T08:00:00Z');
 view=journeyView(root,'2030-01-10T09:00:00Z');assert.equal(view.workflows.length,1);assert.equal(view.workflows[0].workflow.id,j.id);assert.equal(view.workflows[0].clips.length,2);assert.equal(view.planning.tasks[0].id,work.id);assert.equal(view.planning.goals[0].status,'open');assert.match(view.workflows[0].outcome_status!,/Unknown/);assert.equal(view.workflows[0].pending_reviews,0);
});

test('capture retains failures and retries without creating goals/tasks or duplicate workflows',async t=>{
 const root=project(t);let calls=0;
 const j=await captureJourney(root,{media:'synthetic.mp4'},async()=>{calls++;throw Error('Synthetic model unavailable');});
 let v=journeyView(root);assert.equal(v.workflows[0].clips[0].source.stage,'failed_retryable');assert.equal(v.workflows[0].clips[0].source.media,'synthetic.mp4');
 const source=v.workflows[0].clips[0].source;
 await captureJourney(root,{source_id:source.id,workflow_id:j.id,retry:true,source_revision:source.revision},async()=>{calls++;return raw;});
 await captureJourney(root,{media:'synthetic.mp4'},async()=>{calls++;throw Error('must not rerun');});
 v=journeyView(root);assert.equal(calls,2);assert.equal(v.workflows.length,1);assert.equal(v.workflows[0].clips.length,1);assert.equal(v.planning.tasks.length,0);assert.equal(v.planning.goals.length,0);assert.ok(v.workflows[0].clips[0].process);
});

test('transaction receipts make goal and task submission safe after lost responses; reject changed payload and stale edits',async t=>{
 const root=project(t);let j=review(root,await captured(root));
 const input={command:'goal',id:j.id,revision:j.revision,request_id:'goal',reason:'Confirm intent',desired_improvement:'None',goal:{text:'Prepare trays',success_criteria:'Inspected trays',weight:3}};
 j=journeyCommand(root,input) as Journey;journeyCommand(root,input);assert.equal(planningView(root).goals.length,1);
 assert.throws(()=>journeyCommand(root,{...input,desired_improvement:'Other'}),/reused/);assert.throws(()=>send(root,{...j,revision:1},{command:'rename',title:'stale'}),/Stale/);
 j=retain(root,j);const create={command:'task',id:j.id,revision:j.revision,request_id:'future',reason:'Actual future work',future_confirmed:true,task:{text:'Fill trays',completion_criteria:'Filled',links:[]}};
 j=journeyCommand(root,create) as Journey;journeyCommand(root,create);assert.equal(planningView(root).tasks.length,1);assert.equal(j.task_ids.length,1);
 assert.throws(()=>send(root,j,{command:'task',future_confirmed:false,task:{text:'Observed action',completion_criteria:'Done',links:[]}}),/future work/);
});

test('failed enclosing workflow save rolls back canonical goal and task changes',async t=>{
 const root=project(t);let j=review(root,await captured(root));
 withDb(root,db=>db.exec("CREATE TRIGGER reject_journey BEFORE UPDATE ON docs WHEN NEW.key LIKE 'journey:%' BEGIN SELECT RAISE(ABORT,'synthetic workflow write failure'); END"));
 assert.throws(()=>goal(root,j),/synthetic workflow/);assert.equal(planningView(root).goals.length,0);
 withDb(root,db=>db.exec('DROP TRIGGER reject_journey'));j=retain(root,goal(root,j));
 withDb(root,db=>db.exec("CREATE TRIGGER reject_journey BEFORE UPDATE ON docs WHEN NEW.key LIKE 'journey:%' BEGIN SELECT RAISE(ABORT,'synthetic workflow write failure'); END"));
 assert.throws(()=>task(root,j),/synthetic workflow/);assert.equal(planningView(root).tasks.length,0);
});

test('external process corrections invalidate review and method while keeping canonical task and previous revisions',async t=>{
 const root=project(t);let j=task(root,retain(root,goal(root,review(root,await captured(root)))));
 const p=journeyView(root).workflows[0].clips[0].process!;
 await applyCorrection(root,p.id,{steps:{[p.steps[0].id]:{label:'Corrected by another client'}}},'New evidence');
 const v=journeyView(root);assert.equal(v.workflows[0].stage,'review');assert.equal(v.workflows[0].method_current,false);assert.equal(v.planning.tasks.length,1);assert.equal(v.planning.tasks[0].process!.revision,1);
 assert.throws(()=>task(root,j),/Review work/);j=review(root,j);assert.equal(journeyView(root).workflows[0].stage,'improvements');j=retain(root,j);assert.equal(j.task_ids.length,1);
});

test('additional clips remain separate source reviews and reruns preserve corrected historical process',async t=>{
 const root=project(t);let j=review(root,await captured(root));const old=journeyView(root).workflows[0].clips[0];
 writeFileSync(join(root,'media','more.mp4'),'Additional synthetic footage');
 j=await captureJourney(root,{media:'more.mp4',workflow_id:j.id,revision:j.revision,role:'additional'},async()=>({...raw,observed_task:'Carry trays'}));
 assert.equal(journeyView(root).workflows[0].stage,'review');assert.equal(j.clips.length,2);assert.equal(planningView(root).tasks.length,0);
 j=await captureJourney(root,{source_id:old.source_id,workflow_id:j.id,retry:true,source_revision:old.source.revision},async()=>({...raw,per_frame:['Changed model claim']}));
 const fresh=journeyView(root).workflows[0].clips[0];assert.notEqual(fresh.process!.id,old.process!.id);assert.equal(fresh.reviewed_revision,null);assert.equal((await readProcess(root,old.process!.id)).steps[0].label,'Fill tray using a shovel');
});

test('goal-first/manual work remains accessible; unavailable estimates stay explicit',async t=>{
 const root=project(t);let j=review(root,await captured(root));j=send(root,j,{command:'unassigned',desired_improvement:'Unknown for now'});j=retain(root,j);
 j=send(root,j,{command:'task',future_confirmed:true,task:{text:'Inspect trays',completion_criteria:'Inspection recorded',links:[]}});
 const v=journeyView(root);assert.equal(v.planning.goals.length,0);assert.equal(v.workflows[0].stage,'schedule');assert.ok(v.today.deferred.some(d=>/remaining active minutes/.test(d.reason)));
});

test('accepted intervention links to the workflow; withdrawn approval and rejected trial return Today to review',async t=>{
 const root=project(t);let j=await captureJourney(root,{media:'synthetic.mp4'},async()=>({...raw,per_frame:['Fetch scoop','Fill tray','Fetch scoop again'],frame_times_s:[1,3,5]}),'replay');
 const p=journeyView(root).workflows[0].clips[0].process!;
 j=send(root,j,{command:'correct',source_id:j.clips[0].source_id,process_revision:p.rev,patch:{steps:Object.fromEntries(p.steps.map(s=>[s.id,{requires_unknown:false}]))}});j=goal(root,review(root,j));
 const {readFileSync}=await import('node:fs');const {saveImprovementReview,decideImprovement}=await import('./improvements.js');const {registerTrial,decideTrial,evaluateTrial}=await import('./outcomes.js');
 const fixture=JSON.parse(readFileSync(new URL('../samples/workflow-improvements.json',import.meta.url),'utf8').replaceAll('"trays"',JSON.stringify(p.id)).replaceAll('trays-o',p.id+'-o').replaceAll('trays-g',p.id+'-g'));
 let r=await saveImprovementReview(root,[await readProcess(root,p.id)],[],fixture.context,fixture.candidates,'replay');r=decideImprovement(root,r.id,fixture.candidates[0].id,'accepted','Synthetic approval');
 j=send(root,j,{command:'method',decision:'intervention',review_id:r.id,candidate_id:fixture.candidates[0].id});j=task(root,j);assert.equal(journeyView(root).workflows[0].method_current,true);
 decideImprovement(root,r.id,fixture.candidates[0].id,'rejected','Withdraw consent');assert.equal(journeyView(root).workflows[0].method_current,false);assert.throws(()=>task(root,j),/withdrawn/);
 decideImprovement(root,r.id,fixture.candidates[0].id,'accepted','Approve a trial');
 const trial=registerTrial(root,{request_id:'trial',review_id:r.id,candidate_id:fixture.candidates[0].id,workload_unit:'tray',metrics:[{id:'time',label:'Active time',unit:'min',direction:'lower',tolerance:0.01}],baseline:null});const result=evaluateTrial(trial);
 decideTrial(root,{request_id:'reject',id:trial.id,revision:trial.revision,evidence_digest:result.evidence_digest,decision:'reject',reason:'Operator rejects the method before adopting it'});
 const view=journeyView(root);assert.equal(view.workflows[0].stage,'improvements');assert.equal(view.workflows[0].method_current,false);assert.equal(view.planning.tasks[0].execution,'open');assert.equal(view.planning.goals[0].status,'open');
 const regenerated=await saveImprovementReview(root,[await readProcess(root,p.id)],[],fixture.context,fixture.candidates,'replay');decideImprovement(root,regenerated.id,fixture.candidates[0].id,'accepted','Same method in a new review');
 j=send(root,j,{command:'method',decision:'intervention',review_id:regenerated.id,candidate_id:fixture.candidates[0].id});assert.equal(journeyView(root).workflows[0].method_current,false);
});

test('explicit source reanalysis invalidates prior plans and requires relinking old task process references',async t=>{
 const root=project(t);let j=task(root,retain(root,goal(root,review(root,await captured(root)))));
 configurePlanning(root,1,{timezone:'UTC',person:'operator',resources:{},max_minutes:180,availability:[{start:'2030-01-10T09:00:00Z',end:'2030-01-10T12:00:00Z'}]});
 const initial=proposePlan(root,'2030-01-10','2030-01-10T08:00:00Z');assert.equal(initial.blocks.length,1);const source=journeyView(root).workflows[0].clips[0].source;
 j=await captureJourney(root,{source_id:source.id,workflow_id:j.id,retry:true,source_revision:source.revision},async()=>({...raw,per_frame:['New source interpretation']}),'replay');
 assert.equal(planningView(root).latest_plan!.stale,true);
 const blocked=proposePlan(root,'2030-01-10','2030-01-10T08:00:00Z');assert.equal(blocked.blocks.length,0);assert.match(blocked.deferred[0].reason,/Process reference is stale/);
 j=retain(root,review(root,j));const state=journeyView(root),p=state.workflows[0].clips[0].process!,currentTask=state.planning.tasks[0];
 editTask(root,currentTask.id,currentTask.revision,{process:{id:p.id,revision:p.rev,step_id:p.steps[0].id}},'Operator links reviewed interpretation');
 assert.equal(proposePlan(root,'2030-01-10','2030-01-10T08:00:00Z').blocks.length,1);assert.equal(planningView(root).tasks.length,1);
});
