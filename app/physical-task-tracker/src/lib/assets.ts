/** Immutable media identities, versioned S3 objects, and bounded local tool staging. */
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { S3Client, CreateBucketCommand, GetBucketVersioningCommand, GetBucketPolicyCommand, GetBucketAclCommand, PutBucketVersioningCommand, PutObjectCommand, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getDoc, storageMarker, withRecords } from './records.js';
import type { RecordTransaction } from './record-model.js';
export const ASSET_MARKER = 'asset-store.json';
export const MAX_ASSET_BYTES = 200 * 1024 * 1024;
export const MAX_WORK_BYTES = 512 * 1024 * 1024;
export interface AssetConfig { backend: 's3'; project: string; bucket: string; state: 'pending' | 'active' }
export interface Asset { schema: 'asset/1'; name: string; key: string; sha256: string; size: number; content_type: string; version?: string; state: 'pending' | 'ready' | 'failed'; availability?: 'available' | 'unavailable'; error?: string; provenance: { source: string; parents: string[] }; created_at: string }
export interface AssetRead { asset: Asset; stream: Readable; close(): void }
/** Restrict aliases to a single portable filename, never an object key or URL supplied by the caller. */
export function assetName(name: string): string {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_. -]{0,240}$/.test(name) || name.includes('..') || basename(name) !== name) throw new Error('Invalid asset name.');
  return name;
}
/** Derive playback MIME from a validated filename. */
export function assetType(name: string): string {
  return ({'.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime','.gif':'image/gif','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp'} as Record<string,string>)[extname(name).toLowerCase()] ?? 'application/octet-stream';
}
/** Read durable backend selection. Missing remote configuration never enables local fallback. */
export function assetConfig(root: string, pending = false): AssetConfig | null {
  if(process.env.FIELDOPS_ASSET_BACKEND&&!['s3','local'].includes(process.env.FIELDOPS_ASSET_BACKEND))throw new Error('Unknown FIELDOPS_ASSET_BACKEND.');
  const file = join(root,ASSET_MARKER);
  if (!existsSync(file)) {
    if (process.env.FIELDOPS_ASSET_BACKEND === 's3') throw new Error('Initialize S3 assets with task-assets first.');
    return null;
  }
  const value = JSON.parse(readFileSync(file,'utf8')) as AssetConfig, records = storageMarker(root);
  if (value.backend !== 's3' || !['pending','active'].includes(value.state) || typeof value.bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value.bucket) || !records || records.project_id !== value.project) throw new Error('Invalid asset authority or project identity.');
  if (process.env.FIELDOPS_ASSET_BACKEND && process.env.FIELDOPS_ASSET_BACKEND !== 's3') throw new Error('S3 owns this project’s assets; local fallback is refused.');
  if (process.env.S3_BUCKET && process.env.S3_BUCKET !== value.bucket) throw new Error('S3_BUCKET differs from the project asset authority.');
  if (!pending && value.state !== 'active') throw new Error('Asset activation is incomplete; resume task-assets with writers stopped.');
  return value;
}
/** Construct a standard S3 client with runtime credentials. */
function client(): S3Client {
  if (!process.env.S3_ENDPOINT) throw new Error('S3_ENDPOINT is required for remote assets.');
  return new S3Client({endpoint:process.env.S3_ENDPOINT,region:process.env.AWS_REGION ?? 'us-east-1',forcePathStyle:true,maxAttempts:3});
}
/** Hash a regular file without buffering it. */
export async function hashAsset(file: string): Promise<{sha256:string;size:number}> {
  const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ASSET_BYTES) throw new Error('Asset must be a regular file of at most 200 MiB.');
  const hash = createHash('sha256'); let size=0;
  for await(const chunk of createReadStream(file)){size+=chunk.length;if(size>MAX_ASSET_BYTES)throw new Error('Asset exceeds 200 MiB.');hash.update(chunk);}
  return {sha256:hash.digest('hex'),size};
}
/** Read registry metadata from the canonical record transaction. */
export function assetInRecords(tx: RecordTransaction, name: string): Asset | null {
  const row=tx.first('docs',{where:{key:`asset:${assetName(name)}`}});return row ? JSON.parse(String(row.body)) as Asset : null;
}
/** Completion validation uses previously verified immutable evidence; auditing detects later storage loss. */
export function retainedMediaPresent(root: string, tx: RecordTransaction, name: string | null): boolean {
  try { if(!name)return false;assetName(name);return assetConfig(root) ? assetInRecords(tx,name)?.state==='ready' && assetInRecords(tx,name)?.availability!=='unavailable' : existsSync(join(root,'media',name)); } catch { return false; }
}
/** Persist an asset state without allowing a filename to be rebound to different bytes. */
async function saveAsset(root: string, asset: Asset): Promise<Asset> {
  return withRecords(root,tx=>{
    const prior=assetInRecords(tx,asset.name);
    if(prior&&(prior.sha256!==asset.sha256||prior.key!==asset.key||prior.size!==asset.size))throw new Error('Asset name already identifies different bytes.');
    if(prior?.state==='ready')return prior;
    tx.insert('docs',{key:`asset:${asset.name}`,body:JSON.stringify(asset),updated_at:new Date().toISOString()},{update:['body','updated_at']});return asset;
  });
}
/** Verify exact object bytes before publishing readiness; version IDs are durable identities. */
async function verifyObject(s3: S3Client, config: AssetConfig, asset: Asset, version?: string): Promise<string> {
  const object=await s3.send(new GetObjectCommand({Bucket:config.bucket,Key:asset.key,VersionId:version}));
  if(!object.Body)throw new Error('Missing object body.');
  const stream=object.Body as Readable,hash=createHash('sha256');let size=0;
  try { for await(const chunk of stream){size+=chunk.length;if(size>asset.size)throw new Error('Object size differs from the recorded asset.');hash.update(chunk);} }
  finally {stream.destroy();}
  if(size!==asset.size||hash.digest('hex')!==asset.sha256)throw new Error('Object checksum differs from the recorded asset.');
  if(!object.VersionId||object.VersionId==='null')throw new Error('S3 bucket versioning must be enabled.');
  return object.VersionId;
}
/** Register and upload a file. Retrying a failed database commit reuses the verified immutable object. */
export async function putAsset(root: string, file: string, name = basename(file), provenance: Asset['provenance'] = {source:'upload',parents:[]}, pending = false): Promise<Asset> {
  assetName(name);const config=assetConfig(root,pending),digest=await hashAsset(file);
  const asset:Asset={schema:'asset/1',name,...digest,key:config?`${config.project}/media/${digest.sha256}`:name,content_type:assetType(name),state:'pending',provenance,created_at:new Date().toISOString()};
  if(!config){
    const dir=join(root,'media'),target=join(dir,name);await mkdir(dir,{recursive:true});
    if(resolve(file)!==resolve(target)){if(existsSync(target)){if((await hashAsset(target)).sha256!==digest.sha256)throw new Error('Asset name already identifies different bytes.');}else await copyFile(file,target);}
    return {...asset,state:'ready'};
  }
  const reserved=await saveAsset(root,asset),s3=client();
  try {
    if(reserved.state==='ready'){await verifyObject(s3,config,reserved,reserved.version);return reserved;}
    const body=createReadStream(file);let version:string|undefined;
    try {const uploaded=await s3.send(new PutObjectCommand({Bucket:config.bucket,Key:asset.key,Body:body,ContentLength:asset.size,ContentType:asset.content_type,Metadata:{sha256:asset.sha256},IfNoneMatch:'*'}));version=uploaded.VersionId;}
    catch(error){if((error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode!==412)throw error;}
    finally{body.destroy();}
    version=await verifyObject(s3,config,asset,version);
    return await saveAsset(root,{...reserved,state:'ready',version,error:undefined});
  }catch(error){await saveAsset(root,{...reserved,state:'failed',error:(error as Error).message.slice(0,300)}).catch(()=>{});throw error;}
  finally{s3.destroy();}
}
/** Reconcile an interrupted upload using its reserved object identity, without requiring a local copy. */
export async function repairAsset(root:string,name:string):Promise<Asset>{
  const config=assetConfig(root);if(!config)throw new Error('Repair requires S3 assets.');const asset=await getDoc(root,`asset:${assetName(name)}`) as Asset|null;if(!asset)throw new Error('Asset reservation not found.');if(asset.key!==`${config.project}/media/${asset.sha256}`||asset.name!==name)throw new Error('Asset project identity mismatch.');
  const s3=client();try{const version=await verifyObject(s3,config,asset,asset.version);return await saveAsset(root,{...asset,state:'ready',version,error:undefined});}finally{s3.destroy();}
}
/** Record observed availability without rebinding an immutable identity or version. */
async function markAvailability(root:string,asset:Asset,availability:'available'|'unavailable'):Promise<void>{
  if(asset.availability===availability)return;
  await withRecords(root,tx=>{const current=assetInRecords(tx,asset.name);if(current?.version!==asset.version||current?.state!=='ready')return;
    tx.update('docs',{key:`asset:${asset.name}`},{body:JSON.stringify({...current,availability}),updated_at:new Date().toISOString()});});
}
/** Read immutable metadata and ensure the referenced object/file is available. */
export async function assetInfo(root:string,name:string):Promise<Asset>{
  assetName(name);const config=assetConfig(root);
  if(!config){const digest=await hashAsset(join(root,'media',name));return {schema:'asset/1',name,key:name,...digest,content_type:assetType(name),state:'ready',provenance:{source:'local',parents:[]},created_at:''};}
  const asset=await getDoc(root,`asset:${name}`) as Asset|null;
  if(!asset||asset.state!=='ready'||!asset.version)throw Object.assign(new Error('Asset is not ready or not registered.'),{code:'ASSET_NOT_FOUND'});
  if(asset.key!==`${config.project}/media/${asset.sha256}`||asset.name!==name)throw new Error('Asset project identity mismatch.');
  const s3=client();try{const head=await s3.send(new HeadObjectCommand({Bucket:config.bucket,Key:asset.key,VersionId:asset.version}));if(head.ContentLength!==asset.size||head.Metadata?.sha256!==asset.sha256)throw new Error('Asset metadata does not match the stored object.');if(asset.availability==='unavailable')await markAvailability(root,asset,'available');return {...asset,availability:'available'};}catch(error){await markAvailability(root,asset,'unavailable').catch(()=>{});throw error;}finally{s3.destroy();}
}
/** Open an exact version, optionally bounded to an inclusive byte interval. The caller must close it. */
export async function readAsset(root:string,name:string,range?:{start:number;end:number}):Promise<AssetRead>{
  const asset=await assetInfo(root,name),config=assetConfig(root);
  if(range&&(!Number.isSafeInteger(range.start)||!Number.isSafeInteger(range.end)||range.start<0||range.end<range.start||range.end>=asset.size))throw new Error('Invalid asset range.');
  if(!config){const stream=createReadStream(join(root,'media',asset.name),range);return {asset,stream,close:()=>stream.destroy()};}
  const s3=client();try{const object=await s3.send(new GetObjectCommand({Bucket:config.bucket,Key:asset.key,VersionId:asset.version,Range:range?`bytes=${range.start}-${range.end}`:undefined}));if(!object.Body)throw new Error('Missing asset stream.');const stream=object.Body as Readable;return {asset,stream,close:()=>{stream.destroy();s3.destroy();}};}catch(error){s3.destroy();throw error;}
}
/** Use one project-wide staging slot. A crashed worker requires explicit offline cleanup. */
export async function withAssetWorkspace<T>(root:string,fn:(directory:string)=>Promise<T>):Promise<T>{
  const parent=join(root,'asset-staging'),directory=join(parent,'active');await mkdir(parent,{recursive:true});
  try{await mkdir(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new Error('Media processing is busy or was interrupted. Retry later, or use task-assets cleanup-staging --offline after stopping writers.');throw error;}
  try{return await fn(directory);}finally{await rm(directory,{recursive:true,force:true});}
}
/** Stage a bounded, checksum-verified original for tools requiring filesystem access. */
export async function stageAsset(root:string,name:string,directory:string):Promise<string>{
  const input=await readAsset(root,name),file=join(directory,assetName(name)),hash=createHash('sha256');let size=0;
  const guard=new Transform({transform(chunk:Buffer,_encoding,callback){size+=chunk.length;if(size>MAX_ASSET_BYTES)return callback(new Error('Staging limit exceeded.'));hash.update(chunk);callback(null,chunk);}});
  try{await pipeline(input.stream,guard,createWriteStream(file,{flags:'wx'}));if(size!==input.asset.size||hash.digest('hex')!==input.asset.sha256)throw new Error('Staged asset checksum mismatch.');return file;}catch(error){await rm(file,{force:true});throw error;}finally{input.close();}
}
/** Check the bounded output directory before attaching any generated artifacts. */
export async function retainGenerated(root:string,directory:string,parents:string[]):Promise<string[]>{
  const files=await readdir(directory);let bytes=0;for(const name of files){const st=await lstat(join(directory,assetName(name)));if(!st.isFile()||st.isSymbolicLink())throw new Error('Invalid generated asset.');bytes+=st.size;}if(bytes>MAX_WORK_BYTES)throw new Error('Generated media exceeds staging budget.');
  const gifs=files.filter(n=>n.endsWith('.gif'));for(const name of gifs)await putAsset(root,join(directory,name),name,{source:'segment-preview',parents});return gifs;
}
/** Explicitly provision/import assets while all project writers are stopped. Local originals are preserved. */
export async function activateAssets(root:string,mode:'init'|'import'):Promise<void>{
  const records=storageMarker(root);if(!records)throw new Error('Activate MongoDB records before S3 assets.');
  const bucket=process.env.S3_BUCKET;if(!bucket||!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket))throw new Error('Set a valid S3_BUCKET.');
  const marker=join(root,ASSET_MARKER),existing=existsSync(marker)?assetConfig(root,true):null;
  if(existing?.state==='active')throw new Error('S3 assets are already active.');
  let names:string[]=[];try{names=await readdir(join(root,'media'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  if(mode==='init'&&names.length)throw new Error('Local media exists; use import to preserve its links.');
  for(const name of names)await hashAsset(join(root,'media',assetName(name)));
  const config:AssetConfig={backend:'s3',project:records.project_id,bucket,state:'pending'};
  const s3=client();try{
    try{await s3.send(new CreateBucketCommand({Bucket:bucket}));}catch(e){if(!['BucketAlreadyOwnedByYou','BucketAlreadyExists'].includes((e as Error).name))throw e;}
    try { await s3.send(new GetBucketPolicyCommand({Bucket:bucket})); throw new Error('Use a dedicated private bucket without a bucket policy.'); } catch(error) { if(!['NoSuchBucketPolicy','NoSuchPolicy'].includes((error as Error).name))throw error; }
    const acl=await s3.send(new GetBucketAclCommand({Bucket:bucket}));if(acl.Grants?.some(g=>g.Grantee?.URI))throw new Error('Public/shared bucket ACLs are not supported.');
    await s3.send(new PutBucketVersioningCommand({Bucket:bucket,VersioningConfiguration:{Status:'Enabled'}}));
    if((await s3.send(new GetBucketVersioningCommand({Bucket:bucket}))).Status!=='Enabled')throw new Error('Bucket versioning is required.');
  }finally{s3.destroy();}
  if(!existing)await writeFile(marker,JSON.stringify(config)+'\n',{flag:'wx',mode:0o600});
  for(const name of names)await putAsset(root,join(root,'media',name),name,{source:'local-import',parents:[]},true);
  const temp=`${marker}.${randomUUID()}.tmp`;await writeFile(temp,JSON.stringify({...config,state:'active'})+'\n',{flag:'wx',mode:0o600});await rename(temp,marker);
}
/** Inspect pending/failed reservations and missing objects without deleting historical evidence. */
export async function auditAssets(root:string):Promise<Array<{name:string;state:string;error?:string}>>{
  assetConfig(root);const assets=await withRecords(root,tx=>tx.select('docs',{prefix:{key:'asset:'}}).map(row=>JSON.parse(String(row.body)) as Asset));
  const results=[];for(const asset of assets){try{await assetInfo(root,asset.name);results.push({name:asset.name,state:'ready'});}catch(error){results.push({name:asset.name,state:asset.state==='ready'?'unavailable':asset.state,error:(error as Error).message});}}return results;
}
