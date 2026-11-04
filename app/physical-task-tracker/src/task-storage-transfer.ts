/** Offline transfer CLI. A dry run never connects to MongoDB or S3. */
import { MongoClient } from 'mongodb';
import { S3Client } from '@aws-sdk/client-s3';
import { inspectTransfer, transfer, readTransfer, restoreTransfer, S3BlobStore } from './lib/storage-transfer.js';
const [command,project,path,generation,...flags]=process.argv.slice(2);
try {
  if(!['inspect','export','restore'].includes(command)||!project||!path)throw Error('Usage: task-storage-transfer inspect|export|restore PROJECT PATH [GENERATION] --offline');
  if(!process.argv.includes('--offline'))throw Error('Stop all project writers, then acknowledge --offline');
  if(command==='inspect'){
    const m=await inspectTransfer(path,project);console.log(JSON.stringify({generation:m.generation,project,records:Object.fromEntries(Object.entries(m.tables).map(([k,v])=>[k,v.length])),assets:m.assets.length,bytes:m.assets.reduce((n,a)=>n+a.size,0)}));
  }else{
    for(const key of ['MONGODB_URI','S3_ENDPOINT','S3_BUCKET','AWS_ACCESS_KEY_ID','AWS_SECRET_ACCESS_KEY'])if(!process.env[key])throw Error('Missing setting: '+key);
    const client=new MongoClient(process.env.MONGODB_URI!,{serverSelectionTimeoutMS:10000});
    const s3=new S3Client({endpoint:process.env.S3_ENDPOINT,region:process.env.AWS_REGION||'us-east-1',forcePathStyle:true});
    const blobs=new S3BlobStore(s3,process.env.S3_BUCKET!);
    try {await client.connect();
      if(command==='export'){const m=await inspectTransfer(path,project);await transfer(path,m,blobs,client,process.env.MONGODB_DATABASE||'fieldops');console.log(JSON.stringify({ready:true,project,generation:m.generation,live_backend_changed:false}));}
      else {const m=await readTransfer(client,process.env.MONGODB_DATABASE||'fieldops',project,generation);await restoreTransfer(m,path,blobs);console.log(JSON.stringify({restored:true,project,path}));}
    }finally{await client.close();s3.destroy();}
  }
}catch(error){console.error(error instanceof Error?error.message:'Storage transfer failed');process.exitCode=1;}
