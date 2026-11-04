/** Offline, immutable migration generations. This does not switch the live application backend. */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, lstat, rm, rename } from 'node:fs/promises';
import { resolve, join, dirname, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, Writable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { MongoClient } from 'mongodb';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { initDb, DATABASE_VERSION } from './db.js';

export const TABLES = ['goals','spots','sessions','events','docs','actions','oi_links','processes'] as const;
export interface AssetRecord { path: string; sha256: string; size: number; key: string; version?: string }
export interface TransferManifest { format: 'fieldops-transfer/1'; project: string; generation: string; database_version: number; tables: Record<string, Record<string, any>[]>; assets: AssetRecord[] }
export interface BlobStore {
  put(file: string, asset: AssetRecord): Promise<string | undefined>;
  verify(asset: AssetRecord): Promise<void>;
  download(asset: AssetRecord, destination: string): Promise<void>;
}
/** Scope identifiers never become paths or raw query predicates. */
export function scope(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw Error('Project ID must contain 1–80 letters, digits, underscores or hyphens');
  return value;
}
/** Validate relative paths from imported manifests before touching the filesystem. */
export function safePath(path: string): string {
  if (!path || path.includes('\\') || path.startsWith('/') || path.split('/').some(p=>!p||p==='.'||p==='..') || path.includes(':')) throw Error('Unsafe asset path');
  return path;
}
/** Stream hashes rather than buffering entire videos. */
async function fileHash(file: string): Promise<string> {
  const hash=createHash('sha256');for await(const part of createReadStream(file))hash.update(part);return hash.digest('hex');
}
/** Read a stopped versioned project without opening it through the migration layer. */
export async function inspectTransfer(rootArg: string, projectId: string): Promise<TransferManifest> {
  const root=resolve(rootArg),project=scope(projectId),tables: TransferManifest['tables']={};
  const db=new DatabaseSync(join(root,'fieldops.db'),{readOnly:true} as any);
  try {
    const version=(db.prepare('PRAGMA user_version').get() as any).user_version;
    if(version!==DATABASE_VERSION)throw Error('Upgrade the source with a compatible app before migration; source was not modified');
    if((db.prepare('PRAGMA integrity_check').get() as any).integrity_check!=='ok')throw Error('Source database integrity check failed');
    const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r:any)=>r.name);
    if(names.some(n=>!TABLES.includes(n as any)))throw Error('Unknown source tables; refusing a lossy transfer');
    for(const table of TABLES)tables[table]=db.prepare(`SELECT * FROM ${table}`).all().map((row:any)=>({...row})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  } finally {db.close();}
  const assets: AssetRecord[]=[];
  async function walk(dir: string): Promise<void> {
    for(const name of (await readdir(dir)).sort()){
      const file=join(dir,name),path=relative(root,file).replaceAll('\\','/');
      if(['fieldops.db','fieldops.db-wal','fieldops.db-shm','fieldops.db-journal'].includes(path))continue;
      const stat=await lstat(file);if(stat.isSymbolicLink()||(!stat.isFile()&&!stat.isDirectory()))throw Error('Unsupported filesystem entry: '+path);
      if(stat.isDirectory())await walk(file);else {const sha256=await fileHash(file);assets.push({path:safePath(path),sha256,size:stat.size,key:`${project}/sha256/${sha256}`});}
    }
  }
  await walk(root);
  const base={format:'fieldops-transfer/1' as const,project,database_version:DATABASE_VERSION,tables,assets};
  return {...base,generation:createHash('sha256').update(JSON.stringify(base)).digest('hex')};
}
/** S3-compatible immutable content keys; versions and full byte checksums are retained. */
export class S3BlobStore implements BlobStore {
  constructor(private readonly client: S3Client, private readonly bucket: string) {}
  async put(file: string, asset: AssetRecord): Promise<string | undefined> {
    // Conditional creation prevents a retry overwriting the object used by another snapshot.
    try {return (await this.client.send(new PutObjectCommand({Bucket:this.bucket,Key:asset.key,Body:createReadStream(file),ContentLength:asset.size,IfNoneMatch:'*',Metadata:{sha256:asset.sha256}}))).VersionId;}
    catch(error:any){if(error.$metadata?.httpStatusCode!==412)throw error;const result=await this.client.send(new GetObjectCommand({Bucket:this.bucket,Key:asset.key}));(result.Body as any)?.destroy?.();return result.VersionId;}
  }
  async verify(asset: AssetRecord): Promise<void> {await this.read(asset);}
  async download(asset: AssetRecord, destination: string): Promise<void> {await mkdir(dirname(destination),{recursive:true});await this.read(asset,destination);}
  private async read(asset: AssetRecord, destination?: string): Promise<void> {
    const response=await this.client.send(new GetObjectCommand({Bucket:this.bucket,Key:asset.key,VersionId:asset.version}));
    if(!response.Body)throw Error('Missing object body');
    const hash=createHash('sha256');let size=0;
    const check=new Transform({transform(chunk,_,done){hash.update(chunk);size+=chunk.length;done(null,chunk);}});
    const sink=destination?createWriteStream(destination,{flags:'wx'}):new Writable({write(_chunk,_encoding,done){done();}});
    await pipeline(response.Body as any,check,sink);
    if(size!==asset.size||hash.digest('hex')!==asset.sha256)throw Error('Object checksum mismatch: '+asset.path);
  }
}
/** Verify record and asset metadata against the immutable generation identifier. */
function verifyManifest(m: TransferManifest): void {
  const assets=m.assets.map(({version,...asset})=>asset);
  const base={format:m.format,project:m.project,database_version:m.database_version,tables:m.tables,assets};
  if(createHash('sha256').update(JSON.stringify(base)).digest('hex')!==m.generation)throw Error('Manifest checksum mismatch');
}
/** Commit all Mongo records only after every referenced object has passed verification. */
export async function transfer(root: string, manifest: TransferManifest, blobs: BlobStore, client: MongoClient, database: string): Promise<void> {
  verifyManifest(manifest);
  const store=client.db(database),key=`${scope(manifest.project)}:${manifest.generation}`;
  if(await store.collection('transfer_manifests').findOne({_id:key as any,ready:true})){
    const committed=await readTransfer(client,database,manifest.project,manifest.generation);
    for(const asset of committed.assets)await blobs.verify(asset);
    return;
  }
  for(const asset of manifest.assets){asset.version=await blobs.put(join(root,safePath(asset.path)),asset);await blobs.verify(asset);}
  const session=client.startSession();
  try {await session.withTransaction(async()=>{
    const prior=await store.collection('transfer_manifests').findOne({_id:key as any},{session});
    if(prior)return;
    for(const [table,rows] of Object.entries(manifest.tables)){
      if(!TABLES.includes(table as any))throw Error('Unknown table');
      if(rows.length)await store.collection('transfer_records').insertMany(rows.map((row,ordinal)=>({project:manifest.project,generation:manifest.generation,table,ordinal,row})),{session});
    }
    const {tables,...metadata}=manifest;
    await store.collection('transfer_manifests').insertOne({_id:key as any,...metadata,counts:Object.fromEntries(Object.entries(tables).map(([k,v])=>[k,v.length])),ready:true},{session});
  });} finally {await session.endSession();}
}
/** Read only a fully committed immutable generation; selectors always include project scope. */
export async function readTransfer(client: MongoClient, database: string, project: string, generation: string): Promise<TransferManifest> {
  scope(project);if(!/^[a-f0-9]{64}$/.test(generation))throw Error('Invalid generation');
  const db=client.db(database),metadata=await db.collection('transfer_manifests').findOne({_id:`${project}:${generation}` as any,ready:true});
  if(!metadata)throw Error('Committed generation not found in this project');
  const tables: TransferManifest['tables']={};
  for(const table of TABLES){tables[table]=(await db.collection('transfer_records').find({project,generation,table}).sort({ordinal:1}).toArray()).map(r=>r.row);if(tables[table].length!==metadata.counts[table])throw Error('Record count mismatch');}
  const result: TransferManifest={format:'fieldops-transfer/1',project,generation,database_version:metadata.database_version,tables,assets:metadata.assets};
  verifyManifest(result);return result;
}
/** Restore into a new local project for cutover validation; never overwrite existing work. */
export async function restoreTransfer(manifest: TransferManifest, destination: string, blobs: BlobStore): Promise<void> {
  if(manifest.format!=='fieldops-transfer/1'||manifest.database_version!==DATABASE_VERSION)throw Error('Unsupported transfer version');
  verifyManifest(manifest);
  const target=resolve(destination);await mkdir(target,{recursive:false});
  try {
    initDb(target);const db=new DatabaseSync(join(target,'fieldops.db'));
    try {db.exec('BEGIN');for(const table of TABLES){
      const columns=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c:any)=>c.name));
      for(const row of manifest.tables[table]){const keys=Object.keys(row);if(keys.some(k=>!columns.has(k)))throw Error('Unknown column');db.prepare(`INSERT INTO ${table} (${keys.map(k=>'"'+k+'"').join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>row[k]));}
    }db.exec('COMMIT');}finally{db.close();}
    for(const asset of manifest.assets){const path=safePath(asset.path);if(path==='fieldops.db'||path.startsWith('fieldops.db-'))throw Error('Asset shadows database');if(!asset.key.startsWith(scope(manifest.project)+'/sha256/'))throw Error('Asset outside project');await blobs.download(asset,join(target,path));}
  }catch(error){await rm(target,{recursive:true,force:true});throw error;}
}
