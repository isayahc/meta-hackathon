/** Real replica-set tests: skipped locally unless the isolated Mongo CI environment is selected. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { activateMongo } from './record-activation.js';
import { withRecords, withMongo, getDoc, setDoc, RECORD_MARKER } from './records.js';
import { TABLES } from './record-model.js';
import { initDb } from './db.js';
import { addEvent, listStoredEvents } from './events.js';
import { addGoal, listGoals } from './goals.js';
import { createTask, editTask, planningView, configurePlanning, proposePlan, decidePlan } from './task-planning.js';
import { captureJourney, journeyCommand, journeyView, type Journey } from './journey.js';
import { readProcess } from './processes.js';
import { createServer } from '../serve-dashboard.js';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
const enabled = process.env.FIELDOPS_TEST_MONGO === '1';
/** Create an isolated project, remove only its scoped records after the test. */
async function fixture(t: TestContext, initialize = true): Promise<{root:string;id:string}> {
  const root = mkdtempSync(join(tmpdir(),'mongo-records-')), id = `test-${randomUUID()}`;
  t.after(async () => {
    await withMongo(async (_client,db) => {
      for (const table of TABLES) await db.collection(`records_${table}`).deleteMany({project_id:id});
      await db.collection<{_id:string}>('record_projects').deleteOne({_id:id});
    });
    rmSync(root,{recursive:true,force:true});
  });
  if (initialize) await activateMongo(root,id,'init');
  return {root,id};
}

test('Mongo live records: capture, correction, next action, calendar, handler and fresh CLI', {skip:!enabled}, async t => {
  const {root,id} = await fixture(t);
  mkdirSync(join(root,'media')); writeFileSync(join(root,'media','clip.mp4'),'replayed media bytes');
  let j = await captureJourney(root,{media:'clip.mp4'},async()=>({observed_task:'Prepare tray',per_frame:['Fill tray'],frame_times_s:[0.5],video_duration_s:1,suggested_next_steps:['Seed tray'],model:'fixture',prompt_version:'mongo/1'}),'replay');
  const send = async (command: Record<string,unknown>): Promise<void> => { j = await journeyCommand(root,{id:j.id,revision:j.revision,request_id:randomUUID(),reason:'Integration fixture',...command}) as Journey; };
  const initial = (await journeyView(root)).workflows[0].clips[0].process!;
  await send({command:'correct',source_id:j.clips[0].source_id,process_revision:initial.rev,patch:{title:'Operator-corrected tray'}});
  const corrected = (await journeyView(root)).workflows[0].clips[0].process!;
  assert.equal((await readProcess(root,initial.id,1)).title,initial.title);
  assert.equal(corrected.rev,initial.rev+1);
  await send({command:'review',source_id:j.clips[0].source_id,process_revision:corrected.rev});
  await send({command:'next_decide',choice:'later',basis:(await journeyView(root)).workflows[0].proposal.basis});
  const task = (await planningView(root)).tasks[0];
  await editTask(root,task.id,task.revision,{active_minutes:20,remaining_minutes:20,review:'confirmed',estimate_source:'Operator estimate'},'Ready to schedule');
  await configurePlanning(root,1,{timezone:'UTC',person:'operator',resources:{},max_minutes:120,availability:[{start:'2030-01-10T09:00:00Z',end:'2030-01-10T11:00:00Z'}]});
  const plan = await proposePlan(root,'2030-01-10','2030-01-10T08:00:00Z');
  assert.equal(plan.blocks.length,1); await decidePlan(root,plan.id,'accepted','Operator accepts','2030-01-10T08:00:00Z');
  const cli = fileURLToPath(new URL('../task-journey.js',import.meta.url));
  const {stdout} = await promisify(execFile)(process.execPath,[cli,'view','--root',root],{env:process.env});
  assert.equal(JSON.parse(stdout).workflows[0].workflow.title,'Operator-corrected tray');
  assert.equal((await planningView(root)).schedule.blocks[0].status,'accepted');
  const event = await addEvent(root,{title:'Evidence note',date:'2030-01-10',media:'clip.mp4',payload:'Plain text payload'});
  assert.equal((await listStoredEvents(root)).find(e=>e.id===event.id)?.media,'clip.mp4');
  assert.equal(existsSync(join(root,'fieldops.db')),false);
  const server = createServer(root);
  const response = await new Promise<{status:number;body:string}>(resolve => {
    const req = Readable.from([]) as IncomingMessage;req.method='GET';req.url='/healthz';
    const res = {writeHead(status:number){this.status=status;},status:0,end(body:string){resolve({status:this.status,body});}};
    server.emit('request',req,res as unknown as ServerResponse);
  });
  assert.equal(response.status,200); assert.equal(JSON.parse(response.body).record_backend,'mongodb');
  await withMongo(async (_client,db) => {
    const stored = await db.collection('records_processes').findOne({project_id:id,'data.id':initial.id,'data.rev':corrected.rev});
    assert.equal(stored?.data.body.title,'Operator-corrected tray','Process is a native BSON record');
    assert.ok(await db.collection('records_docs').findOne({project_id:id,'data.key':'human-schedule'}));
  });
});

test('Mongo concurrent stale corrections, duplicate requests, rollback and project isolation', {skip:!enabled}, async t => {
  const a = await fixture(t), b = await fixture(t);
  const [first,retry] = await Promise.all([addGoal(a.root,{text:'Harvest'},'same-request'),addGoal(a.root,{text:'Harvest'},'same-request')]);
  assert.equal(first.id,retry.id);assert.equal((await listGoals(a.root)).length,1);assert.equal((await listGoals(b.root)).length,0);
  const task = await createTask(a.root,{text:'Harvest'},'task');
  const results = await Promise.allSettled([
    editTask(a.root,task.id,task.revision,{text:'First correction'},'First operator'),
    editTask(a.root,task.id,task.revision,{text:'Second correction'},'Second operator'),
  ]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const failure = results.find(r=>r.status==='rejected') as PromiseRejectedResult;assert.match(String(failure.reason),/Stale task revision/);
  assert.equal((await planningView(a.root)).tasks[0].revision,task.revision+1);
  await assert.rejects(withRecords(a.root,tx=>{tx.insert('docs',{key:'must-rollback',body:'{}',updated_at:'now'});tx.update('goals',{id:first.id},{text:'Must roll back'});throw new Error('Injected failure');}),/Injected/);
  assert.equal(await getDoc(a.root,'must-rollback'),null);assert.equal((await listGoals(a.root))[0].text,'Harvest');
  await assert.rejects(addGoal(a.root,{text:'Changed request'},'same-request'),/different input/);
  await setDoc(b.root,'same-key',{scope:'B'});await setDoc(a.root,'same-key',{scope:'A'});
  assert.deepEqual(await getDoc(b.root,'same-key'),{scope:'B'});
  assert.throws(()=>initDb(a.root),/SQLite access refused/);
  // A missing authority is an error even if a stale local SQLite file is present.
  writeFileSync(join(a.root,'fieldops.db'),'stale fallback sentinel');
  await withMongo(async (_client,db)=>{await db.collection<{_id:string}>('record_projects').deleteOne({_id:a.id});});
  await assert.rejects(listGoals(a.root),/missing|incompatible/);
  assert.equal(readFileSync(join(a.root,'fieldops.db'),'utf8'),'stale fallback sentinel');
});

test('Mongo import preserves stable IDs and receipts; pending activation resumes without overwrite', {skip:!enabled}, async t => {
  const {root,id} = await fixture(t,false);
  const goal = await addGoal(root,{text:'Existing goal'},'import-request');
  await setDoc(root,'corrected',{human:true,revision:4});
  const source = readFileSync(join(root,'fieldops.db'));
  await activateMongo(root,id,'import');
  assert.equal((await listGoals(root))[0].id,goal.id);assert.deepEqual(await getDoc(root,'corrected'),{human:true,revision:4});
  assert.deepEqual(readFileSync(join(root,'fieldops.db')),source);
  // Simulate a crash after the remote commit and before the local marker activation.
  writeFileSync(join(root,RECORD_MARKER),JSON.stringify({backend:'mongodb',project_id:id,state:'pending'}));
  await assert.rejects(listGoals(root),/activation is incomplete/);
  await activateMongo(root,id,'import');
  assert.equal((await addGoal(root,{text:'Existing goal'},'import-request')).id,goal.id);
  await addGoal(root,{text:'New live write'});
  writeFileSync(join(root,RECORD_MARKER),JSON.stringify({backend:'mongodb',project_id:id,state:'pending'}));
  await assert.rejects(activateMongo(root,id,'import'),/newer records/);
});
