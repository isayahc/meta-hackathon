/** Storage selection and atomicity without a Mongo service or network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withRecords, getDoc, RECORD_MARKER, projectId, validateRows } from './records.js';
import { emptyRows, RecordTransaction } from './record-model.js';
import { initDb } from './db.js';
import { inspectRecordImport } from './record-activation.js';
import { addGoal, listGoals } from './goals.js';

test('shared record transaction rolls back multi-record failures on SQLite', async t => {
  const root=mkdtempSync(join(tmpdir(),'record-atomic-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const goal=await addGoal(root,{text:'Keep original'});
  await assert.rejects(withRecords(root,tx=>{tx.update('goals',{id:goal.id},{text:'Discard'});tx.insert('docs',{key:'receipt',body:'{}',updated_at:'now'});throw Error('Injected');}),/Injected/);
  assert.equal((await listGoals(root))[0].text,'Keep original');assert.equal(await getDoc(root,'receipt'),null);
});

test('Mongo authority and pending markers prevent stale SQLite access, including legacy APIs', async t => {
  const root=mkdtempSync(join(tmpdir(),'record-marker-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  initDb(root);const bytes=readFileSync(join(root,'fieldops.db'));
  writeFileSync(join(root,RECORD_MARKER),JSON.stringify({backend:'mongodb',project_id:'farm',state:'pending'}));
  await assert.rejects(listGoals(root),/activation is incomplete/);assert.throws(()=>initDb(root),/SQLite access refused/);
  assert.deepEqual(readFileSync(join(root,'fieldops.db')),bytes);
});

test('import dry run preserves records without upgrading the source; duplicate keys and unsafe scopes fail', async t => {
  const root=mkdtempSync(join(tmpdir(),'record-inventory-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const goal=await addGoal(root,{text:'Inventory'}), bytes=readFileSync(join(root,'fieldops.db'));
  const rows=inspectRecordImport(root);assert.equal(rows.goals[0].id,goal.id);assert.deepEqual(readFileSync(join(root,'fieldops.db')),bytes);assert.equal(existsSync(join(root,RECORD_MARKER)),false);
  rows.goals.push({...rows.goals[0]});assert.throws(()=>validateRows(rows),/Duplicate/);
  for(const id of ['','../farm','farm.$where'])assert.throws(()=>projectId(id));
});

test('record queries preserve null ordering, selected fields, compound identity and explicit upsert fields', () => {
  const tx=new RecordTransaction(emptyRows());
  tx.insert('events',{id:'a',title:'First',date:'2030-01-01',created_at:'original'});
  tx.insert('events',{id:'b',title:'Second',date:'2030-01-01',time:'09:00',created_at:'original'});
  tx.insert('events',{id:'a',title:'Changed',date:'2030-01-01',created_at:'new'}, {update:['title']});
  assert.deepEqual(tx.select('events',{order:['date','time'],fields:['id','created_at']}),[{id:'a',created_at:'original'},{id:'b',created_at:'original'}]);
  tx.insert('actions',{id:'a-0',event_id:'a',idx:0,text:'Step',created_at:'now',updated_at:'now'});
  assert.equal(tx.insert('actions',{id:'another-id',event_id:'a',idx:0,text:'Duplicate',created_at:'now',updated_at:'now'},{conflict:['event_id','idx'],ignore:true}).changes,0);
  assert.equal(tx.select('actions').length,1);
});
