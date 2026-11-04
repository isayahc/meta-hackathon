import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, Script } from 'node:vm';

const html = readFileSync(new URL('./dashboard/index.html', import.meta.url), 'utf8');
const script = html.split('<script>')[1]!.split('</script>')[0]!;
/** Compile the actual dashboard function, without duplicating its implementation. */
function definition(name: string): string {
  const lines = script.slice(script.indexOf(`function ${name}(`)).split('\n');
  let source = '';
  for (const line of lines) {
    source += line + '\n';
    try { new Script(`(${source})`); return source; } catch { /* Continue through the body. */ }
  }
  throw new Error(`Function not found: ${name}`);
}
/** Isolate view logic from DOM rendering; browser layout is covered by the smoke script. */
function context(names: string[], values: Record<string, unknown> = {}) {
  const ctx = createContext(values);
  for (const name of names) new Script(definition(name)).runInContext(ctx);
  return ctx;
}

test('dashboard script parses and exposes four destinations with matching tab panels', () => {
  new Script(script);
  const tabs = [...html.split('<main')[0]!.matchAll(/role="tab" data-view="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(tabs, ['today', 'plan', 'cal', 'space']);
  for (const tab of tabs) assert.match(html, new RegExp(`id="view-${tab}"[^>]*role="tabpanel"`));
  assert.match(html, /<dialog[^>]+id="capturedialog"[^>]+aria-labelledby="captureheading"/);
});

test('every calendar overflow and entry is an actionable native button with distinct semantics', () => {
  const ctx = context(['esc', 'isoDay', 'evChip', 'calCell']);
  const entries = ['task', 'task', 'scan', 'goal', 'actual'].map((kind, i) => ({ kind, id: String(i), title: '<work>', scheduling: i === 0 ? 'accepted' : 'proposed' }));
  ctx.entries = entries;
  const cell = new Script("calCell(new Date(2030,0,10),{'2030-01-10':entries})").runInContext(ctx) as string;
  assert.match(cell, /<button[^>]+data-day="2030-01-10">\+2 more/);
  assert.equal((cell.match(/data-eid=/g) ?? []).length, 3);
  assert.match(cell, /Accepted work/); assert.match(cell, /Proposed work/); assert.match(cell, /Past observation/);
  assert.ok(!cell.includes('<work>'));
  assert.match(new Script('evChip(entries[4],true)').runInContext(ctx), /Recorded actual work/);
});

test('route restoration cannot push history and canonical links retain their identity', () => {
  const calls: string[] = [];
  const ctx = context(['journeyRoute'], { uiState: { routeLoading: false }, location: { hash: '' }, history: { pushState: (_a: unknown, _b: unknown, hash: string) => calls.push(hash) } });
  new Script("journeyRoute('plan','task','task/a');uiState.routeLoading=true;journeyRoute('space','workflow','w')").runInContext(ctx);
  assert.deepEqual(calls, ['#goals/task/task%2Fa']);
});

test('actual calendar entries use project timezone and confirmed goal links without making reservations', () => {
  const state = { schedule: { config: { timezone: 'America/Los_Angeles' } }, tasks: [{ id: 't', text: 'Work', links: [{goal_id:'g',review:'confirmed'},{goal_id:'suggested',review:'proposed'}], actuals: [{ id:'a',start:'2030-01-11T01:00:00Z',end:'2030-01-11T01:30:00Z',outcome:'Partial' }] }] };
  const ctx = context(['actualCalendarEntries'], { state });
  const events = JSON.parse(new Script('JSON.stringify(actualCalendarEntries(state))').runInContext(ctx));
  assert.equal(events[0].date, '2030-01-10');assert.equal(events[0].time,'17:00');
  assert.deepEqual(events[0].goal_ids,['g']);assert.equal(events[0].kind,'actual');assert.equal(events[0].scheduling,undefined);
});

test('proposal diff preserves pinned commitments and does not duplicate accepted plan blocks', () => {
  const ctx = context(['esc','planDiff'], {formatPlanningTime:(s:string)=>s});
  ctx.schedule={blocks:[{id:'a',task_id:'t',start:'09:00',end:'10:00',status:'accepted',pinned:true}]};
  ctx.plan={blocks:[{id:'a',task_id:'t',start:'09:00',end:'10:00'},{id:'b',task_id:'u',start:'11:00',end:'12:00'}],explanations:[{task_id:'u',reason:'Fits available time'}]};
  const output=new Script('planDiff(plan,schedule,id=>id)').runInContext(ctx) as string;
  assert.equal((output.match(/<tr>/g)??[]).length,3);assert.match(output,/Preserved · pinned/);assert.match(output,/Fits available time/);
});

test('human-readable results escape content and keep internal identifiers out of ordinary summaries', () => {
  const ctx=context(['esc','readableValue']);ctx.result={observations:['<script>'],source_id:'private-id',model:'internal-model',uncertainty:'Unseen work'};
  const output=new Script('readableValue(result)').runInContext(ctx) as string;
  assert.match(output,/&lt;script&gt;/);assert.match(output,/Unseen work/);assert.ok(!output.includes('private-id'));assert.ok(!output.includes('internal-model'));
});

test('form drafts restore text, choices and retry IDs, but never overwrite a newer revision', () => {
  const storage=new Map<string,string>();const messages:string[]=[];
  const form={id:'taskeditform',dataset:{id:'t',revision:'1',requestId:'r'},matches:()=>false,elements:[{name:'reason',type:'text',value:'Keep my correction'}]};
  const ctx=context(['draftKey','draftVersion','draftFields','saveFormDraft','clearFormDraft','restoreFormDrafts'],{location:{pathname:'/'},document:{forms:[form]},activeForms:new WeakSet(),activeDraftKeys:new Set(),sessionStorage:{setItem:(k:string,v:string)=>storage.set(k,v),getItem:(k:string)=>storage.get(k),removeItem:(k:string)=>storage.delete(k)},setStatus:(s:string)=>messages.push(s)});
  ctx.form=form;new Script('saveFormDraft(form)').runInContext(ctx);form.elements[0]!.value='';new Script('restoreFormDrafts()').runInContext(ctx);assert.equal(form.elements[0]!.value,'Keep my correction');
  form.dataset.revision='2';form.elements[0]!.value='Latest value';new Script('restoreFormDrafts()').runInContext(ctx);assert.equal(form.elements[0]!.value,'Latest value');assert.equal(storage.size,0);assert.match(messages[0]!,/Saved data changed/);
});

test('spatial evidence cards expose uncertainty and disable missing media without claiming a current identity',()=>{
  const ctx=context(['esc','spatialCard']);ctx.view={association:{id:'a',revision:2,source:{start_s:4,end_s:6},review:'ambiguous',reason:'Two similar benches',target:{kind:'spot',spot_id:'bench'},history:[]},step_label:'<Untrusted action>',process_title:'Tray preparation',target_label:'Bench',current:false,evidence_url:null,spatial:null,issues:[{code:'media_missing',message:'Source unavailable'}]};
  const output=new Script('spatialCard(view)').runInContext(ctx) as string;
  assert.match(output,/&lt;Untrusted action&gt;/);assert.match(output,/Location needs review/);assert.match(output,/data-spatialplay="a" disabled/);assert.match(output,/Two similar benches/);assert.match(output,/Source unavailable/);assert.match(output,/Keep unresolved/);assert.match(output,/Confirming identity does not update pinned revisions/);
});

test('location evidence filters keep process and named-area context separate',()=>{
  const nodes:Record<string,{value:string;innerHTML?:string}>={spatialspotfilter:{value:'bench'},spatialprocessfilter:{value:'p1'},spatiallinks:{value:''}};
  const associations=[{association:{source:{process_id:'p1'},target:{kind:'spot',spot_id:'bench'}}},{association:{source:{process_id:'p2'},target:{kind:'spot',spot_id:'bench'}}},{association:{source:{process_id:'p1'},target:{kind:'oi'}}}];
  const ctx=context(['renderSpatialLinks'],{$:(id:string)=>nodes[id],spatialState:{associations},spatialCard:()=>'<article>match</article>'});new Script('renderSpatialLinks()').runInContext(ctx);assert.equal(nodes.spatiallinks.innerHTML,'<article>match</article>');nodes.spatialspotfilter.value='';new Script('renderSpatialLinks()').runInContext(ctx);assert.equal(nodes.spatiallinks.innerHTML,'<article>match</article><article>match</article>');
});

test('lifecycle cards escape annotations and separate proposed, accepted, performed and unknown state',()=>{
 const entry={episode:{role:'followup',mode:'synthetic',revision:2,visit_id:'after',trial:{assessment:{candidate:{change:'Move <bench>'},decision:'accepted'},baseline:null,followups:[{id:'after',context:{intervention_applied:null},measurements:[{kind:'estimated',value:12,unit:'min'}],workload:{amount:10,unit:'tray'}}]},transition:{proposed_action:'Move <bench>'},review:{reviewer:'<script>',reason:'Unknown use',expected_status:'inconclusive'},permissions:{metadata_export:false}},issues:['Process revision stale']};
 const ctx=context(['esc','lifecycleCard'],{entry});const result=new Script('lifecycleCard(entry)').runInContext(ctx) as string;assert.match(result,/&lt;script&gt;/);assert.match(result,/Decision: accepted/);assert.match(result,/Observed use: unknown/);assert.match(result,/Subsequent state: unknown/);assert.match(result,/estimated: 12 min/);assert.match(result,/Needs review/);assert.match(result,/Export permission not granted/);assert.match(html,/Observe → Review → Suggest → Try → Check/);
});
