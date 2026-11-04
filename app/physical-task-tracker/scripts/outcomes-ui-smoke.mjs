/** Outcome UI check through real request handlers, no listening server; synthetic measurements only. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from '../dist/serve-dashboard.js';
import { outcomeView } from '../dist/lib/outcomes.js';
const {chromium}=createRequire(import.meta.url)('playwright');
const out=resolve(process.argv[2]||'./outcomes-ui-qa');await mkdir(out,{recursive:true});
const parent=await mkdtemp(join(tmpdir(),'outcomes-ui-')),root=join(parent,'project');let browser;
try {
  await promisify(execFile)(process.execPath,[fileURLToPath(new URL('./replay-outcomes.mjs',import.meta.url)),root]);
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  const handler=createServer(root).listeners('request')[0],html=await readFile(new URL('../dist/dashboard/index.html',import.meta.url),'utf8');
  await page.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());if(url.pathname==='/')return route.fulfill({status:200,contentType:'text/html',body:html});let status=500,headers={},body='';await handler({method:req.method(),url:url.pathname+url.search,async *[Symbol.asyncIterator](){const data=req.postDataBuffer();if(data)yield data;}},{writeHead(c,h){status=c;headers=h;},end(b=''){body=b;}});await route.fulfill({status,headers,body});});
  await page.goto('http://localhost/');await page.getByRole('tab',{name:'Plan',exact:true}).click();await page.locator('[data-outcome]').first().click();
  await page.getByRole('heading',{name:'Measured comparison'}).waitFor();assert.equal(outcomeView(root).trials[0].result.status,'worse');
  await page.getByText('Record follow-up or correct measurements',{exact:true}).click();const form=page.locator('#outcomevisitform');const followup=outcomeView(root).trials[0].trial.followups[0];await form.locator('[name=visit_id]').selectOption(followup.id);
  await form.locator('[data-measure] [name=value]').fill('40');await form.locator('[name=reason]').fill('Synthetic user corrects total time');const saved=page.waitForResponse(r=>r.url().endsWith('/api/outcomes')&&r.request().method()==='POST');await form.getByRole('button',{name:'Save measurements'}).click();assert.equal((await saved).status(),200);await page.locator('#outcomestatus').filter({hasText:'Saved.'}).waitFor();assert.equal(outcomeView(root).trials[0].result.status,'unchanged');assert.equal(outcomeView(root).trials[0].result.latest_decision.current,false);
  const decision=page.locator('#outcomedecisionform');await decision.locator('[name=reason]').fill('Synthetic revised method');await decision.locator('[name=revision_plan]').fill('Change holder and retest');const decided=page.waitForResponse(r=>r.url().endsWith('/api/outcomes')&&r.request().method()==='POST');await decision.getByRole('button',{name:'Revise and retest'}).click();assert.equal((await decided).status(),200);
  await page.reload();await page.getByRole('tab',{name:'Plan',exact:true}).click();await page.locator('[data-outcome]').first().click();await page.getByText('Change holder and retest',{exact:false}).first().waitFor();assert.equal(outcomeView(root).trials[0].result.latest_decision.decision,'revise');
  for(const [width,height] of [[390,844],[1440,900],[320,844]]){await page.setViewportSize({width,height});await page.locator('#outcomedetail').scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:join(out,`outcomes-${width}.png`),fullPage:true});}
  assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,checks:['comparison','correction','stale decision','revise','reload','390/1440/320 bounds'],screenshots:out}));
} finally {await browser?.close();await rm(parent,{recursive:true,force:true});}
