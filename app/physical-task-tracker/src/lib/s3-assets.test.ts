/** Real MongoDB/MinIO and FFmpeg integration; no model calls or bound application sockets. */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import { activateMongo } from './record-activation.js';
import { withMongo, getDoc } from './records.js';
import { TABLES } from './record-model.js';
import { activateAssets, putAsset, assetInfo, readAsset, repairAsset, auditAssets, ASSET_MARKER, type Asset } from './assets.js';
import { createServer } from '../serve-dashboard.js';
import { generateSegmentGifs } from './video-segments.js';
import { journeyView, journeyCommand } from './journey.js';
import { ensureReviewPreviews } from './review-previews.js';
const enabled=process.env.FIELDOPS_TEST_ASSETS==='1';
/** Allocate distinct record and object scopes in disposable CI services. */
async function fixture(t:TestContext,activate=true):Promise<{root:string;id:string;s3:S3Client}>{
  const root=await mkdtemp(join(tmpdir(),'s3-live-')),id=`asset-${randomUUID()}`;
  const s3=new S3Client({endpoint:process.env.S3_ENDPOINT,region:'us-east-1',forcePathStyle:true});
  t.after(async()=>{await withMongo(async(_client,db)=>{for(const table of TABLES)await db.collection(`records_${table}`).deleteMany({project_id:id});await db.collection<{_id:string}>('record_projects').deleteOne({_id:id});});s3.destroy();await rm(root,{recursive:true,force:true});});
  await activateMongo(root,id,'init');if(activate)await activateAssets(root,'init');return{root,id,s3};
}
/** Drive the production request handler directly and collect streamed bytes. */
async function request(root:string,method:string,url:string,headers:Record<string,string>={},body?:unknown,scanRunner?:NonNullable<Parameters<typeof createServer>[1]>['scanRunner']){
  let status=0,result:Record<string,string>={},bytes=Buffer.alloc(0);
  const handler=createServer(root,{scanRunner}).listeners('request')[0];
  await handler({method,url,headers,async *[Symbol.asyncIterator](){if(body)yield Buffer.from(JSON.stringify(body));}},
    {writeHead(code:number,h:Record<string,string>){status=code;result=h;},write(chunk:Buffer){bytes=Buffer.concat([bytes,chunk]);return true;},end(chunk?:Buffer|string){if(chunk)bytes=Buffer.concat([bytes,Buffer.from(chunk)]);}});
  return{status,headers:result,bytes};
}

test('S3 upload → real segment GIFs → review → restart playback preserves exact versions and ranges',{skip:!enabled},async t=>{
  const {root,id,s3}=await fixture(t),video=join(root,'source.mp4');
  execFileSync('ffmpeg',['-y','-v','error','-f','lavfi','-i','testsrc=size=120x200:rate=8','-t','2','-pix_fmt','yuv420p',video]);
  const bytes=await readFile(video);let calls=0;
  const upload=await request(root,'POST','/api/journey-video',{}, {videoData:`data:video/mp4;base64,${bytes.toString('base64')}`,frames:2},async(_name,args)=>{
    calls++;assert.ok(args[0].includes('asset-staging'));const directory=args[args.indexOf('--gifs')+1],prefix=args[args.indexOf('--gif-prefix')+1];
    const segments=await generateSegmentGifs(args[0],directory,prefix,2,2);
    return{observed_task:'Prepare tray',per_frame:['Pick up tray','Fill tray'],frame_times_s:[0.5,1.5],video_duration_s:2,gif_segments:segments,gifs:segments.map(s=>s.file),model:'replay',prompt_version:'assets/1'};
  });
  assert.equal(upload.status,200,upload.bytes.toString());assert.equal(calls,1);
  const view=(await journeyView(root)).workflows[0],clip=view.clips[0],name=clip.source.media!;
  assert.equal(clip.source.stage,'needs_review');const segments=await ensureReviewPreviews(root,clip.source_id,clip.interpretation_id!);
  assert.equal(segments.length,2);assert.notEqual(segments[0].file,segments[1].file);
  for(const segment of segments){const gif=await request(root,'GET',`/media/${segment.file}`);assert.equal(gif.status,200);assert.match(gif.bytes.subarray(0,6).toString(),/^GIF8/);}
  await journeyCommand(root,{command:'review',id:view.workflow.id,revision:view.workflow.revision,request_id:'review',source_id:clip.source_id,process_revision:clip.process!.rev,reason:'Operator verifies clip'});
  assert.equal((await journeyView(root)).workflows[0].baseline_reviewed,true);
  assert.equal(existsSync(join(root,'media',name)),false);assert.equal(existsSync(join(root,'asset-staging','active')),false);
  const original=await assetInfo(root,name);assert.ok(original.version);
  // An unrelated newer object version must never change historical evidence playback.
  await s3.send(new PutObjectCommand({Bucket:process.env.S3_BUCKET,Key:original.key,Body:Buffer.from('newer version'),Metadata:{sha256:'wrong'}}));
  assert.deepEqual((await request(root,'GET',`/media/${name}`)).bytes,bytes);
  const partial=await request(root,'GET',`/media/${name}`,{range:'bytes=4-15'});assert.equal(partial.status,206);assert.deepEqual(partial.bytes,bytes.subarray(4,16));
  assert.equal((await request(root,'HEAD',`/media/${name}`)).bytes.length,0);
  assert.equal((await request(root,'GET',`/media/${name}`,{range:'bytes=99999999-'})).status,416);
  await rm(video);await rm(join(root,'media'),{recursive:true,force:true});
  const cli=fileURLToPath(new URL('../task-assets.js',import.meta.url));const restarted=await promisify(execFile)(process.execPath,[cli,'audit',root],{env:process.env});
  assert.ok(JSON.parse(restarted.stdout).every((a:{state:string})=>a.state==='ready'));
  const other=await fixture(t);assert.equal((await request(other.root,'GET',`/media/${name}`)).status,404);
  await s3.send(new DeleteObjectCommand({Bucket:process.env.S3_BUCKET,Key:original.key,VersionId:original.version}));
  await mkdir(join(root,'media'),{recursive:true});await writeFile(join(root,'media',name),bytes);
  assert.equal((await request(root,'GET',`/media/${name}`)).status,404,'Never fall back to local media or another object version');
  assert.equal((await auditAssets(root)).find(a=>a.name===name)?.state,'unavailable');
});

test('S3 upload survives failed metadata publication; repair and retry preserve one object version',{skip:!enabled},async t=>{
  const {root,id,s3}=await fixture(t),file=join(root,'source.mp4');await writeFile(file,'retry bytes');
  await withMongo(async(_client,db)=>{
    const info=await db.listCollections({name:'records_docs'}).next();const previous=(info as {options?:{validator?:Record<string,unknown>}}|null)?.options?.validator??{};
    await db.command({collMod:'records_docs',validator:{$and:[previous,{$nor:[{project_id:id,'data.key':'asset:retry.mp4','data.body.state':'ready'}]}]}});
    try{await assert.rejects(putAsset(root,file,'retry.mp4'),/validation/i);}finally{await db.command({collMod:'records_docs',validator:previous});}
  });
  const failed=await getDoc(root,'asset:retry.mp4') as Asset;assert.equal(failed.state,'failed');
  await rm(file);const repaired=await repairAsset(root,'retry.mp4');assert.equal(repaired.state,'ready');
  const read=await readAsset(root,'retry.mp4');try{const chunks=[];for await(const part of read.stream)chunks.push(part);assert.equal(Buffer.concat(chunks).toString(),'retry bytes');}finally{read.close();}
  await writeFile(file,'retry bytes');assert.equal((await putAsset(root,file,'retry.mp4')).version,repaired.version);
  const versions=await s3.send(new ListObjectVersionsCommand({Bucket:process.env.S3_BUCKET,Prefix:repaired.key}));assert.equal(versions.Versions?.length,1);
  await writeFile(file,'different');await assert.rejects(putAsset(root,file,'retry.mp4'),/different bytes/);
});

test('S3 import resumes a pending activation and preserves legacy media names without relying on disk',{skip:!enabled},async t=>{
  const {root}=await fixture(t,false);await mkdir(join(root,'media'));await writeFile(join(root,'media','legacy.gif'),'GIF89a');
  await assert.rejects(activateAssets(root,'init'),/use import/);await activateAssets(root,'import');
  const marker=JSON.parse(await readFile(join(root,ASSET_MARKER),'utf8'));await writeFile(join(root,ASSET_MARKER),JSON.stringify({...marker,state:'pending'}));
  await assert.rejects(assetInfo(root,'legacy.gif'),/activation is incomplete/);await activateAssets(root,'import');
  await rm(join(root,'media'),{recursive:true});assert.equal((await request(root,'GET','/media/legacy.gif')).bytes.toString(),'GIF89a');
});
