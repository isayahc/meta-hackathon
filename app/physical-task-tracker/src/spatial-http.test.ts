/** Real request-handler checks; no listening port or model/OI network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createServer } from './serve-dashboard.js';
import { buildProcessFromScan, saveRevision } from './lib/processes.js';
import { initSpot } from './lib/spot-state.js';

const execute=promisify(execFile);
test('HTTP associations reopen through a separate CLI process and stale reviews return conflict',async t=>{
  const root=await mkdtemp(join(tmpdir(),'spatial-http-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'media'));await writeFile(join(root,'media','clip.mp4'),'synthetic fixture');
  const p=buildProcessFromScan({id:'http-process',analysis:{observed_task:'Fill tray',per_frame:['Pour soil'],frame_times_s:[2]},media:'clip.mp4',eventId:'event',duration_s:10});await saveRevision(root,p);await initSpot(root,'bench','Potting bench');
  const handler=createServer(root).listeners('request')[0];
  const call=async(method:string,url:string,input?:unknown)=>{let status=0,body='';await handler({method,url,async *[Symbol.asyncIterator](){if(input)yield Buffer.from(JSON.stringify(input));}} as IncomingMessage,{writeHead(code:number){status=code;},end(value=''){body=String(value);}} as unknown as ServerResponse);return {status,json:JSON.parse(body)};};
  const input={command:'save',request_id:'http',source:{process_id:p.id,process_revision:1,step_id:p.steps[0].id,start_s:2,end_s:2},target:{kind:'spot',spot_id:'bench'},origin:'human',review:'confirmed',reason:'Operator matches bench'};
  const first=await call('POST','/api/spatial-evidence',input);assert.equal(first.status,200);assert.equal((await call('POST','/api/spatial-evidence',input)).json.association.id,first.json.association.id);
  const view=await call('GET','/api/spatial-evidence');assert.equal(view.json.associations.length,1);assert.match(view.json.associations[0].evidence_url,/#t=2$/);
  const cli=await execute(process.execPath,[fileURLToPath(new URL('./task-spatial.js',import.meta.url)),'view','--root',root]);assert.equal(JSON.parse(cli.stdout).associations[0].association.id,first.json.association.id);
  const review={command:'review',id:first.json.association.id,revision:1,request_id:'review',review:'ambiguous',reason:'Same-looking bench in a later visit'};assert.equal((await call('POST','/api/spatial-evidence',review)).status,200);assert.equal((await call('POST','/api/spatial-evidence',{...review,request_id:'stale',review:'confirmed'})).status,409);
  assert.equal((await call('POST','/api/spatial-evidence',{...input,request_id:'bad',target:{kind:'oi',scene_id:'bad',revision:1,entity_kind:'instance',entity_id:'x'}})).status,400);
  assert.equal((await call('GET','/api/spatial-evidence?scene_id=bad&revision=1')).status,400);
});
