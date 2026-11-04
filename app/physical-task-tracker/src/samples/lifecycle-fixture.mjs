/** Retained, repeatable CLI demonstration. All observations and measurements are synthetic. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lifecycleFixture } from '../lib/lifecycle-fixture.js';
import { recordTrialVisit } from '../lib/outcomes.js';
const execute=promisify(execFile),out=process.argv[2];
if(!out||!isAbsolute(out))throw Error('Pass a new absolute output directory.');
await mkdir(out);const root=join(out,'project'),f=await lifecycleFixture(root),cli=fileURLToPath(new URL('../task-lifecycle.js',import.meta.url));
/** Invoke the public command and retain exact request and response for inspection. */
async function run(label,command,project=root){const path=join(out,label+'.command.json');await writeFile(path,JSON.stringify(command,null,2));const {stdout}=await execute(process.execPath,[cli,'--root',project,'--command',path],{maxBuffer:32*1024*1024});await writeFile(join(out,label+'.json'),stdout);return JSON.parse(stdout);}
const capture=(trial,followup=false)=>({command:'capture',request_id:followup?'followup':'baseline',trial_id:trial.id,trial_revision:trial.revision,visit_id:followup?trial.followups[0].id:trial.baseline.id,mode:'synthetic',reviewer:'Synthetic fixture author',reason:'Invented tray timing for software checks; not farmer validation.',expected_status:followup?'improved':'unknown',permissions:{metadata_export:true,media_export:false,training:false,authority:'Synthetic fixture author'}});
const baseline=await run('01-baseline',capture(f.trial)),trial=f.follow(f.trial),followup=await run('02-followup',capture(trial,true));
await run('03-dataset',{command:'dataset',id:'tray-preparation',version:1,inclusion_criteria:'Synthetic reviewed tray visits. Both visits remain in the same held-out workflow group.',members:[baseline,followup].map(e=>({id:e.id,revision:e.revision,split:'test'}))});
const evaluation=await run('04-evaluation',{command:'evaluate',id:'tray-preparation',version:1,split:'test'});assert.equal(evaluation.passed,2);assert.equal(evaluation.total,2);
await run('05-select',{command:'select',evaluation_id:evaluation.id,reviewer:'Fixture author',reason:'Software regression baseline only; no training or field performance claim.'});
const inference=await run('06-inference',{command:'infer',id:followup.id,revision:followup.revision});assert.equal(inference.performed_action,null);assert.equal(inference.outcome,null);assert.equal(inference.prediction.completed,false);
const bundle=await run('07-bundle',{command:'export',id:'tray-preparation',version:1});await run('08-import',{command:'import',bundle},join(out,'reopened'));const reopened=await run('09-reexport',{command:'export',id:'tray-preparation',version:1},join(out,'reopened'));assert.deepEqual(reopened,bundle);
const replay=await run('10-replay',{command:'replay',bundle},join(out,'reopened'));assert.deepEqual(replay.results.map(r=>r.prediction.status),['unknown','improved']);
recordTrialVisit(root,{request_id:'correct-timing',id:trial.id,revision:trial.revision,role:'followup',visit_id:trial.followups[0].id,visit:f.visit('after',30),reason:'Synthetic corrected stopwatch transcript'});
const changed=await run('11-after-correction',{command:'view'});assert.ok(changed.episodes.find(e=>e.episode.id===followup.id).issues.some(s=>s.includes('corrected')));assert.deepEqual(changed.evaluations[0],evaluation);
const report={passed:true,mode:'synthetic observations; actual CLI/persistence; deterministic policy replay',live_inference:false,training:false,evaluation:{passed:evaluation.passed,total:evaluation.total,independent_workflows:1},checks:['baseline/follow-up traceability','held-out rule evaluation','explicit reviewed selection','no inferred execution or completion','bundle import/replay round-trip','corrected source invalidates reuse without rewriting historical score'],bundle:join(out,'07-bundle.json'),limitations:['One synthetic workflow; correlated visits are not independent field evidence.','Original media bytes are not included. Legacy compare-session media identity is explicitly unknown.','No OI geometry or live model quality is established by this scenario.']};await writeFile(join(out,'result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
