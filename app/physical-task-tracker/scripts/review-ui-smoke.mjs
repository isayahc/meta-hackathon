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
 const handler=createServer(root,{scanRunner:async()=>({observed_task:'Reassemble and test a spray bottle',stage:'Spraying observed; functionality unknown',per_frame:['Attach nozzle','Press nozzle; mist visible'],frame_times_s:[1,5],video_duration_s:10,unknowns:['Unseen activity unknown'],model:'synthetic injected response',prompt_version:'ui-check/1'})}).listeners('request')[0];
 await page.route('**/*',async route=>{const r=route.request(),u=new URL(r.url());let status=500,headers={},body='';await handler({method:r.method(),url:u.pathname+u.search,async *[Symbol.asyncIterator](){const data=r.postDataBuffer();if(data)yield data;}},{writeHead(c,h){status=c;headers=h;},end(b=''){body=b;}});await route.fulfill({status,headers,body});});
 await page.goto('http://localhost/');await page.locator('#globalrecordwork').click();await page.getByRole('heading',{name:'Record or upload your work',exact:true}).waitFor();
 await page.locator('#journeycaptureform input[name=file]').setInputFiles({name:'synthetic.mp4',mimeType:'video/mp4',buffer:Buffer.from('Synthetic non-playable fixture')});await page.getByRole('button',{name:'Upload and review work'}).click();
 await page.locator('#journeydetail').getByText('Attach nozzle',{exact:false}).first().waitFor();assert.equal(journeyView(root).planning.tasks.length,0);

 for(const [width,height] of [[1440,900],[390,844],[320,844]]){
  await page.setViewportSize({width,height});await page.locator('#journeydetail .journey-guidance').evaluate(e=>e.scrollIntoView({block:'start'}));
  await page.screenshot({path:join(out,`review-${width}.png`)});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  if(width===1440){const bounds=await page.locator('[data-jcommand=review] button').boundingBox();assert.ok(bounds.y+bounds.height<height,'Confirm action is above the fold');}
 }
 await page.setViewportSize({width:1440,height:900});
 await page.locator('.observation-nav button').nth(1).click();await page.getByText('Press nozzle; mist visible',{exact:true}).waitFor();
 assert.equal(await page.getByText('Attach nozzle',{exact:true}).isVisible(),false);
 await page.getByText('Edit task name and inferred outcome',{exact:true}).click();
 const summary=page.locator('[data-jcommand=summary]');await summary.locator('[name=title]').fill('Test spray bottle');await summary.locator('[name=outcome]').fill('Mist visible; durability untested');await summary.locator('[name=reason]').fill('Limit outcome to visible evidence');await summary.getByRole('button').click();
 await page.locator('#journeystatus').filter({hasText:'Saved.'}).waitFor();
 const review=page.locator('[data-jcommand=review]');await review.locator('[name=reason]').fill('Reviewed visible evidence and limits');await review.getByRole('button').click();
 await page.getByRole('button',{name:'Save observation only',exact:true}).click();await page.getByRole('heading',{name:'Observation saved',exact:true}).waitFor();
 await page.reload();await page.getByRole('heading',{name:'Observation saved',exact:true}).waitFor();
 assert.equal(journeyView(root).planning.tasks.length,0);assert.equal(journeyView(root).planning.goals.length,0);
 assert.equal(journeyView(root).planning.schedule.blocks.length,0);
 await page.getByRole('button',{name:'Continue to goals and planning',exact:true}).click();await page.locator('[data-jcommand=goal]').waitFor();
 assert.deepEqual(errors,[]);console.log('PASS: compact review, step navigation, summary correction, save-only reload, resume planning; synthetic inference.');
}finally{await browser?.close();await rm(root,{recursive:true,force:true});}
