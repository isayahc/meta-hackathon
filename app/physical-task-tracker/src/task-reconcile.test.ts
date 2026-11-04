/** Shared HTTP/CLI persistence and follow-up boundaries without opening a socket. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createServer } from './serve-dashboard.js';
import { createTask, planningView } from './lib/task-planning.js';

test('HTTP and CLI share the review queue and manual-update idempotency', async t=>{
  const root=await mkdtemp(join(tmpdir(),'reconcile-api-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const task=await createTask(root,{text:'Fill trays',quantity:{total:50,remaining:50,unit:'trays'}},'one');
  const handler=createServer(root).listeners('request')[0];
  async function request(method:string,url:string,payload?:unknown){let status=0,body='';await handler({method,url,async *[Symbol.asyncIterator](){if(payload)yield Buffer.from(JSON.stringify(payload));}},{writeHead(code:number){status=code;},end(value:string){body=value;}});return {status,json:JSON.parse(body)};}
  const command={command:'manual',request_id:'m1',task_id:task.id,task_revision:task.revision,report:'Counted remaining trays',patch:{quantity:{total:50,remaining:40,unit:'trays'}}};
  const result=await request('POST','/api/reconciliation',command);assert.equal(result.status,200);assert.equal(result.json.stage,'applied');
  const path=join(root,'command.json');await writeFile(path,JSON.stringify(command));
  const cli=fileURLToPath(new URL('./task-reconcile.js',import.meta.url));const replay=await promisify(execFile)(process.execPath,[cli,'--root',root,'--command',path]);
  assert.equal(JSON.parse(replay.stdout).id,result.json.id);assert.equal((await planningView(root)).tasks[0].revision,task.revision+1);
  const view=await request('GET','/api/reconciliation');assert.equal(view.json.sources.length,1);
  const stale=await request('POST','/api/reconciliation',{...command,request_id:'m2'});assert.equal(stale.status,409);
  const bad=await request('POST','/api/reconciliation',{command:'propose'});assert.equal(bad.status,400);
});
test('follow-up UI exposes retained evidence, correction/review and no-change paths; scripts parse',async()=>{
  const html=await readFile(new URL('./dashboard/index.html',import.meta.url),'utf8');
  const {Script}=await import('node:vm');for(const [,script] of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g))new Script(script);
  assert.match(html,/api\/reconcile-video/);assert.match(html,/data-review/);assert.match(html,/data-retain/);assert.match(html,/current_confirmed/);assert.match(html,/data-followup/);
});

