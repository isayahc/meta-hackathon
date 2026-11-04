/** Real DOM + real handlers/persistence, injected synthetic model response; never listens. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../dist/serve-dashboard.js';
import { journeyView } from '../dist/lib/journey.js';
const {chromium}=createRequire(import.meta.url)('playwright');
const out=resolve(process.argv[2]);await mkdir(out);const root=await mkdtemp(join(tmpdir(),'journey-ui-'));let browser;
try{
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const handler=createServer(root,{scanRunner:async()=>({observed_task:'Synthetic tray preparation',per_frame:['Fill tray with shovel'],frame_times_s:[1],video_duration_s:10,unknowns:['Unseen activity unknown'],model:'synthetic injected response',prompt_version:'ui-check/1'})}).listeners('request')[0];
 await page.route('**/*',async route=>{const r=route.request(),u=new URL(r.url());let status=500,headers={},body='';await handler({method:r.method(),url:u.pathname+u.search,async *[Symbol.asyncIterator](){const data=r.postDataBuffer();if(data)yield data;}},{writeHead(c,h){status=c;headers=h;},end(b=''){body=b;}});await route.fulfill({status,headers,body});});
 await page.goto('http://localhost/');await page.getByRole('heading',{name:'Record or upload your work',exact:true}).waitFor();
 await page.locator('#journeycaptureform input[type=file]').setInputFiles({name:'synthetic.mp4',mimeType:'video/mp4',buffer:Buffer.from('Synthetic non-playable fixture')});await page.getByRole('button',{name:'Upload and review work'}).click();
 await page.locator('#journeydetail').getByText('Fill tray with shovel',{exact:false}).first().waitFor();assert.equal(journeyView(root).planning.tasks.length,0);
 await page.locator('#journeydetail summary').filter({hasText:'Correct this interpretation'}).first().click();const correction=page.locator('[data-jcommand=correct]').first();await correction.locator('[name=label]').fill('Fill tray using the scoop');await correction.locator('[name=reason]').fill('Synthetic operator corrects tool');await correction.getByRole('button').click();await page.locator('#journeystatus').filter({hasText:'Saved.'}).waitFor();
 await page.reload();await page.locator('#journeydetail').getByText('Fill tray using the scoop',{exact:false}).first().waitFor();
 const review=page.locator('[data-jcommand=review]').first();await review.locator('[name=reason]').fill('Reviewed partial footage');await review.getByRole('button').click();await page.locator('[data-jcommand=goal]').waitFor();
 const goal=page.locator('[data-jcommand=goal]');await goal.locator('[name=text]').fill('Prepare 50 trays');await goal.locator('[name=criteria]').fill('50 inspected trays');await goal.locator('[name=desire]').fill('None for now');await goal.locator('[name=reason]').fill('Synthetic desired outcome');await goal.getByRole('button').click();await page.locator('[data-jcommand=method]').waitFor();
 const method=page.locator('[data-jcommand=method]').last();await method.locator('[name=reason]').fill('No supported intervention yet');await method.getByRole('button').click();await page.locator('[data-jcommand=task]').waitFor();
 const future=page.locator('[data-jcommand=task]');await future.locator('[name=text]').fill('Fill 50 trays');await future.locator('[name=criteria]').fill('50 inspected filled trays');await future.locator('[name=goals]').selectOption(journeyView(root).planning.goals[0].id);await future.locator('[name=contribution]').fill('Provides trays');await future.locator('[name=minutes]').fill('60');await future.locator('[name=estimate]').fill('Synthetic operator estimate');await future.locator('[name=future]').check();await future.locator('[name=reason]').fill('Explicit future work');await future.getByRole('button').click();await page.locator('#journeystatus').filter({hasText:'Saved.'}).waitFor();assert.equal(journeyView(root).planning.tasks.length,1);
 await page.locator('#journeydetail [data-opentask]').first().click();await page.locator('#taskeditform').waitFor();await page.reload();await page.locator('#taskeditform').waitFor();await page.goBack();await page.getByRole('tab',{name:'Today',exact:true}).click();await page.locator('#journeydetail').waitFor();
 for(const [width,height]of [[390,844],[1440,900],[320,844]]){await page.setViewportSize({width,height});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:join(out,`journey-${width}.png`),fullPage:true});}
 assert.deepEqual(errors,[]);console.log(JSON.stringify({passed:true,mode:'injected synthetic interpretation; no live inference or video playback validation',screenshots:out,checks:['capture before setup','correction reload','goal confirmation','explicit future task','task route reload','mobile/desktop bounds']}));
}finally{await browser?.close();await rm(root,{recursive:true,force:true});}
