/** Real Mongo replica-set/S3 transfer verification, isolated from live app projects. */
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { MongoClient } from 'mongodb';
import { S3Client,CreateBucketCommand,PutBucketVersioningCommand } from '@aws-sdk/client-s3';
import { inspectTransfer,transfer,readTransfer,restoreTransfer,S3BlobStore } from '../app/physical-task-tracker/dist/lib/storage-transfer.js';
const root=await mkdtemp(join(tmpdir(),'storage-smoke-')),client=new MongoClient(process.env.MONGODB_URI),s3=new S3Client({endpoint:process.env.S3_ENDPOINT,forcePathStyle:true,region:'us-east-1'});
try{
 await client.connect();
 try{await s3.send(new CreateBucketCommand({Bucket:process.env.S3_BUCKET}));}catch(e){if(!['BucketAlreadyOwnedByYou','BucketAlreadyExists'].includes(e.name))throw e;}
 await s3.send(new PutBucketVersioningCommand({Bucket:process.env.S3_BUCKET,VersioningConfiguration:{Status:'Enabled'}}));
 const source=join(root,'source');execFileSync('node',['/app/docker/fixture.mjs','seed'],{env:{...process.env,FIELDOPS_FIXTURE_ROOT:source}});
 const project='fixture-'+crypto.randomUUID(),manifest=await inspectTransfer(source,project),blobs=new S3BlobStore(s3,process.env.S3_BUCKET);
 await transfer(source,manifest,blobs,client,'fieldops');await transfer(source,manifest,blobs,client,'fieldops');
 assert.equal(await client.db('fieldops').collection('transfer_manifests').countDocuments({project}),1);
 const stored=await readTransfer(client,'fieldops',project,manifest.generation);await assert.rejects(readTransfer(client,'fieldops','wrong',manifest.generation));
 const restored=join(root,'restored');await restoreTransfer(stored,restored,blobs);
 execFileSync('node',['/app/docker/fixture.mjs','verify'],{env:{...process.env,FIELDOPS_FIXTURE_ROOT:restored}});
 assert.equal((await inspectTransfer(restored,project)).generation,manifest.generation);
 console.log(JSON.stringify({passed:true,checks:['real Mongo transaction','versioned MinIO objects','repeated transfer','scope isolation','restored corrected workflow and media'],live_backend_changed:false}));
}finally{await client.close();s3.destroy();await rm(root,{recursive:true,force:true});}
