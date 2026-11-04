/** Browser checks through the real request handler; synthetic data, no listening HTTP server. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { lifecycleFixture } from '../dist/lib/lifecycle-fixture.js';
import { createServer } from '../dist/serve-dashboard.js';
const {chromium}=createRequire(import.meta.url)('playwright'),out=process.argv[2];
if(!out||!isAbsolute(out))throw Error('Pass an absolute screenshot directory.');
await mkdir(out,{recursive:true});const root=await mkdtemp(join(tmpdir(),'lifecycle-browser-'));let browser;
try{
 const f=await lifecycleFixture(root);f.follow(f.trial);
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));const handler=createServer(root).listeners('request')[0];
 await page.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());let status=500,headers={},body='';await handler({method:request.method(),url:url.pathname+url.search,async *[Symbol.asyncIterator](){const data=request.postDataBuffer();if(data)yield data;}},{writeHead(c,h){status=c;headers=h;},end(value=''){body=value;}});await route.fulfill({status,headers,body});});
 await page.goto('http://localhost/#workspace');await page.locator('#lifecyclecapture [name=visit] option').nth(2).waitFor({state:'attached'});await page.locator('#lifecyclesection > summary').click();const form=page.locator('#lifecyclecapture');
 await form.locator('[name=visit]').selectOption({index:2});await form.locator('[name=mode]').selectOption('synthetic');await form.locator('[name=expected_status]').selectOption('improved');await form.locator('[name=reviewer]').fill('Synthetic reviewer');await form.locator('[name=reason]').fill('Synthetic stopwatch measurements; no farmer validation');await form.locator('[name=metadata_export]').check();await form.locator('button').click();await page.locator('#lifecyclelist .task-card').waitFor();
 assert.match(await page.locator('#lifecyclelist').innerText(),/Observed use: reported as performed/);assert.match(await page.locator('#lifecyclelist').innerText(),/Subsequent state: unknown/);await page.reload();await page.locator('#lifecyclesection > summary').click();await page.locator('#lifecyclelist .task-card').waitFor();
 for(const [width,height]of [[390,844],[1440,900],[320,844]]){await page.setViewportSize({width,height});await page.locator('#lifecyclesection').scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:join(out,`lifecycle-${width}.png`),fullPage:true});}
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,mode:'synthetic data; real UI and request handler',screenshots:out}));
}finally{await browser?.close();await rm(root,{recursive:true,force:true});}
