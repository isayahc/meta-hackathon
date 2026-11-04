/** HTTP/CLI boundary checks with real persistence and injected, labeled video analysis. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Script } from 'node:vm';
import { createServer } from './serve-dashboard.js';
const execute=promisify(execFile);

test('actual capture HTTP → workflow review HTTP → CLI reload; retries and stale revisions',async t=>{
 const root=await mkdtemp(join(tmpdir(),'journey-api-'));t.after(()=>rm(root,{recursive:true,force:true}));let calls=0;
 const handler=createServer(root,{scanRunner:async()=>{calls++;return{observed_task:'Synthetic fill tray',per_frame:['Scoop into tray'],frame_times_s:[0],video_duration_s:2,confidence:'low',unknowns:['Example only']};}}).listeners('request')[0];
 async function request(method:string,url:string,payload?:unknown){let status=0,body='';await handler({method,url,async *[Symbol.asyncIterator](){if(payload)yield Buffer.from(JSON.stringify(payload));}},{writeHead(c:number){status=c;},end(s:string){body=s;}});return{status,json:JSON.parse(body)};}
 const upload={videoData:'data:video/mp4;base64,'+Buffer.from('Synthetic test bytes').toString('base64')};
 const captured=await request('POST','/api/journey-video',upload);assert.equal(captured.status,200);await request('POST','/api/journey-video',upload);assert.equal(calls,1);
 const response=await request('GET','/api/journeys');assert.equal(response.status,200);const w=response.json.workflows[0],c=w.clips[0];assert.equal(response.json.planning.tasks.length,0);assert.ok(c.process);
 const input={command:'correct',id:w.workflow.id,revision:w.workflow.revision,request_id:'http-correct',reason:'Synthetic human correction',source_id:c.source_id,process_revision:c.process.rev,patch:{steps:{[c.process.steps[0].id]:{label:'Use the existing scoop'}}}};
 assert.equal((await request('POST','/api/journeys',input)).status,200);assert.equal((await request('POST','/api/journeys',input)).status,200);
 assert.equal((await request('POST','/api/journeys',{...input,request_id:'stale'})).status,409);
 const file=join(root,'view-command.json');await writeFile(file,JSON.stringify({command:'view',now:'2030-01-10T09:00:00Z'}));
 const cli=await execute(process.execPath,[fileURLToPath(new URL('./task-journey.js',import.meta.url)),'--root',root,'--command',file]);const view=JSON.parse(cli.stdout);assert.equal(view.workflows[0].clips[0].process.steps[0].label,'Use the existing scoop');assert.equal(view.workflows[0].workflow.id,w.workflow.id);assert.equal(view.workflows.length,1);
});

test('dashboard scripts parse and expose guided source review, explicit intent and recovery controls',async()=>{
 const html=await readFile(new URL('./dashboard/index.html',import.meta.url),'utf8');for(const [,js]of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))new Script(js);
 assert.match(html,/Record or upload your work/);assert.match(html,/Confirm review, keeping unknowns explicit/);assert.match(html,/I intend to do this future work/);assert.match(html,/Resume \/ retry retained clip/);assert.match(html,/window.addEventListener\('popstate'/);assert.match(html,/sessionStorage/);
});
