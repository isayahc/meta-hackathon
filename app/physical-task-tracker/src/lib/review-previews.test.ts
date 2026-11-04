import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureJourney, journeyView, journeyCommand } from './journey.js';
import { ensureReviewPreviews } from './review-previews.js';

test('old recordings gain cached segment GIFs without reanalysis or invalidating human review', async t=>{
 if(spawnSync('ffmpeg',['-version']).status!==0)return t.skip('ffmpeg unavailable');
 const root=await mkdtemp(join(tmpdir(),'review-previews-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(join(root,'media'));
 execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','testsrc=size=120x200:rate=8','-t','2','-pix_fmt','yuv420p',join(root,'media','old.mp4')]);
 let calls=0;const j=await captureJourney(root,{media:'old.mp4'},async()=>{calls++;return {observed_task:'Old recording',per_frame:['First action','Second action'],frame_times_s:[0.5,1.5],video_duration_s:2};});
 let clip=(await journeyView(root)).workflows[0].clips[0];
 await journeyCommand(root,{id:j.id,revision:j.revision,request_id:'review',command:'review',reason:'Human confirms evidence',source_id:clip.source_id,process_revision:clip.process!.rev});
 const before=(await journeyView(root)).workflows[0];clip=before.clips[0];
 const [a,b]=await Promise.all([(await ensureReviewPreviews(root,clip.source_id,clip.interpretation_id!)),(await ensureReviewPreviews(root,clip.source_id,clip.interpretation_id!))]);
 assert.deepEqual(a,b);assert.equal(a.length,2);assert.notEqual(a[0].file,a[1].file);
 const time=(await stat(join(root,'media',a[0].file))).mtimeMs;
 assert.deepEqual(await ensureReviewPreviews(root,clip.source_id,clip.interpretation_id!),a);
 assert.equal((await stat(join(root,'media',a[0].file))).mtimeMs,time);
 assert.deepEqual((await journeyView(root)).workflows[0],before);assert.equal(calls,1);
 await rm(join(root,'media',a[1].file));assert.equal((await ensureReviewPreviews(root,clip.source_id,clip.interpretation_id!)).length,2);
 await assert.rejects((ensureReviewPreviews(root,clip.source_id,'wrong-interpretation')),/not found/);
 assert.equal(calls,1);
});
