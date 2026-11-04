/** Synthetic deployment fixture; no live inference or hardware operations. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { captureJourney, journeyCommand, journeyView } from '../app/physical-task-tracker/dist/lib/journey.js';
import { setDoc, getDoc } from '../app/physical-task-tracker/dist/lib/records.js';
const root=process.env.FIELDOPS_FIXTURE_ROOT||'/data';
const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
if(process.argv[2]==='seed'){
  assert.ok(!existsSync(`${root}/fixture.json`),'Use a new disposable volume');
  mkdirSync(`${root}/media`,{recursive:true});
  execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=green:s=64x64:d=1','-c:v','libx264',`${root}/media/fixture.mp4`]);
  execFileSync('ffmpeg',['-v','error','-i',`${root}/media/fixture.mp4`,'-vf','fps=2',`${root}/media/fixture.gif`]);
  let j=await captureJourney(root,{media:'fixture.mp4'},async()=>({observed_task:'Tray fixture',per_frame:['Place tray'],frame_times_s:[0.5],video_duration_s:1,suggested_next_steps:['Inspect tray'],model:'fixture',prompt_version:'docker/1'}),'replay');
  const send=async command=>{j=(await journeyCommand(root,{id:j.id,revision:j.revision,request_id:crypto.randomUUID(),reason:'Deployment fixture',...command}));};
  let clip=(await journeyView(root)).workflows[0].clips[0];
  await send({command:'correct',source_id:clip.source_id,process_revision:clip.process.rev,patch:{title:'Human-corrected tray'}});
  clip=(await journeyView(root)).workflows[0].clips[0];await send({command:'review',source_id:clip.source_id,process_revision:clip.process.rev});
  await send({command:'next_decide',choice:'later',basis:(await journeyView(root)).workflows[0].proposal.basis});
  // Opaque future data proves persistence, not implementation of issues #72/#73.
  await setDoc(root,'deployment-memory-fixture',{preference:'morning'});
  await setDoc(root,'deployment-checkpoint-fixture',{pending:'review',receipt:'test-only'});
  writeFileSync(`${root}/fixture.json`,JSON.stringify({id:j.id,revision:j.revision,task_ids:j.task_ids,mp4:digest(`${root}/media/fixture.mp4`),gif:digest(`${root}/media/fixture.gif`)}));
}else{
  const expected=JSON.parse(readFileSync(`${root}/fixture.json`,'utf8'));
  const v=await journeyView(root),w=v.workflows.find(w=>w.workflow.id===expected.id);
  assert.equal(w.workflow.revision,expected.revision);assert.equal(w.workflow.title,'Human-corrected tray');
  assert.deepEqual(w.workflow.task_ids,expected.task_ids);assert.equal(v.planning.tasks.length,1);assert.ok(w.baseline_reviewed);
  assert.equal(digest(`${root}/media/fixture.mp4`),expected.mp4);assert.equal(digest(`${root}/media/fixture.gif`),expected.gif);
  assert.equal((await getDoc(root,'deployment-memory-fixture')).preference,'morning');
  assert.equal((await getDoc(root,'deployment-checkpoint-fixture')).receipt,'test-only');
}
console.log('Deployment fixture passed: '+process.argv[2]);
