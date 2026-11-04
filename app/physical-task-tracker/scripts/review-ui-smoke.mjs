/** Real DOM + real handlers/persistence, injected synthetic model response; never listens. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../dist/serve-dashboard.js';
import { journeyView } from '../dist/lib/journey.js';
const {chromium}=createRequire(import.meta.url)('playwright');
const out=resolve(process.argv[2]);await mkdir(out);const root=await mkdtemp(join(tmpdir(),'journey-ui-'));let browser;
try{
 const fixture=join(out,'synthetic.mp4');execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','testsrc=size=240x320:rate=8','-t','2','-pix_fmt','yuv420p',fixture]);
 browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const handler=createServer(root,{scanRunner:async()=>({observed_task:'Reassemble and test a spray bottle',stage:'Spraying observed; functionality unknown',per_frame:['Attach nozzle','Press nozzle; mist visible'],frame_times_s:[0.5,1.5],video_duration_s:2,unknowns:['Unseen activity unknown'],model:'synthetic injected response',prompt_version:'ui-check/1'})}).listeners('request')[0];
 let releasePreviews;const previewGate=new Promise(resolve=>releasePreviews=resolve);
 await page.route('**/*',async route=>{const r=route.request(),u=new URL(r.url());let status=500,headers={},body='';if(u.pathname==='/api/review-previews')await previewGate;await handler({method:r.method(),url:u.pathname+u.search,async *[Symbol.asyncIterator](){const data=r.postDataBuffer();if(data)yield data;}},{writeHead(c,h){status=c;headers=h;},end(b=''){body=b;}});await route.fulfill({status,headers,body});});
 await page.goto('http://localhost/');await page.locator('#globalrecordwork').click();await page.getByRole('heading',{name:'Record or upload your work',exact:true}).waitFor();
 await page.locator('#journeycaptureform input[name=file]').setInputFiles({name:'synthetic.mp4',mimeType:'video/mp4',buffer:await readFile(fixture)});await page.getByRole('button',{name:'Upload and review work'}).click();
 await page.locator('#journeydetail').getByText('Attach nozzle',{exact:true}).first().waitFor();assert.equal((await journeyView(root)).planning.tasks.length,0);const editor=page.getByText('Correct this interpretation',{exact:true});await editor.click();await page.locator('[data-jcommand=correct] [name=reason]').fill('Draft survives GIF arrival');releasePreviews();await page.locator('.segment-preview img').waitFor();assert.equal(await page.locator('[data-jcommand=correct] [name=reason]').inputValue(),'Draft survives GIF arrival');assert.equal(await page.locator('[data-jcommand=correct]').isVisible(),true);await editor.click();await page.waitForFunction(()=>document.querySelector('.segment-preview img')?.naturalWidth>0);

 assert.equal(await page.locator('#updatessection').isVisible(),false);assert.equal(await page.locator('#areassection').isVisible(),false);assert.equal(await page.locator('#outcomessection').isVisible(),false);
 for(const [width,height] of [[1440,900],[390,844],[320,844]]){
  await page.setViewportSize({width,height});await page.locator('#journeydetail .journey-guidance').evaluate(e=>e.scrollIntoView({block:'start'}));
  await page.screenshot({path:join(out,`review-${width}.png`)});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  if(width===1440){const bounds=await page.locator('[data-jcommand=review] button').boundingBox();assert.ok(bounds.y+bounds.height<height,'Confirm action is above the fold');assert.equal(await page.evaluate(()=>document.documentElement.scrollHeight>innerHeight),false,'Default desktop review fits the viewport');}
 }
 await page.setViewportSize({width:1440,height:900});
 const firstGif=await page.locator('.segment-preview img').getAttribute('src');await page.getByRole('button',{name:'Next',exact:true}).click();assert.notEqual(await page.locator('.segment-preview img').getAttribute('src'),firstGif);await page.getByText('Press nozzle; mist visible',{exact:true}).waitFor();
 assert.equal(await page.getByText('Attach nozzle',{exact:true}).isVisible(),false);
 await page.getByText('Outcome and task name',{exact:true}).click();
 const summary=page.locator('[data-jcommand=summary]');await summary.locator('[name=title]').fill('Test spray bottle');await summary.locator('[name=outcome]').fill('Mist visible; durability untested');await summary.locator('[name=reason]').fill('Limit outcome to visible evidence');await summary.getByRole('button').click();
 await page.locator('#journeystatus').filter({hasText:'Saved.'}).waitFor({state:'attached'});
 const review=page.locator('[data-jcommand=review]');await review.locator('[name=reason]').fill('Reviewed visible evidence and limits');await review.getByRole('button').click();
 await page.getByRole('button',{name:'Finish here',exact:true}).click();await page.getByRole('heading',{name:'Saved — you can stop here',exact:true}).waitFor();
 await page.reload();await page.getByRole('heading',{name:'Saved — you can stop here',exact:true}).waitFor();
 assert.equal((await journeyView(root)).planning.tasks.length,0);assert.equal((await journeyView(root)).planning.goals.length,0);
 assert.equal((await journeyView(root)).planning.schedule.blocks.length,0);
 await page.getByRole('button',{name:'Revisit next action',exact:true}).click();await page.getByRole('heading',{name:'What next?',exact:true}).waitFor();
 for(const [width,height] of [[1440,900],[390,844],[320,844]]){await page.setViewportSize({width,height});await page.screenshot({path:join(out,`next-${width}.png`)});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);const bounds=await page.getByRole('button',{name:'Finish here',exact:true}).boundingBox();assert.ok(bounds.y+bounds.height<height,'Next choice above fold');}
 await page.setViewportSize({width:1440,height:900});
 await page.getByRole('button',{name:'View on calendar',exact:true}).click();await page.getByText('Video observation',{exact:true}).waitFor();await page.locator('[data-eid^="observation-"]').click();await page.getByRole('button',{name:'Open recording and next action',exact:true}).click();
 await page.getByRole('button',{name:'Do next',exact:true}).click();await page.getByRole('button',{name:'Open task',exact:true}).waitFor();assert.equal((await journeyView(root)).planning.tasks.length,1);assert.equal((await journeyView(root)).planning.schedule.blocks.length,0);
 await page.reload();await page.getByRole('button',{name:'Open task',exact:true}).waitFor();
 assert.equal((await journeyView(root)).workflows[0].clips[0].source.interpretations.length,1,'Preview generation never reruns analysis');
 await page.getByRole('button',{name:'← All workflows',exact:true}).click();await page.locator('#workflowsection').waitFor();assert.equal(await page.locator('#journeydetail').isVisible(),false);await page.getByRole('button',{name:'Work areas',exact:true}).click();await page.locator('#areassection').waitFor();assert.equal(await page.locator('#updatessection').isVisible(),false);
 for(const [i,label] of ['Do next','Later','Already done','Finish here'].entries()){
  await page.locator('#globalrecordwork').click();await page.locator('#journeycaptureform [name=context]').selectOption('new');
  await page.locator('#journeycaptureform input[name=file]').setInputFiles({name:`fresh-${i}.mp4`,mimeType:'video/mp4',buffer:Buffer.concat([await readFile(fixture),Buffer.from(`case-${i}`)])});
  await page.getByRole('button',{name:'Upload and review work'}).click();await page.locator('[data-jcommand=review] button').click();
  await page.getByRole('button',{name:label,exact:true}).click();await page.getByRole('heading',{name:'Saved — you can stop here',exact:true}).waitFor();
  await page.reload();await page.getByRole('heading',{name:'Saved — you can stop here',exact:true}).waitFor();
 }
 assert.deepEqual(errors,[]);console.log('PASS: step GIFs, optional corrections, zero-typing upload → review → all four choices, reload persistence, dated calendar navigation; synthetic inference with real FFmpeg.');
}finally{await browser?.close();await rm(root,{recursive:true,force:true});}
