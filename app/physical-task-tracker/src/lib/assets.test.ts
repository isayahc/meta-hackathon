/** Local parity and protocol tests without network or bound sockets. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assetName, putAsset, withAssetWorkspace, stageAsset, readAsset } from './assets.js';
import { byteRange } from './asset-http.js';
import { createServer } from '../serve-dashboard.js';
import { EventEmitter } from 'node:events';

test('single byte ranges include suffixes and reject malformed or unsatisfiable requests',()=>{
  assert.deepEqual(byteRange('bytes=2-4',10),{start:2,end:4});assert.deepEqual(byteRange('bytes=8-',10),{start:8,end:9});assert.deepEqual(byteRange('bytes=-3',10),{start:7,end:9});
  for(const range of ['bytes=10-','bytes=5-2','bytes=-0','bytes=0-1,3-4','bytes=-','nonsense'])assert.equal(byteRange(range,10),null);
  for(const name of ['../x.mp4','a/b.gif','x\\y.gif','..',''])assert.throws(()=>assetName(name));
});

test('immutable local aliases, bounded staging and failed worker cleanup',async t=>{
  const root=await mkdtemp(join(tmpdir(),'assets-local-'));t.after(()=>rm(root,{recursive:true,force:true}));const file=join(root,'input.mp4');await writeFile(file,'original');
  const a=await putAsset(root,file,'clip.mp4');assert.equal((await putAsset(root,file,'clip.mp4')).sha256,a.sha256);
  await writeFile(file,'different');await assert.rejects(putAsset(root,file,'clip.mp4'),/different bytes/);
  await assert.rejects(withAssetWorkspace(root,async dir=>{assert.equal(await readFile(await stageAsset(root,'clip.mp4',dir),'utf8'),'original');await assert.rejects(withAssetWorkspace(root,async()=>{}),/busy|interrupted/);throw Error('Tool failed');}),/Tool failed/);
  await withAssetWorkspace(root,async()=>{});
  const stream=await readAsset(root,'clip.mp4',{start:1,end:3});try{const chunks=[];for await(const chunk of stream.stream)chunks.push(chunk);assert.equal(Buffer.concat(chunks).toString(),'rig');}finally{stream.close();}
});

test('actual HTTP media route streams ranges, HEAD and conditional responses',async t=>{
  const root=await mkdtemp(join(tmpdir(),'assets-http-'));t.after(()=>rm(root,{recursive:true,force:true}));const file=join(root,'input.mp4');await writeFile(file,'0123456789');const asset=await putAsset(root,file,'clip.mp4');
  const handler=createServer(root).listeners('request')[0];
  async function request(method:string,headers:Record<string,string>={}){let status=0,result:Record<string,string>={},body=Buffer.alloc(0);await handler({method,url:'/media/clip.mp4',headers},{writeHead(code:number,h:Record<string,string>){status=code;result=h;},write(chunk:Buffer){body=Buffer.concat([body,chunk]);return true;},end(chunk?:string){if(chunk)body=Buffer.concat([body,Buffer.from(chunk)]);}});return{status,headers:result,body};}
  const range=await request('GET',{range:'bytes=2-5'});assert.equal(range.status,206);assert.equal(range.body.toString(),'2345');assert.equal(range.headers['Content-Range'],'bytes 2-5/10');
  assert.equal((await request('HEAD')).body.length,0);assert.equal((await request('GET',{range:'bytes=50-'})).status,416);
  assert.equal((await request('GET',{'if-none-match':`"${asset.sha256}"`})).status,304);
  assert.equal((await request('GET',{range:'bytes=2-5','if-range':'"old"'})).body.toString(),'0123456789');
});

test('streaming resumes after backpressure and releases disconnected clients',{timeout:3000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'assets-pressure-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const file=join(root,'input.mp4');await writeFile(file,Buffer.alloc(128*1024,7));await putAsset(root,file,'clip.mp4');
  const handler=createServer(root).listeners('request')[0];
  for(const disconnect of [false,true]){
    const events=new EventEmitter();
    const res=Object.assign(events,{
      headersSent:false,destroyed:false,ended:false,bytes:0,
      writeHead(){this.headersSent=true;},
      write(chunk:Buffer){this.bytes+=chunk.length;queueMicrotask(()=>{if(disconnect){this.destroyed=true;events.emit('close');}else events.emit('drain');});return false;},
      end(){this.ended=true;},destroy(){this.destroyed=true;},
    });
    await handler({method:'GET',url:'/media/clip.mp4',headers:{}},res);
    assert.equal(res.ended,!disconnect);assert.equal(res.destroyed,disconnect);
    if(!disconnect)assert.equal(res.bytes,128*1024);
    assert.equal(res.listenerCount('drain'),0);assert.equal(res.listenerCount('close'),0);
  }
});
