/** Actual HTTP/CLI/compare/briefing contracts, with injected model output and no sockets. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Script } from 'node:vm';
import { createServer } from './serve-dashboard.js';
import { outcomeView } from './lib/outcomes.js';
import { readSession } from './lib/spot-state.js';
const execute=promisify(execFile);

test('outcome HTTP and CLI read identical evidence and enforce stale decisions',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'outcome-api-'));t.after(()=>rm(dir,{recursive:true,force:true}));const root=join(dir,'project');
  await execute(process.execPath,[fileURLToPath(new URL('../scripts/replay-outcomes.mjs',import.meta.url)),root]);
  const handler=createServer(root).listeners('request')[0];async function request(method:string,url:string,payload?:unknown){let status=0,body='';await handler({method,url,async *[Symbol.asyncIterator](){if(payload)yield Buffer.from(JSON.stringify(payload));}},{writeHead(c:number){status=c;},end(s:string){body=s;}});return{status,json:JSON.parse(body)};}
  const response=await request('GET','/api/outcomes');assert.equal(response.status,200);const {trial,result}=response.json.trials[0];assert.equal(result.status,'worse');assert.equal(result.latest_decision.decision,'reject');
  const cli=await execute(process.execPath,[fileURLToPath(new URL('./task-outcomes.js',import.meta.url)),'view','--root',root]);assert.deepEqual(JSON.parse(cli.stdout),response.json);
  const stale=await request('POST','/api/outcomes',{command:'decide',request_id:'stale',id:trial.id,revision:1,evidence_digest:result.evidence_digest,decision:'keep',reason:'Outdated'});assert.equal(stale.status,409);
  const sources=await request('POST','/api/outcomes',{command:'sources'});assert.equal(sources.json.sessions.length,2);
});
test('generated briefing cannot replace authoritative rejected-trial actions; prompt carries evidence decisions',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'outcome-brief-'));t.after(()=>rm(dir,{recursive:true,force:true}));const root=join(dir,'project');await execute(process.execPath,[fileURLToPath(new URL('../scripts/replay-outcomes.mjs',import.meta.url)),root]);
  const stub=join(dir,'stub.mjs'),capture=join(dir,'request.json');await writeFile(stub,`import {writeFile} from 'node:fs/promises';globalThis.fetch=async(url,init)=>{await writeFile(${JSON.stringify(capture)},init.body);return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({overall:'Generated summary',next_actions:['Use the rejected method anyway']})},finish_reason:'stop'}]})};};`);
  const response=await execute(process.execPath,['--import',pathToFileURL(stub).href,fileURLToPath(new URL('./task-briefing.js',import.meta.url)),root],{env:{...process.env,META_API_KEY:'fixture-key',META_API_BASE:'https://offline.invalid'}});const briefing=JSON.parse(response.stdout);assert.ok(briefing.next_actions.some((s:string)=>s.includes('Stop using')));assert.ok(!briefing.next_actions.includes('Use the rejected method anyway'));assert.equal(briefing.unresolved_tasks.length,1);assert.equal(briefing.model_narrative_stale,false);
  const request=JSON.parse(await readFile(capture,'utf8'));const prompt=request.messages.flatMap((m:any)=>m.content.map((p:any)=>p.text||'')).join('\n');assert.match(prompt,/"decision":"reject"/);assert.match(prompt,/unresolved/);
});
test('actual compare CLI retains source images, sampled frames and a discoverable session reference',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'outcome-compare-'));t.after(()=>rm(dir,{recursive:true,force:true}));const a=join(dir,'before.png'),b=join(dir,'after.png');await writeFile(a,'synthetic before pixels');await writeFile(b,'synthetic after pixels');const stub=join(dir,'stub.mjs');await writeFile(stub,`globalThis.fetch=async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({same_location:true,changed:['Fixture only'],unknowns:['No actual duration measured']})},finish_reason:'stop'}]})});`);
  const root=join(dir,'project');const response=await execute(process.execPath,['--import',pathToFileURL(stub).href,fileURLToPath(new URL('./task-compare.js',import.meta.url)),a,b,'--spot','bench','--root',root],{env:{...process.env,META_API_KEY:'fixture-key',META_API_BASE:'https://offline.invalid'}});const result=JSON.parse(response.stdout);assert.equal(result.session.spot_id,'bench');await rm(a);await rm(b);
  const stored=await readSession(root,'bench',result.session.session_id);const evidence=stored.visit_evidence as any;assert.equal(await readFile(join(root,'media',evidence.after.source.media),'utf8'),'synthetic after pixels');assert.equal(evidence.after.coverage,'sampled');assert.notEqual(evidence.before.identity,evidence.after.identity);
});
test('dashboard scripts parse and show prediction, measurement, uncertainty and farmer-decision controls',async()=>{
  const html=await readFile(new URL('./dashboard/index.html',import.meta.url),'utf8');for(const [,script]of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))new Script(script);assert.match(html,/Prediction saved before evaluation/);assert.match(html,/Measured comparison/);assert.match(html,/outcomedecisionform/);assert.match(html,/quality_criteria/);assert.match(html,/Correct baseline/);
});

test('measurement correction during model generation flags stale narrative and preserves rejected-method hold',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'outcome-brief-race-'));t.after(()=>rm(dir,{recursive:true,force:true}));const root=join(dir,'project');await execute(process.execPath,[fileURLToPath(new URL('../scripts/replay-outcomes.mjs',import.meta.url)),root]);
  const stub=join(dir,'race.mjs');await writeFile(stub,`import {outcomeView,recordTrialVisit} from ${JSON.stringify(new URL('./lib/outcomes.js',import.meta.url).href)};globalThis.fetch=async()=>{const {trial}=outcomeView(${JSON.stringify(root)}).trials[0];const visit=structuredClone(trial.followups[0]);visit.measurements[0].value=36;recordTrialVisit(${JSON.stringify(root)},{request_id:'race',id:trial.id,revision:trial.revision,role:'followup',visit_id:visit.id,visit,reason:'Corrected while generating'});return {ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({next_actions:['Adopt old method']})},finish_reason:'stop'}]})};};`);
  const response=await execute(process.execPath,['--import',pathToFileURL(stub).href,fileURLToPath(new URL('./task-briefing.js',import.meta.url)),root],{env:{...process.env,META_API_KEY:'fixture-key',META_API_BASE:'https://offline.invalid'}});const result=JSON.parse(response.stdout);assert.equal(result.model_narrative_stale,true);assert.ok(result.next_actions.some((s:string)=>s.includes('Keep it stopped')));assert.equal(result.intervention_outcomes[0].decision.current,false);
});

test('retained compare images are accessible through the real media handler with the correct MIME',async t=>{
  const root=await mkdtemp(join(tmpdir(),'outcome-media-'));t.after(()=>rm(root,{recursive:true,force:true}));const original=join(root,'test.png'),bytes=Buffer.from('synthetic image bytes');await writeFile(original,bytes);const {retainVisitEvidence}=await import('./lib/visit-evidence.js');const retained=await retainVisitEvidence(root,original,[`data:image/png;base64,${bytes.toString('base64')}`]);
  const handler=createServer(root).listeners('request')[0];let status=0,headers:Record<string,string>={};let body:Buffer=Buffer.alloc(0);await handler({method:'GET',url:'/media/'+retained.source!.media},{writeHead(c:number,h:Record<string,string>){status=c;headers=h;},end(v:Buffer){body=v;}});assert.equal(status,200);assert.equal(headers['Content-Type'],'image/png');assert.deepEqual(body,bytes);
});
