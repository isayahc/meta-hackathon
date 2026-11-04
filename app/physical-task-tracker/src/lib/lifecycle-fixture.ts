/** Synthetic tray-preparation fixture built through canonical process, improvement and outcome services. */
import { readFile } from 'node:fs/promises';
import { buildProcessFromScan, saveRevision, applyCorrection } from './processes.js';
import { saveImprovementReview, decideImprovement } from './improvements.js';
import { appendSession } from './spot-state.js';
import { registerTrial, recordTrialVisit, type InterventionTrial } from './outcomes.js';
/** Populate an isolated project. Values are invented software fixtures, never farmer validation. */
export async function lifecycleFixture(root:string) {
  const f=JSON.parse(await readFile(new URL('../samples/workflow-improvements.json',import.meta.url),'utf8'));
  const proc=buildProcessFromScan(f.scan);await saveRevision(root,proc);const {doc}=await applyCorrection(root,proc.id,{steps:Object.fromEntries(proc.steps.map(s=>[s.id,{requires_unknown:false}]))},'Synthetic review');
  let review=await saveImprovementReview(root,[doc],[],f.context,f.candidates,'replay');review=decideImprovement(root,review.id,f.candidates[0].id,'accepted','Synthetic trial');
  await appendSession(root,'bench',{same_location:true,changed:['Baseline visit'],unknowns:['No duration inferred from images']},'before');
  await appendSession(root,'bench',{same_location:true,changed:['Follow-up visit'],unknowns:[]},'after');
  const visit=(sid='before',value=20,amount=10)=>({reference:{kind:'session',spot_id:'bench',session_id:sid},observed_at:sid==='before'?'2026-01-01T08:00:00Z':'2026-01-02T08:00:00Z',process_id:doc.id,process_revision:doc.rev,workload:{amount,unit:'tray',context:'72-cell trays; same soil and fill depth'},context:{intervention_applied:sid!=='before',implementation_note:sid==='before'?'Synthetic baseline uses existing practice':'Synthetic fixture confirms selected method was used',staffing:1,equipment:'Existing scoop',conditions:'Same bench and soil',quality_criteria:'Correct fill depth',quality_passed:true,coverage:'full',coverage_note:'Operator timed the complete batch; images provide context only'},measurements:[{metric_id:'time',value,unit:'min',kind:'measured',method:'operator',source:'Synthetic stopwatch log'}],notes:'Synthetic measurement, not a real farmer result'});
  const input={command:'register',request_id:'registration',review_id:review.id,candidate_id:f.candidates[0].id,started_at:'2026-01-01T12:00:00Z',retrospective:true,workload_unit:'tray',metrics:[{id:'time',label:'Active time',unit:'min',direction:'lower',tolerance:0.01}],baseline:visit()};
  const trial=registerTrial(root,input);
  const follow=(tr:InterventionTrial,v=visit('after',12),request_id='followup')=>recordTrialVisit(root,{request_id,id:tr.id,revision:tr.revision,role:'followup',visit:v,reason:'Synthetic follow-up'});
  return {root,trial,visit,input,follow,doc,review};
}
