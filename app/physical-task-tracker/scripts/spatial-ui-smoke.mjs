/** Browser integration using real HTTP handlers and synthetic OI/video fixtures; no listening server. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createServer } from '../dist/serve-dashboard.js';
import { buildProcessFromScan, saveRevision } from '../dist/lib/processes.js';
import { initSpot } from '../dist/lib/spot-state.js';
import { linkOiEntities } from '../dist/lib/oi-links.js';
import { listSpatialAssociations } from '../dist/lib/spatial-evidence.js';
const {chromium}=createRequire(import.meta.url)('playwright'), execute=promisify(execFile);
if(!process.argv[2])throw new Error('Pass an absolute screenshot output directory.');
const out=resolve(process.argv[2]);await mkdir(out,{recursive:true});const root=await mkdtemp(join(tmpdir(),'spatial-browser-'));let browser;
try{
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||undefined});
  await mkdir(join(root,'media'));await execute(process.env.FFMPEG||'ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=green:s=160x120:d=10','-c:v','libx264','-pix_fmt','yuv420p',join(root,'media','synthetic.mp4')]);
  const p=buildProcessFromScan({id:'spatial-demo',analysis:{observed_task:'Synthetic tray preparation',per_frame:['Fill trays at station'],frame_times_s:[2]},media:'synthetic.mp4',eventId:'synthetic',duration_s:10});p.steps[0].evidence.spans=[{start_s:2,end_s:6}];await saveRevision(root,p);await initSpot(root,'bench','Potting bench');
  const scene='11111111-1111-4111-8111-111111111111';await linkOiEntities(root,'spot','bench',[{scene_id:scene,revision:1,oi_entity_id:'scene'}]);let head=1;
  const handler=createServer(root,{spatialReader:async reference=>({scene_id:scene,revision:reference.revision,head_revision:head,name:'Synthetic OI room',entity_state:'present',head_entity_state:head===3?'missing':'present',changed:head>reference.revision,scale:'unknown',scale_reason:'Synthetic scale remains unverified.',revision_url:`http://localhost:5173/?sceneId=${scene}&revision=${reference.revision}`,head_url:`http://localhost:5173/?sceneId=${scene}`,entities:[{id:'station',name:'Tray station',kind:'instance'}],mock:true})}).listeners('request')[0];
  const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',async route=>{const request=route.request(),url=new URL(request.url());let status=500,headers={},body='';await handler({method:request.method(),url:url.pathname+url.search,async *[Symbol.asyncIterator](){const data=request.postDataBuffer();if(data)yield data;}},{writeHead(c,h){status=c;headers=h;},end(value=''){body=value;}});await route.fulfill({status,headers,body});});
  await page.goto('http://localhost/#workspace');await page.locator('#spatialform [name=process_id] option').first().waitFor({state:'attached'});await page.locator('#spatialeditor > summary').click();
  const form=page.locator('#spatialform');await form.locator('[name=target_kind]').selectOption('oi');await form.locator('[name=saved_scene]').selectOption({index:1});await page.locator('#inspectspatial').click();await form.locator('[name=oi_choice]').selectOption('station');await form.locator('[name=start_s]').fill('3');await form.locator('[name=end_s]').fill('5');await form.locator('[name=reason]').fill('Synthetic operator identifies the tray station');await form.locator('[type=submit]').click();
  await page.locator('#spatialplayback video').waitFor();await page.waitForFunction(()=>document.querySelector('#spatialplayback video')?.readyState>=1);assert.ok(Math.abs(await page.locator('#spatialplayback video').evaluate(v=>v.currentTime)-3)<.2);
  assert.equal((await listSpatialAssociations(root)).length,1);assert.equal((await listSpatialAssociations(root))[0].target.entity_id,'station');
  await page.reload();await page.locator('#spatialplayback video').waitFor();assert.match(await page.locator('#spatiallinks a').first().getAttribute('href'),/revision=1$/);
  head=2;await page.locator('#refreshspatial').click();await page.getByText('OI is now at revision 2',{exact:false}).waitFor();await page.getByText('OI reports different instance/asset metadata',{exact:false}).waitFor();assert.equal((await listSpatialAssociations(root))[0].target.revision,1);
  const review=page.locator('.spatialreview').first();await review.locator('[name=reason]').fill('Similar station; identity needs another look');await review.locator('[value=ambiguous]').click();await page.getByText('Cross-visit identity is unresolved.',{exact:false}).waitFor();
  head=3;await page.locator('#refreshspatial').click();await page.getByText('The entity is absent from the current scene.',{exact:false}).waitFor();assert.equal((await listSpatialAssociations(root)).length,1);
  for(const [width,height]of [[390,844],[1440,900],[320,844]]){await page.setViewportSize({width,height});await page.locator('#spatialevidencesection').scrollIntoViewIfNeeded();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:join(out,`spatial-${width}.png`),fullPage:true});}
  await page.locator('[data-spatialplay]').first().focus();await page.keyboard.press('Enter');await page.locator('#spatialplayback video').waitFor();assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,mode:'synthetic colored video and OI responses; real HTTP/SQLite',screenshots:out,checks:['manual association','exact timestamp seek','reload','moved/deleted object warnings','ambiguity review','keyboard source opening','mobile/desktop/narrow bounds']}));
}finally{await browser?.close();await rm(root,{recursive:true,force:true});}

