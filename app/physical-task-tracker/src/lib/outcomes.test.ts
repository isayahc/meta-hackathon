/** Outcomes use stored evidence and measurements, never model-estimated savings as validation. */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildProcessFromScan, saveRevision, applyCorrection } from './processes.js';
import { saveImprovementReview, decideImprovement } from './improvements.js';
import { appendSession, readSession } from './spot-state.js';
import { createTask, planningView } from './task-planning.js';
import { addGoal, listGoals } from './goals.js';
import { withDb } from './db.js';
import { retainVisitEvidence } from './visit-evidence.js';
import { registerTrial, recordTrialVisit, decideTrial, outcomeView, evaluateTrial, outcomeBriefing, attachOutcomeBriefing, type InterventionTrial } from './outcomes.js';

async function fixture(t: TestContext) {
  const root=await mkdtemp(join(tmpdir(),'outcomes-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const f=JSON.parse(await readFile(new URL('../samples/workflow-improvements.json',import.meta.url),'utf8'));
  const proc=buildProcessFromScan(f.scan);await saveRevision(root,proc);const {doc}=await applyCorrection(root,proc.id,{steps:Object.fromEntries(proc.steps.map(s=>[s.id,{requires_unknown:false}]))},'Synthetic review');
  let review=await saveImprovementReview(root,[doc],[],f.context,f.candidates,'replay');review=decideImprovement(root,review.id,f.candidates[0].id,'accepted','Synthetic trial');
  await appendSession(root,'bench',{same_location:true,changed:['Baseline visit'],unknowns:['No duration inferred from images']},'before');
  await appendSession(root,'bench',{same_location:true,changed:['Follow-up visit'],unknowns:[]},'after');
  const visit=(sid='before',value=20,amount=10)=>({reference:{kind:'session',spot_id:'bench',session_id:sid},observed_at:sid==='before'?'2026-01-01T08:00:00Z':'2026-01-02T08:00:00Z',process_id:doc.id,process_revision:doc.rev,workload:{amount,unit:'tray',context:'72-cell trays; same soil and fill depth'},context:{intervention_applied:true,implementation_note:'Synthetic fixture confirms selected method was used',staffing:1,equipment:'Existing scoop',conditions:'Same bench and soil',quality_criteria:'Correct fill depth',quality_passed:true,coverage:'full',coverage_note:'Operator timed the complete batch; images provide context only'},measurements:[{metric_id:'time',value,unit:'min',kind:'measured',method:'operator',source:'Synthetic stopwatch log'}],notes:'Synthetic measurement, not a real farmer result'});
  const input={command:'register',request_id:'registration',review_id:review.id,candidate_id:f.candidates[0].id,started_at:'2026-01-01T12:00:00Z',retrospective:true,workload_unit:'tray',metrics:[{id:'time',label:'Active time',unit:'min',direction:'lower',tolerance:0.01}],baseline:visit()};
  const trial=registerTrial(root,input);
  const follow=(tr:InterventionTrial,v=visit('after',12),request_id='followup')=>recordTrialVisit(root,{request_id,id:tr.id,revision:tr.revision,role:'followup',visit:v,reason:'Synthetic follow-up'});
  return {root,trial,visit,input,follow,doc,review};
}
test('two sessions retain exact baseline/process/prediction snapshots; unequal workloads normalize correctly',async t=>{
  const {root,trial,follow,visit}=await fixture(t);const updated=follow(trial,visit('after',30,20));const result=evaluateTrial(updated);
  assert.equal(result.status,'improved');assert.equal(result.metrics[0].baseline,2);assert.equal(result.metrics[0].followup,1.5);assert.equal(result.metrics[0].improvement_percent,25);
  assert.equal(updated.assessment.comparisons[0].reduction_percent,40);assert.equal(updated.assessment.comparisons[0].status,'projection');assert.match(result.causal_interpretation,/not proof/);
  assert.equal(updated.baseline!.process_snapshot.rev,2);assert.equal(updated.followups[0].reference.kind,'session');assert.equal(outcomeView(root).trials[0].result.status,'improved');assert.equal(updated.registration,'retrospective');
});
test('improved, unchanged, worse and unknown results have explicit arithmetic',async t=>{
  const {trial,follow,visit,root}=await fixture(t);
  for(const [value,status] of [[12,'improved'],[20,'unchanged'],[30,'worse']] as const){const v=visit('after',value);let updated=outcomeView(root).trials[0].trial;if(!updated.followups.length)updated=follow(updated,v);else updated=recordTrialVisit(root,{request_id:`fix-${value}`,id:updated.id,revision:updated.revision,role:'followup',visit_id:updated.followups[0].id,visit:v,reason:'Corrected timing'});assert.equal(evaluateTrial(updated).status,status);}
  assert.equal(evaluateTrial(trial).status,'unknown');
});
test('occlusion, changed staffing/equipment, workload mix and missing quality yield inconclusive outcomes',async t=>{
  const {trial,visit,follow}=await fixture(t),updated=follow(trial);
  for(const patch of [{coverage:'partial'},{staffing:2},{equipment:'Different scoop'},{quality_passed:null},{conditions:null}]){const copy=structuredClone(updated);Object.assign(copy.followups[0].context,patch);const result=evaluateTrial(copy);assert.equal(result.status,'inconclusive',JSON.stringify(patch));assert.equal(result.metrics[0].delta,-0.8);}
  const copy=structuredClone(updated);copy.followups[0].workload.context='128-cell trays';assert.equal(evaluateTrial(copy).status,'inconclusive');
});
test('predicted or sparse-frame measurements never become measured savings; absent baseline stays unknown',async t=>{
  const {trial,follow}=await fixture(t),updated=follow(trial);
  for(const kind of ['estimated','unknown'] as const){const copy=structuredClone(updated);copy.followups[0].measurements[0].kind=kind;if(kind==='unknown')copy.followups[0].measurements[0].value=null;assert.equal(evaluateTrial(copy).status,'unknown');assert.equal(evaluateTrial(copy).metrics[0].delta,null);}
  for(const method of ['sparse_frames','continuous_video'] as const){const copy=structuredClone(updated);copy.followups[0].measurements[0].method=method;assert.equal(evaluateTrial(copy).status,'unknown');}
  const copy=structuredClone(updated);copy.baseline=null;assert.equal(evaluateTrial(copy).status,'unknown');
});
test('failed quality prevents an overall improvement even when time per tray improves',async t=>{
  const {trial,follow}=await fixture(t),updated=follow(trial);updated.followups[0].context.quality_passed=false;const result=evaluateTrial(updated);assert.equal(result.status,'worse');assert.equal(result.metrics[0].status,'improved');assert.match(result.reasons.join(' '),/quality/);
});
test('registered intended equipment change is distinguished from an unplanned confounder',async t=>{
  const {root,input,visit}=await fixture(t);const trial=registerTrial(root,{...input,request_id:'planned',expected_changes:[{field:'equipment',value:'New scoop',reason:'The selected change being tested'}]});const v=visit('after',12);v.context.equipment='New scoop';const updated=recordTrialVisit(root,{request_id:'planned-follow',id:trial.id,revision:trial.revision,role:'followup',visit:v,reason:'Test planned tool'});const result=evaluateTrial(updated);assert.equal(result.status,'improved');assert.equal(result.context_differences[0].planned,true);
});
test('zero baseline has no invalid percent; higher-is-better direction and practical tolerance work',async t=>{
  const {trial,follow}=await fixture(t),updated=follow(trial);updated.metrics[0].direction='higher';assert.equal(evaluateTrial(updated).status,'worse');updated.metrics[0].tolerance=1;assert.equal(evaluateTrial(updated).status,'unchanged');updated.baseline!.measurements[0].value=0;assert.equal(evaluateTrial(updated).metrics[0].improvement_percent,null);
});
test('human decisions survive reload, influence briefing, preserve unfinished tasks/goals and invalidate after correction',async t=>{
  const {root,trial,follow,visit}=await fixture(t);const goal=await addGoal(root,{text:'Prepare trays'});createTask(root,{text:'Remaining trays',links:[{goal_id:goal.id,origin:'human',review:'confirmed',explanation:'Required work'}]},'open-task');
  let updated=follow(trial),result=evaluateTrial(updated);
  const command={request_id:'reject',id:updated.id,revision:updated.revision,evidence_digest:result.evidence_digest,decision:'reject',reason:'Farmer finds method inconvenient'};
  updated=decideTrial(root,command);decideTrial(root,command);assert.equal(updated.decisions.length,1);assert.match(outcomeBriefing(root).next_actions[0],/Stop using/);
  const briefing=attachOutcomeBriefing(root,{next_actions:['Use the rejected method anyway'],overall:'Generated narrative'}) as any;assert.ok(!briefing.next_actions.includes('Use the rejected method anyway'));assert.ok(briefing.suggested_actions_for_review.includes('Use the rejected method anyway'));assert.equal(briefing.unresolved_tasks.length,1);assert.equal((await listGoals(root))[0].status,'open');assert.equal(planningView(root).tasks[0].execution,'open');
  updated=recordTrialVisit(root,{request_id:'correction',id:updated.id,revision:updated.revision,role:'followup',visit_id:updated.followups[0].id,visit:visit('after',25),reason:'Timer correction'});
  assert.equal(updated.corrections.at(-1)!.before!.measurements[0].value,12);assert.equal(evaluateTrial(updated).latest_decision!.current,false);assert.equal(evaluateTrial(updated).status,'worse');assert.equal(updated.registered_baseline!.measurements[0].value,20);
});
test('revision plan required; stale decision payloads and conflicting request retries reject',async t=>{
  const {root,trial,follow}=await fixture(t);const updated=follow(trial),result=evaluateTrial(updated);
  assert.throws(()=>decideTrial(root,{request_id:'bad',id:updated.id,revision:1,evidence_digest:result.evidence_digest,decision:'keep',reason:'Stale'}),/Stale/);
  assert.throws(()=>decideTrial(root,{request_id:'bad2',id:updated.id,revision:updated.revision,evidence_digest:result.evidence_digest,decision:'revise',reason:'Need changes'}),/Revision plan/);
  const revised=decideTrial(root,{request_id:'revise',id:updated.id,revision:updated.revision,evidence_digest:result.evidence_digest,decision:'revise',reason:'Change holder',revision_plan:'Move holder and repeat controlled trial'});assert.match(outcomeBriefing(root).next_actions[0],/Move holder/);assert.equal(revised.decisions.length,1);
});
test('duplicate sessions and invalid units/denominators are rejected without a partial record',async t=>{
  const {root,trial,follow,visit}=await fixture(t);const updated=follow(trial);
  assert.throws(()=>follow(updated,visit('after'),'duplicate'),/Duplicate evidence/);
  for(const [field,value] of [['amount',0],['unit','cell']] as const){const v=visit('after');(v.workload as any)[field]=value;assert.throws(()=>recordTrialVisit(root,{request_id:`invalid-${field}`,id:updated.id,revision:updated.revision,role:'followup',visit_id:updated.followups[0].id,visit:v,reason:'Bad'}),/Workload/);}
  const v=visit('after');v.measurements[0].unit='seconds';assert.throws(()=>recordTrialVisit(root,{request_id:'wrongunit',id:updated.id,revision:updated.revision,role:'followup',visit_id:updated.followups[0].id,visit:v,reason:'Wrong unit'}),/unit/);
  assert.equal(outcomeView(root).trials[0].trial.revision,updated.revision);
});
test('source mutation and process correction invalidate current recommendation but preserve historical measurements',async t=>{
  const {root,trial,follow,doc}=await fixture(t);const updated=follow(trial);const r=evaluateTrial(updated);decideTrial(root,{request_id:'keep',id:updated.id,revision:updated.revision,evidence_digest:r.evidence_digest,decision:'keep',reason:'Keep trial method'});
  await applyCorrection(root,doc.id,{title:'Corrected procedure'},'New process');let view=outcomeView(root).trials[0];assert.equal(view.result.latest_decision!.current,false);assert.equal(view.result.metrics[0].delta,-0.8);assert.ok(view.result.source_warnings.length);
  withDb(root,db=>db.prepare('UPDATE sessions SET analysis=? WHERE sid=?').run(JSON.stringify({changed:['Correction']}),'after'));view=outcomeView(root).trials[0];assert.ok(view.result.source_warnings.some(w=>w.includes('Source')));
});
test('quarantined session cannot silently substantiate a successful intervention',async t=>{
  const {root,trial,visit}=await fixture(t);await appendSession(root,'bench',{same_location:false},'wrong-place');const v=visit('wrong-place',12);const updated=recordTrialVisit(root,{request_id:'wrong-place',id:trial.id,revision:trial.revision,role:'followup',visit:v,reason:'Check uncertain source'});assert.equal(evaluateTrial(updated).status,'inconclusive');assert.match(evaluateTrial(updated).reasons.join(' '),/quarantined/);
});
test('retain compare media and sampled frames after originals disappear',async t=>{
  const {root}=await fixture(t),path=join(root,'original.png'),bytes=Buffer.from('synthetic bytes; not a real image');await writeFile(path,bytes);const evidence=await retainVisitEvidence(root,path,[`data:image/png;base64,${bytes.toString('base64')}`]);await rm(path);
  assert.deepEqual(await readFile(join(root,'media',evidence.source!.media)),bytes);assert.equal(evidence.frames[0].checksum,evidence.source!.checksum);assert.equal(evidence.coverage,'sampled');
});

test('current trial decision gates the existing improvement plan without completing tasks',async t=>{
  const {root,trial,follow,review}=await fixture(t);const {improvementPlan}=await import('./improvements.js');
  assert.equal(improvementPlan(review,root).ranked_actions.length,0);let updated=follow(trial);let result=evaluateTrial(updated);
  updated=decideTrial(root,{request_id:'keep-plan',id:updated.id,revision:updated.revision,evidence_digest:result.evidence_digest,decision:'keep',reason:'Retain measured method'});assert.equal(improvementPlan(review,root).ranked_actions.length,1);
  updated=decideTrial(root,{request_id:'reject-plan',id:updated.id,revision:updated.revision,evidence_digest:result.evidence_digest,decision:'reject',reason:'Operator rejects method'});assert.equal(improvementPlan(review,root).ranked_actions.length,0);assert.match(improvementPlan(review,root).deferred[0].why,/Stop using/);
});
test('baseline correction preserves registration, request retries do not duplicate visits, failed persistence rolls back',async t=>{
  const {root,trial,visit,input}=await fixture(t);assert.equal(registerTrial(root,input).id,trial.id);assert.throws(()=>registerTrial(root,{...input,workload_unit:'cell'}),/reused/);
  const command={request_id:'baseline-fix',id:trial.id,revision:trial.revision,role:'baseline',visit:visit('before',22),reason:'Correct stopwatch transcription'};
  withDb(root,db=>db.exec("CREATE TRIGGER fail_trial BEFORE UPDATE ON docs WHEN NEW.key LIKE 'intervention-trial:%' BEGIN SELECT RAISE(ABORT,'interrupted save'); END"));assert.throws(()=>recordTrialVisit(root,command),/interrupted save/);assert.equal(outcomeView(root).trials[0].trial.baseline!.measurements[0].value,20);withDb(root,db=>db.exec('DROP TRIGGER fail_trial'));
  const updated=recordTrialVisit(root,command);recordTrialVisit(root,command);assert.equal(updated.registered_baseline!.measurements[0].value,20);assert.equal(updated.baseline!.measurements[0].value,22);assert.equal(outcomeView(root).trials[0].trial.corrections.length,1);
});
test('unknown denominator, missing baseline, chronology and duplicate metric validation are explicit',async t=>{
  const {root,input,visit}=await fixture(t);let tr=registerTrial(root,{...input,request_id:'missing',baseline:null});assert.equal(evaluateTrial(tr).status,'unknown');
  const v=visit('after');v.workload.amount=null as any;tr=recordTrialVisit(root,{request_id:'unknown-denom',id:tr.id,revision:tr.revision,role:'followup',visit:v,reason:'Unknown tray count'});assert.equal(evaluateTrial(tr).status,'unknown');
  const old=visit('after');old.observed_at='2025-12-01T00:00:00Z';assert.throws(()=>recordTrialVisit(root,{request_id:'old',id:tr.id,revision:tr.revision,role:'followup',visit:old,reason:'Too early'}),/after the trial/);
  assert.throws(()=>registerTrial(root,{...input,request_id:'metrics',metrics:[input.metrics[0],input.metrics[0]]}),/Duplicate metric/);
});

test('unverified adoption stays inconclusive, and numeric overflow never becomes JSON infinity',async t=>{
  const {trial,follow}=await fixture(t);const updated=follow(trial);updated.followups[0].context.intervention_applied=null;assert.equal(evaluateTrial(updated).status,'inconclusive');assert.match(evaluateTrial(updated).reasons.join(' '),/selected intervention/);updated.followups[0].context.intervention_applied=true;updated.followups[0].workload.amount=Number.MIN_VALUE;assert.equal(evaluateTrial(updated).status,'unknown');assert.equal(evaluateTrial(updated).metrics[0].followup,null);
});

test('new constraints or withdrawn improvement approval invalidate a prior keep recommendation',async t=>{
  const {root,trial,follow,review}=await fixture(t);let updated=follow(trial);const result=evaluateTrial(updated);updated=decideTrial(root,{request_id:'keep-before',id:updated.id,revision:updated.revision,evidence_digest:result.evidence_digest,decision:'keep',reason:'Keep initially'});
  decideImprovement(root,review.id,trial.candidate_id,'rejected','Operator withdrew original approval');let current=outcomeView(root).trials[0].result;assert.equal(current.latest_decision!.current,false);assert.match(current.source_warnings.join(' '),/approval/);
  const {getDoc,setDoc}=await import('./db.js');const context=getDoc(root,'workflow-context') as any;context.constraints.budget_usd=0;setDoc(root,'workflow-context',context);current=outcomeView(root).trials[0].result;assert.match(current.source_warnings.join(' '),/constraints/);
});

test('regenerating an unchanged improvement review does not resurrect a rejected method',async t=>{
  const {root,trial,follow,review}=await fixture(t);const {improvementPlan}=await import('./improvements.js');const updated=follow(trial),result=evaluateTrial(updated);decideTrial(root,{request_id:'reject-reemitted',id:updated.id,revision:updated.revision,evidence_digest:result.evidence_digest,decision:'reject',reason:'Method rejected'});
  const regenerated=structuredClone(review);regenerated.id='different-review';assert.equal(improvementPlan(regenerated,root).ranked_actions.length,0);assert.match(improvementPlan(regenerated,root).deferred[0].why,/Stop using/);
});
