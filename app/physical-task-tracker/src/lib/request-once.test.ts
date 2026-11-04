import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { addGoal, listGoals } from './goals.js';
import { addEvent, listStoredEvents } from './events.js';

test('creation retries survive reopening SQLite and changed payloads cannot reuse a receipt', async t => {
  const root=await mkdtemp(join(tmpdir(),'ui-retry-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const goal={text:'Prepare trays',success_criteria:'50 inspected trays'};
  const first=await addGoal(root,goal,'request');assert.deepEqual(await addGoal(root,goal,'request'),first);
  await assert.rejects((addGoal(root,{...goal,text:'Different'},'request')),/different input/);
  assert.equal((await listGoals(root)).length,1);
  const event={title:'Inspect trays',date:'2030-01-10'};
  const saved=await addEvent(root,event,'request');assert.deepEqual(await addEvent(root,event,'request'),saved);
  await assert.rejects((addEvent(root,{...event,title:'Different'},'request')),/different input/);
  assert.equal((await listStoredEvents(root)).length,1);
  await assert.rejects((addGoal(root,goal,'')),/Invalid request ID/);
  await assert.rejects((addGoal(root,{text:''},'failed')),/required/);
  assert.equal((await listGoals(root)).length,1);
  await addGoal(root,goal,'failed');assert.equal((await listGoals(root)).length,2);
});

