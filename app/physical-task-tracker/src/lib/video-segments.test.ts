import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSegmentGifs } from './video-segments.js';

test('real ffmpeg creates indexed looping GIF previews and rejects path traversal', async t => {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) return t.skip('ffmpeg unavailable');
  const root = await mkdtemp(join(tmpdir(), 'segments-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const video=join(root,'portrait.mp4');
  execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','testsrc=size=120x200:rate=8','-t','2','-pix_fmt','yuv420p',video]);
  const clips=await generateSegmentGifs(video,root,'review',2,2);
  assert.deepEqual(clips.map(c=>[c.frame,c.start_s,c.end_s]),[[0,0,1],[1,1,2]]);
  for(const clip of clips)assert.match((await readFile(join(root,clip.file))).subarray(0,6).toString(),/^GIF8[79]a$/);
  await assert.rejects(generateSegmentGifs(video,root,'../escape',2,2),/Invalid/);
});
