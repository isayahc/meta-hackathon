import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setDoc, getDoc } from './records.js';
import { inspectTransfer, restoreTransfer, safePath, scope, type BlobStore } from './storage-transfer.js';

test('dry run is deterministic and restoration preserves corrected records and media without overwriting',async t=>{
 const root=await mkdtemp(join(tmpdir(),'transfer-'));t.after(()=>rm(root,{recursive:true,force:true}));const source=join(root,'source');
 await setDoc(source,'human-correction',{title:'Corrected title',revision:3});await mkdir(join(source,'media'));await writeFile(join(source,'media/clip.mp4'),'retained bytes');
 const a=await inspectTransfer(source,'farm'),b=await inspectTransfer(source,'farm');assert.equal(a.generation,b.generation);assert.equal(a.assets.length,1);
 const blobs:BlobStore={async put(){return undefined;},async verify(){},async download(asset,destination){await mkdir(join(destination,'..'),{recursive:true});await copyFile(join(source,asset.path),destination);}};
 const target=join(root,'restored');await restoreTransfer(a,target,blobs);assert.deepEqual(await getDoc(target,'human-correction'),{title:'Corrected title',revision:3});assert.equal(await readFile(join(target,'media/clip.mp4'),'utf8'),'retained bytes');
 await assert.rejects(restoreTransfer(a,target,blobs),/EEXIST/);
 const malicious=structuredClone(a);malicious.assets[0].path='../escape';await assert.rejects(restoreTransfer(malicious,join(root,'unsafe'),blobs),/checksum/);
 const failing:BlobStore={...blobs,async download(){throw Error('Missing object');}};await assert.rejects(restoreTransfer(a,join(root,'failure'),failing),/Missing object/);await assert.rejects(readFile(join(root,'failure/fieldops.db')),/ENOENT/);
});
test('project scopes and traversal paths are rejected',()=>{for(const p of ['../x','/x','x\\y','x/../y','C:/x'])assert.throws(()=>safePath(p));assert.throws(()=>scope('a/b'));assert.equal(scope('farm-1'),'farm-1');});
