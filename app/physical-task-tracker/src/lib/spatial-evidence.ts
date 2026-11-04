/** Reviewed links between immutable process/video evidence and external spatial identities. */
import { createHash, randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, basename } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { withDb } from './db.js';
import { readProcess, listProcesses, type ProcessDoc } from './processes.js';
import { oiReferenceReader, type OiReference, type OiReferenceInspection, type OiReferenceReader } from './oi-reference.js';

export type SpatialTarget = { kind: 'spot'; spot_id: string } | OiReference;
export type AssociationReview = 'proposed' | 'ambiguous' | 'confirmed' | 'rejected';
export interface SpatialSource {
  process_id: string; process_revision: number; step_id: string;
  media: string; sha256: string; start_s: number; end_s: number;
}
export interface SpatialAssociation {
  schema: 'spatial-evidence/1'; id: string; revision: number; source: SpatialSource; target: SpatialTarget;
  origin: 'human' | 'model'; review: AssociationReview; reason: string; created_at: string; updated_at: string;
  history: Array<{ revision: number; source: SpatialSource; target: SpatialTarget; review: AssociationReview; reason: string; at: string }>;
}
export interface AssociationView {
  association: SpatialAssociation; process_title: string; step_label: string; target_label: string;
  issues: Array<{ code: string; message: string }>; current: boolean;
  evidence_url: string | null; spatial: OiReferenceInspection | null;
}
export class SpatialError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'SpatialError'; }
}
function check(ok: unknown, message: string, code = 'INVALID_ASSOCIATION'): asserts ok { if (!ok) throw new SpatialError(code, message); }
function object(value: unknown): Record<string, unknown> { check(value && typeof value === 'object' && !Array.isArray(value), 'Expected an object.'); return value as Record<string, unknown>; }
function words(value: unknown, label: string): string { check(typeof value === 'string' && !!value.trim() && value.length <= 2000, `${label} is required (up to 2000 characters).`); return value.trim(); }
function revision(value: unknown): number { check(Number.isSafeInteger(value) && Number(value) > 0, 'A positive integer revision is required.'); return Number(value); }
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function doc<T>(db: DatabaseSync, key: string): T | null { const row=db.prepare('SELECT body FROM docs WHERE key=?').get(key) as {body:string}|undefined; return row ? JSON.parse(row.body) as T : null; }
function saveDoc(db: DatabaseSync, key: string, value: unknown): void { db.prepare('INSERT INTO docs(key,body,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at').run(key,JSON.stringify(value),new Date().toISOString()); }
function all(db: DatabaseSync): SpatialAssociation[] { return (db.prepare("SELECT body FROM docs WHERE key LIKE 'spatial-association:%' ORDER BY key").all() as Array<{body:string}>).map(r=>JSON.parse(r.body) as SpatialAssociation); }
/** Return durable association revisions and review history without querying OI. */
export function listSpatialAssociations(root: string): SpatialAssociation[] { return withDb(root, all); }
/** Validate reference syntax only. OI remains responsible for entity resolution. */
export function spatialTarget(raw: unknown): SpatialTarget {
  const t=object(raw);
  if(t.kind==='spot')return {kind:'spot',spot_id:words(t.spot_id,'Work area')};
  check(t.kind==='oi','Choose a work area or OI reference.');
  const scene=words(t.scene_id,'Scene');check(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(scene),'Use a valid OI scene ID.');
  check(['scene','instance','region','occupancy'].includes(String(t.entity_kind)),'Unsupported OI reference kind.');
  const kind=t.entity_kind as OiReference['entity_kind'];
  return {kind:'oi',scene_id:scene,revision:revision(t.revision),entity_kind:kind,entity_id:kind==='scene'?'scene':words(t.entity_id,'OI entity')};
}
/** Inspect only the supported OI reference interface; no scene writes occur. */
export async function inspectSpatialTarget(root: string, raw: unknown, reader: OiReferenceReader=oiReferenceReader(root)): Promise<OiReferenceInspection> {
  const target=spatialTarget(raw);check(target.kind==='oi','Select an OI scene to inspect.');return reader(target);
}
/** Verify local media identity; never follow a caller-provided path outside project media. */
async function mediaDigest(root: string, name: string): Promise<string> {
  check(name===basename(name)&&!name.includes('\\')&&name!=='.'&&name!=='..','Invalid source media name.');
  const path=join(root,'media',name),stat=await lstat(path);check(stat.isFile()&&!stat.isSymbolicLink(),'Source media must be a local regular file.');
  const digest=createHash('sha256');for await(const chunk of createReadStream(path))digest.update(chunk);return digest.digest('hex');
}
async function validateSource(root: string, raw: unknown): Promise<SpatialSource> {
  const s=object(raw),id=words(s.process_id,'Process'),rev=revision(s.process_revision),stepId=words(s.step_id,'Process step');
  const p=await readProcess(root,id,rev),latest=await readProcess(root,id);check(latest.rev===rev,'Stale process revision. Review the current process before linking.','STALE_PROCESS');
  const step=p.steps.find(x=>x.id===stepId);check(step,'The selected process step does not exist.');check(step.evidence.media,'This step has no source clip. Record or select source evidence first.');
  const start=s.start_s,end=s.end_s;
  check(typeof start==='number'&&Number.isFinite(start)&&start>=0&&typeof end==='number'&&Number.isFinite(end)&&end>=start,'Use a finite source range with end at or after start.');
  check(p.coverage.total_s===null||end<=p.coverage.total_s,'Range exceeds the source duration.');
  check(step.evidence.spans.some(span=>start>=span.start_s&&end<=span.end_s),'Choose a range within one of this step’s recorded evidence spans; unseen intervals are not evidence.');
  return {process_id:id,process_revision:rev,step_id:stepId,media:step.evidence.media,sha256:await mediaDigest(root,step.evidence.media),start_s:start,end_s:end};
}
/** Create, explicitly review, or re-anchor a link with optimistic revisions and retry receipts. */
export async function spatialCommand(root: string, raw: unknown): Promise<SpatialAssociation> {
  const input=object(raw),request=words(input.request_id,'Request ID'),key='spatial-request:'+hash(request),digest=hash(input);
  const receipt=():SpatialAssociation|null=>withDb(root,db=>{const r=doc<{digest:string;result:SpatialAssociation}>(db,key);if(!r)return null;check(r.digest===digest,'Request ID was already used with different input.');return r.result;});
  const prior=receipt();if(prior)return prior;
  check(['save','review'].includes(String(input.command)),'Use save or review.');
  const reason=words(input.reason,'Review reason');const review=input.review as AssociationReview;
  check(['proposed','ambiguous','confirmed','rejected'].includes(review),'Choose proposed, ambiguous, confirmed or rejected.');
  const id=input.id===undefined?randomUUID():words(input.id,'Association');
  check(input.command!=='review'||input.id!==undefined,'Review requires an existing association.');
  const source=input.command==='save'?await validateSource(root,input.source):null;
  const target=input.command==='save'?spatialTarget(input.target):null;
  const origin=input.origin??'human';check(['human','model'].includes(String(origin)),'Invalid origin.');
  check(input.command!=='save'||origin!=='model'||review==='proposed'||review==='ambiguous','Automated associations must remain proposed or ambiguous until human review.');
  return withDb(root,db=>{
    db.exec('BEGIN IMMEDIATE');try {
      const repeated=doc<{digest:string;result:SpatialAssociation}>(db,key);if(repeated){check(repeated.digest===digest,'Request ID was already used with different input.');db.exec('COMMIT');return repeated.result;}
      const existing=doc<SpatialAssociation>(db,'spatial-association:'+id);
      check(input.id===undefined||existing,'Association not found.');
      if(existing)check(existing.revision===input.revision,'Stale association revision. Reload before reviewing.','STALE_ASSOCIATION');
      if(source){const latest=db.prepare('SELECT MAX(rev) AS rev FROM processes WHERE id=?').get(source.process_id);check(latest?.rev===source.process_revision,'Stale process revision. Reload before linking.','STALE_PROCESS');}
      if(target?.kind==='spot')check(db.prepare('SELECT id FROM spots WHERE id=?').get(target.spot_id),'Work area no longer exists.');
      const now=new Date().toISOString();
      const result:SpatialAssociation={schema:'spatial-evidence/1',id,revision:(existing?.revision??0)+1,source:source??existing!.source,target:target??existing!.target,origin:existing?.origin??origin as 'human'|'model',review,reason,created_at:existing?.created_at??now,updated_at:now,
        history:existing?[...existing.history,{revision:existing.revision,source:existing.source,target:existing.target,review:existing.review,reason:existing.reason,at:existing.updated_at}]:[]};
      if(!existing){const same=all(db).find(a=>hash([a.source,a.target])===hash([result.source,result.target]));if(same){check(same.review===result.review&&same.origin===result.origin,'This evidence/location link already exists. Review the existing association.');saveDoc(db,key,{digest,result:same});db.exec('COMMIT');return same;}}
      saveDoc(db,'spatial-association:'+id,result);saveDoc(db,key,{digest,result});db.exec('COMMIT');return result;
    }catch(e){db.exec('ROLLBACK');throw e;}
  });
}
/** Resolve reference freshness and evidence integrity separately from the human identity decision. */
export async function spatialEvidenceView(root: string, reader: OiReferenceReader=oiReferenceReader(root)) {
  const processes=await Promise.all((await listProcesses(root)).map(p=>readProcess(root,p.process_id)));
  const spots=withDb(root,db=>db.prepare('SELECT id,name FROM spots ORDER BY name').all() as Array<{id:string;name:string}>);
  const associations=listSpatialAssociations(root), inspections=new Map<string,Promise<OiReferenceInspection>>(), media=new Map<string,Promise<string>>();
  const views:AssociationView[]=await Promise.all(associations.map(async a=>{
    const issues:AssociationView['issues']=[];let p:ProcessDoc|null=null;
    try{p=await readProcess(root,a.source.process_id,a.source.process_revision);}catch{issues.push({code:'process_missing',message:'The pinned process revision is unavailable.'});}
    const latest=processes.find(p=>p.id===a.source.process_id);
    if(latest&&latest.rev!==a.source.process_revision)issues.push({code:'process_stale',message:'The process changed. Review and explicitly re-anchor this link; its original evidence is retained.'});
    if(latest&&!latest.steps.some(s=>s.id===a.source.step_id))issues.push({code:'step_missing',message:'The step was removed from the current process. This is a historical link.'});
    const step=p?.steps.find(s=>s.id===a.source.step_id);let evidenceUrl:string|null=null;
    try{if(!media.has(a.source.media))media.set(a.source.media,mediaDigest(root,a.source.media));const digest=await media.get(a.source.media);if(digest!==a.source.sha256)issues.push({code:'media_changed',message:'Source bytes no longer match the linked evidence. Playback is disabled.'});else evidenceUrl='/media/'+encodeURIComponent(a.source.media)+'#t='+a.source.start_s+(a.source.end_s>a.source.start_s?','+a.source.end_s:'');}catch{issues.push({code:'media_missing',message:'The linked source clip is unavailable. Restore its original bytes to open it.'});}
    let spatial:OiReferenceInspection|null=null,targetLabel='Unknown location';
    if(a.target.kind==='spot'){const spotId=a.target.spot_id;const spot=spots.find(s=>s.id===spotId);targetLabel=spot?.name??'Missing work area';if(!spot)issues.push({code:'spot_missing',message:'The named work area no longer exists. No substitute was selected.'});}
    else {const target=a.target;targetLabel='OI '+target.entity_kind;try{const key=hash(a.target);if(!inspections.has(key))inspections.set(key,reader(a.target));spatial=await inspections.get(key)!;targetLabel=a.target.entity_kind==='scene'?spatial.name:spatial.entities.find(e=>e.id===target.entity_id)?.name??('Unresolved OI '+target.entity_kind);
      if(spatial.mock)issues.push({code:'mock_oi',message:'Synthetic OI response; this does not verify a real location.'});
      if(spatial.entity_state!=='present')issues.push({code:'entity_'+spatial.entity_state,message:spatial.entity_state==='missing'?'The entity is absent from the pinned scene revision.':'The pinned OI interface cannot resolve this region/equipment reference. Keep it unresolved.'});
      if(spatial.head_revision!==a.target.revision)issues.push({code:'scene_stale',message:`OI is now at revision ${spatial.head_revision}; this association remains pinned to revision ${a.target.revision}.`});
      if(spatial.head_entity_state==='missing')issues.push({code:'entity_missing_at_head',message:'The entity is absent from the current scene. No similar object was substituted.'});
      if(spatial.changed)issues.push({code:'entity_changed',message:'OI reports different instance/asset metadata, including any pose change. Review this identity in the current scene.'});
      issues.push({code:spatial.scale==='unscaled'?'unscaled':'scale_unknown',message:spatial.scale_reason});
    }catch(error){issues.push({code:(error as {code?:string}).code==='SCENE_UNAVAILABLE'?'scene_unavailable':'oi_unavailable',message:'Cannot verify this OI reference: '+(error as Error).message});}}
    if(a.review!=='confirmed')issues.push({code:'identity_'+a.review,message:a.review==='ambiguous'?'Cross-visit identity is unresolved. No automatic relinking.':a.review==='rejected'?'This association was rejected and is retained only for history.':'This proposed association needs human review.'});
    return {association:a,process_title:p?.title??'Unavailable process',step_label:step?.label??'Unavailable step',target_label:targetLabel,issues,current:a.review==='confirmed'&&issues.every(i=>i.code==='scale_unknown'||i.code==='unscaled'),evidence_url:evidenceUrl,spatial};
  }));
  const scenes=withDb(root,db=>db.prepare('SELECT DISTINCT scene_id,revision FROM oi_links ORDER BY scene_id,revision').all() as Array<{scene_id:string;revision:number}>);
  for(const a of associations){const target=a.target;if(target.kind==='oi'&&!scenes.some(s=>s.scene_id===target.scene_id&&s.revision===target.revision))scenes.push({scene_id:target.scene_id,revision:target.revision});}
  return {schema:'spatial-evidence-view/1' as const,processes:processes.map(p=>({id:p.id,revision:p.rev,title:p.title,steps:p.steps.map(s=>({id:s.id,label:s.label,media:s.evidence.media,spans:s.evidence.spans})),total_s:p.coverage.total_s})),spots,scenes,associations:views};
}
