/** Exercise review/reload/manual correction through the real HTTP handler, without a listening port. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../dist/serve-dashboard.js';
import { createTask, planningView } from '../dist/lib/task-planning.js';
import { ingestEvidence, beginInterpretation, finishInterpretation, associateEvidence, proposeChange, reconciliationView } from '../dist/lib/reconciliation.js';
const {chromium}=createRequire(import.meta.url)('playwright');
const out=resolve(process.argv[2]||'./reconciliation-ui-qa');await mkdir(out,{recursive:true});
const root=await mkdtemp(join(tmpdir(),'reconcile-ui-'));let browser;
try {
  const task=createTask(root,{text:'Fill trays',completion_criteria:'50 inspected trays',active_minutes:30,estimate_source:'Synthetic fixture',quantity:{total:50,remaining:50,unit:'trays'}},'ui');
  let s=ingestEvidence(root,{kind:'manual',request_id:'fixture',report:'Synthetic review fixture',context:{task_ids:[task.id]}});
  s=beginInterpretation(root,s.id,s.revision);s=finishInterpretation(root,s.id,s.processing.token,{origin:'replay',model:'synthetic fixture',prompt_version:'ui/1',observations:[{id:'o1',text:'Some trays filled',start_s:null,end_s:null,coverage:'human_report',confidence:'unknown',uncertainty:'Confirm remaining count'}]});
  s=associateEvidence(root,s.id,s.revision,task.id,'confirmed','Fixture identifies task');s=proposeChange(root,s.id,s.revision,{task_id:task.id,observation_id:'o1',kind:'progress',patch:{execution:'paused'},quantity_mode:'remaining',quantity_value:30,unit:'trays',reason:'Synthetic count'});
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
  const page=await browser.newPage({viewport:{width:390,height:844}}), errors=[];page.on('pageerror',e=>errors.push(e.message));
  const handler=createServer(root).listeners('request')[0],html=await readFile(new URL('../dist/dashboard/index.html',import.meta.url),'utf8');
  await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.pathname==='/')return route.fulfill({status:200,contentType:'text/html',body:html});let status=500,headers={},body='';await handler({method:req.method(),url:url.pathname+url.search,async *[Symbol.asyncIterator](){const data=req.postDataBuffer();if(data)yield data;}},{writeHead(c,h){status=c;headers=h;},end(b=''){body=b;}});await route.fulfill({status,headers,body});});
  await page.goto('http://localhost/');await page.getByRole('tab',{name:'Plan',exact:true}).click();await page.locator('[data-update]').first().click();
  const form=page.locator('[data-review]').first();await form.locator('[name=reason]').fill('Synthetic operator verifies remaining total');await form.locator('[name=current]').check();await form.locator('[name=remaining]').fill('28');
  const saved=page.waitForResponse(r=>r.url().endsWith('/api/reconciliation')&&r.request().method()==='POST');await form.locator('[value=corrected]').click();assert.equal((await saved).status(),200);
  await page.locator('#updatestatus').filter({hasText:'Saved.'}).waitFor();assert.equal(planningView(root).tasks[0].quantity.remaining,28);
  await page.reload();await page.getByRole('tab',{name:'Plan',exact:true}).click();await page.locator('[data-update]').first().click();await page.getByText('Applied; goal outcome and accepted schedule remain separate.',{exact:true}).waitFor();
  assert.equal(reconciliationView(root).sources.length,1);assert.equal(planningView(root).tasks.length,1);
  for(const [width,height] of [[390,844],[1440,900],[320,844]]){await page.setViewportSize({width,height});await page.locator('#updatedetail').scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:join(out,`reconciliation-${width}.png`),fullPage:true});}
  await page.locator('#refreshupdates').focus();await page.keyboard.press('Enter');await page.locator('#updatestatus').filter({hasText:'Saved.'}).waitFor();assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,checks:['correct and apply','reload','no duplicate tasks','keyboard refresh','390/1440/320 bounds'],screenshots:out}));
}finally{await browser?.close();await rm(root,{recursive:true,force:true});}
