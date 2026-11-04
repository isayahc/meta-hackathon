/** Immutable reviewed snapshots over canonical trials; no task engine, training or spatial writes. */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { withDb } from './db.js';
import { evaluateTrial, outcomeView, type InterventionTrial, type TrialVisit, type OutcomeStatus } from './outcomes.js';
import { validateProcess } from './processes.js';
import { listSpatialAssociations, spatialTarget, type SpatialAssociation } from './spatial-evidence.js';
import { oiReferenceReader, type OiReferenceReader } from './oi-reference.js';
import type { Journey } from './journey.js';
import type { EvidenceSource } from './reconciliation.js';

export type Split = 'development' | 'validation' | 'test';
export interface Episode {
  schema: 'workflow-episode/1'; id: string; revision: number; created_at: string;
  workflow_id: string | null; trial_id: string; visit_id: string; role: 'baseline' | 'followup';
  mode: 'live' | 'replay' | 'synthetic'; trial: InterventionTrial; spatial: SpatialAssociation[];
  sources: Array<{ visit_id: string; identity: string; session: string; checksum: string | null; media: string | null; assets: Array<{media:string;checksum:string}>; recorded_at: string | null; observed_at: string; snapshot_digest: string }>;
  transition: { observed: TrialVisit['context']; observed_steps: TrialVisit['process_snapshot']['steps']; proposed_action: string; subsequent_state: null; unknowns: string[] };
  review: { reviewer: string; reason: string; expected_status: OutcomeStatus; at: string };
  permissions: { metadata_export: boolean; media_export: boolean; training: boolean; authority: string };
  provenance: { policy_type: 'explicit_rules'; model: string; prompt_version: string; run_id: string; runtime: string };
  previous_digest: string | null;
}
export interface Dataset {
  schema: 'workflow-dataset/1'; id: string; version: number; created_at: string; inclusion_criteria: string;
  members: Array<{ id: string; revision: number; digest: string; split: Split }>;
}
export interface PolicyResult { status: OutcomeStatus; next_action: string; action: 'resolve_evidence' | 'review_result'; completed: false; evidence_digest: string; metrics: ReturnType<typeof evaluateTrial>['metrics'] }
export interface Evaluation {
  schema: 'workflow-evaluation/1'; id: string; created_at: string; dataset: Dataset; policy: typeof POLICY;
  split: 'validation' | 'test'; results: Array<{ episode_id: string; revision: number; mode: Episode['mode']; expected: OutcomeStatus; prediction: PolicyResult; checks: Record<string, boolean> }>;
  passed: number; total: number; limitations: string[];
}
export interface Bundle { schema: 'workflow-bundle/1'; dataset: Dataset; episodes: Episode[]; evaluations: Evaluation[]; manifest: { algorithm: 'sha256'; digest: string; media: 'references_only'; runtime: string; executable: false } }
export const POLICY = { id: 'outcome-review-rules', version: createHash('sha256').update(evaluateTrial.toString() + 'lifecycle-adapter/1').digest('hex'), type: 'explicit_rules' as const, model: null, prompt: null, configuration: 'No learned weights; #43 comparator with reviewer decisions withheld.' };
const statuses: OutcomeStatus[] = ['unknown','inconclusive','improved','worse','unchanged'];
function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
function obj(v: unknown): Record<string, any> { check(v && typeof v === 'object' && !Array.isArray(v), 'Expected an object.'); return v as Record<string, any>; }
function words(v: unknown): string { check(typeof v === 'string' && !!v.trim() && v.length <= 4000, 'Nonempty short text required.'); return v.trim(); }
function rev(v: unknown): number { check(Number.isSafeInteger(v) && Number(v) > 0, 'Positive revision required.'); return Number(v); }
function array(v: unknown): any[] { check(Array.isArray(v) && v.length <= 1000, 'Bounded array required.'); return v; }
function date(v: unknown): void { check(typeof v === 'string' && Number.isFinite(Date.parse(v)), 'Valid timestamp required.'); }
/** Stable JSON encoding ignores object insertion order, preserves array order and rejects non-JSON values. */
export function canonical(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') { check(Number.isFinite(v), 'Finite JSON number required.'); return JSON.stringify(v); }
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  check(v && typeof v === 'object', 'JSON value required.'); return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical((v as Record<string, unknown>)[k])).join(',') + '}';
}
export function lifecycleDigest(v: unknown): string { return createHash('sha256').update(canonical(v)).digest('hex'); }
function get<T>(db: DatabaseSync, key: string): T | null { const row = db.prepare('SELECT body FROM docs WHERE key=?').get(key) as { body: string } | undefined; return row ? JSON.parse(row.body) : null; }
function put(db: DatabaseSync, key: string, value: unknown): void { db.prepare('INSERT INTO docs VALUES(?,?,?)').run(key,JSON.stringify(value),new Date().toISOString()); }
function all<T>(db: DatabaseSync, prefix: string): T[] { return (db.prepare('SELECT body FROM docs WHERE key LIKE ? ORDER BY key').all(prefix + '%') as {body:string}[]).map(r => JSON.parse(r.body)); }
function atomic<T>(root: string, fn: (db: DatabaseSync) => T): T { return withDb(root, db => { db.exec('BEGIN IMMEDIATE'); try { const value=fn(db); db.exec('COMMIT'); return value; } catch(e) { db.exec('ROLLBACK'); throw e; } }); }
function episodeKey(id: string, revision: number): string { return `lifecycle-episode:${id}:${revision}`; }
function episode(db: DatabaseSync, id: string, revision: number): Episode { const e=get<Episode>(db,episodeKey(words(id),rev(revision))); check(e,'Episode revision not found.'); return validateEpisode(e); }
function visits(e: Episode): TrialVisit[] { return [e.trial.baseline, ...e.trial.followups].filter((v):v is TrialVisit=>!!v); }
function numberOrNull(v: unknown, positive = false): void { check(v === null || typeof v === 'number' && Number.isFinite(v) && (positive ? v > 0 : v >= 0), 'Invalid measurement or workload.'); }
function validateVisit(raw: unknown): TrialVisit {
  const v=obj(raw); words(v.id); rev(v.revision); date(v.observed_at); words(v.source_identity); words(v.source_digest); canonical(v.source_snapshot);
  check(typeof v.continuous_coverage === 'boolean' && typeof v.quarantined === 'boolean','Coverage flags required.');
  const ref=obj(v.reference); if(ref.kind==='session'){words(ref.spot_id);words(ref.session_id);check(ref.side===undefined||['before','after'].includes(ref.side),'Invalid session side.');}else{check(ref.kind==='evidence','Invalid source reference.');words(ref.source_id);words(ref.interpretation_id);}
  const p=validateProcess(v.process_snapshot);check(p.id===v.process_id&&p.rev===v.process_revision,'Invalid process reference.');
  const w=obj(v.workload);numberOrNull(w.amount,true);words(w.unit);words(w.context);
  const c=obj(v.context);check(c.intervention_applied===null||typeof c.intervention_applied==='boolean','Invalid execution evidence.');check(typeof c.implementation_note==='string','Implementation note required.');
  check(c.quality_passed===null||typeof c.quality_passed==='boolean','Unknown quality must be null.');check(['full','partial','unknown'].includes(c.coverage),'Invalid coverage.');words(c.coverage_note);words(c.quality_criteria);numberOrNull(c.staffing,true);for(const k of ['equipment','conditions'])check(c[k]===null||typeof c[k]==='string','Unknown context must be null.');
  const ids=new Set();for(const m of array(v.measurements)){words(m.metric_id);check(!ids.has(m.metric_id),'Duplicate measurement.');ids.add(m.metric_id);numberOrNull(m.value);words(m.unit);words(m.source);check(['measured','estimated','unknown'].includes(m.kind)&&['operator','instrument','continuous_video','sparse_frames'].includes(m.method),'Invalid measurement provenance.');check(m.kind!=='unknown'||m.value===null,'Unknown value must be null.');}
  return v as TrialVisit;
}
/** Validate a portable snapshot, including references and explicit unknown state transitions. */
export function validateEpisode(raw: unknown): Episode {
  const e=obj(raw);check(e.schema==='workflow-episode/1','Unsupported episode schema.');words(e.id);rev(e.revision);date(e.created_at);check(e.workflow_id===null||typeof e.workflow_id==='string','Invalid workflow.');
  check(['live','replay','synthetic'].includes(e.mode)&&['baseline','followup'].includes(e.role),'Episode mode and role required.');
  const t=obj(e.trial);check(t.schema==='intervention-trial/1'&&t.id===e.trial_id,'Invalid trial reference.');rev(t.revision);date(t.started_at);words(t.workload_unit);
  const ms=array(t.metrics);check(ms.length>0,'Metrics required.');check(new Set(ms.map(m=>m.id)).size===ms.length,'Duplicate metrics.');for(const m of ms){words(m.id);words(m.label);words(m.unit);check(['lower','higher'].includes(m.direction),'Metric direction required.');numberOrNull(m.tolerance);check(m.tolerance!==null,'Tolerance required.');}
  for(const c of array(t.expected_changes)){check(['staffing','equipment','conditions'].includes(c.field),'Invalid context constraint.');check(typeof c.value==='number'||typeof c.value==='string','Expected context value required.');words(c.reason);}
  const vs=[...(t.baseline?[validateVisit(t.baseline)]:[]),...array(t.followups).map(validateVisit)];check(vs.length>0&&new Set(vs.map(v=>v.id)).size===vs.length,'Distinct visits required.');
  const v=vs.find(v=>v.id===e.visit_id);check(v,'Episode visit missing.');check(e.role==='baseline'?t.baseline?.id===v.id:t.followups.some((x:TrialVisit)=>x.id===v.id),'Visit role mismatch.');
  const a=obj(t.assessment),candidate=obj(a.candidate);words(candidate.change);check(candidate.process_id===v.process_id,'Trial process mismatch.');rev(candidate.process_rev);check(['eligible','blocked','deferred'].includes(a.feasibility),'Feasibility required.');array(a.blocked);array(a.unvalidated);array(a.decisions);words(a.decision);
  obj(t.review_snapshot.context.constraints);array(t.decisions);array(t.corrections);
  for(const visit of vs){check(visit.process_id===candidate.process_id&&visit.workload.unit===t.workload_unit,'Visit references incompatible with trial.');for(const m of visit.measurements)check(ms.some(s=>s.id===m.metric_id&&s.unit===m.unit),'Invalid metric reference or unit.');}
  const ss=array(e.sources);check(ss.length===vs.length&&new Set(ss.map(s=>s.visit_id)).size===ss.length,'One source per visit required.');for(const s of ss){const visit=vs.find(v=>v.id===s.visit_id);check(visit&&s.identity===visit.source_identity&&s.snapshot_digest===visit.source_digest,'Invalid evidence reference.');words(s.session);if(s.recorded_at!==null)date(s.recorded_at);date(s.observed_at);check(lifecycleDigest(s)===lifecycleDigest(sourceRecord(visit)),'Source identity/timestamp mismatch.');check(s.checksum===null||/^[a-f0-9]{64}$/.test(s.checksum),'Invalid checksum.');check(s.media===null||typeof s.media==='string'&&s.media===basename(s.media)&&!s.media.includes('\\')&&!s.media.includes('..'),'Invalid media filename.');}
  for(const s of ss)for(const asset of array(s.assets)){words(asset.media);check(asset.media===basename(asset.media)&&!asset.media.includes('\\')&&!asset.media.includes('..')&&/^[a-f0-9]{64}$/.test(asset.checksum),'Invalid retained media reference.');}
  for(const s of array(e.spatial)){spatialTarget(s.target);check(s.review==='confirmed'&&vs.some(v=>v.process_id===s.source.process_id&&v.process_revision===s.source.process_revision),'Invalid spatial reference.');words(s.id);rev(s.revision);}
  for(const visit of vs)check(createHash('sha256').update(JSON.stringify(visit.source_snapshot)).digest('hex')===visit.source_digest,'Source snapshot checksum mismatch.');
  const tr=obj(e.transition);check(tr.subsequent_state===null,'Subsequent state remains unknown; do not infer completion.');check(lifecycleDigest(tr.observed)===lifecycleDigest(v.context),'Observed state mismatch.');check(tr.proposed_action===candidate.change,'Proposed action mismatch.');check(lifecycleDigest(tr.observed_steps)===lifecycleDigest(v.process_snapshot.steps.filter(s=>['observed','corrected'].includes(s.claim))),'Observed action annotations mismatch.');check(array(tr.unknowns).length>0,'Explicit unknowns required.');
  const r=obj(e.review);words(r.reviewer);words(r.reason);date(r.at);check(statuses.includes(r.expected_status),'Reviewed outcome target required.');
  for(const k of ['metadata_export','media_export','training'])check(typeof obj(e.permissions)[k]==='boolean','Explicit permissions required.');words(e.permissions.authority);
  const p=obj(e.provenance);check(p.policy_type==='explicit_rules','Unsupported policy type.');words(p.model);words(p.prompt_version);words(p.run_id);words(p.runtime);
  check(e.previous_digest===null||/^[a-f0-9]{64}$/.test(e.previous_digest),'Invalid prior revision digest.');canonical(e);return e as Episode;
}
function sourceRecord(v: TrialVisit): Episode['sources'][number] {
  const snap=obj(v.source_snapshot);const ref=v.reference;
  const media=ref.kind==='evidence'?snap:obj(snap.analysis?.visit_evidence?.[ref.side??'after']?.source??{});
  const references=ref.kind==='evidence'?[media]:[media,...(snap.analysis?.visit_evidence?.[ref.side??'after']?.frames??[])];
  const assets=references.filter(x=>x.media).map(x=>({media:x.media as string,checksum:x.checksum as string}));
  return {visit_id:v.id,identity:v.source_identity,session:ref.kind==='session'?`session:${ref.spot_id}:${ref.session_id}`:`source:${ref.source_id}`,checksum:media.checksum??null,media:media.media??null,assets:[...new Map(assets.map(a=>[a.media,a])).values()],recorded_at:ref.kind==='evidence'?snap.recorded_at??null:null,observed_at:v.observed_at,snapshot_digest:v.source_digest};
}
/** Capture reviewed canonical visits. Re-capture appends a revision; original predictions/corrections survive. */
export async function captureEpisode(root: string, raw: unknown, reader?: OiReferenceReader): Promise<Episode> {
  const v=obj(raw);const receiptKey=v.request_id?'lifecycle-request:'+lifecycleDigest(words(v.request_id)):null;const receipt=receiptKey?withDb(root,db=>get<{digest:string;episode:Episode}>(db,receiptKey)):null;if(receipt){check(receipt.digest===lifecycleDigest(v),'Request ID reused with different inputs.');return receipt.episode;}
  const entries=outcomeView(root).trials,entry=entries.find(x=>x.trial.id===v.trial_id);check(entry,'Trial not found.');
  const trial=structuredClone(entry.trial);check(trial.revision===v.trial_revision,'Stale trial revision.');
  const visit=[trial.baseline,...trial.followups].find(x=>x?.id===v.visit_id);check(visit,'Visit not found.');
  // Baseline capture must never contain a future follow-up or a later outcome decision.
  const role=trial.baseline?.id===visit.id?'baseline':'followup';trial.followups=role==='baseline'?[]:trial.followups.filter(f=>f.id===visit.id);if(role==='baseline'){trial.decisions=[];trial.corrections=trial.corrections.filter(c=>c.visit_id===visit.id);}
  const spatial=listSpatialAssociations(root).filter(s=>s.review==='confirmed'&&[trial.baseline,...trial.followups].some(p=>p?.process_id===s.source.process_id&&p.process_revision===s.source.process_revision));
  const id=lifecycleDigest({trial:trial.id,visit:visit.id}),previous=withDb(root,db=>all<Episode>(db,'lifecycle-episode:').filter(e=>e.id===id).sort((a,b)=>b.revision-a.revision)[0]);
  const linked=withDb(root,db=>all<Journey>(db,'journey:').filter(j=>[trial.baseline,...trial.followups].some(v=>v?.reference.kind==='evidence'&&j.clips.some(c=>c.source_id===(v.reference as {source_id:string}).source_id))));check(linked.length<=1,'Trial visits span multiple workflows; review their identity before capture.');
  const at=new Date().toISOString();
  const e:Episode={schema:'workflow-episode/1',id,revision:(previous?.revision??0)+1,created_at:at,workflow_id:v.workflow_id??linked[0]?.id??null,trial_id:trial.id,visit_id:visit.id,role,mode:v.mode,trial,spatial,
    sources:[trial.baseline,...trial.followups].filter((x):x is TrialVisit=>!!x).map(sourceRecord),transition:{observed:visit.context,observed_steps:visit.process_snapshot.steps.filter(s=>['observed','corrected'].includes(s.claim)),proposed_action:trial.assessment.candidate.change,subsequent_state:null,unknowns:['Subsequent physical state and task completion are not established by intervention acceptance.',...visit.process_snapshot.unknowns]},
    review:{reviewer:words(v.reviewer),reason:words(v.reason),expected_status:v.expected_status,at},permissions:v.permissions,
    provenance:{policy_type:'explicit_rules',model:visit.process_snapshot.provenance.model||'unknown',prompt_version:visit.process_snapshot.provenance.prompt_version||'unknown',run_id:randomUUID(),runtime:'Node >=22; Field Ops #43 outcome comparator'},previous_digest:previous?lifecycleDigest(previous):null};
  check(e.mode!=='live'||trial.review_snapshot.source==='model','Replay proposals cannot be labeled live.');
  validateEpisode(e);const problems=await episodeProblems(root,e,reader,false);check(!problems.length,problems.join(' '));
  return atomic(root,db=>{const current=get<InterventionTrial>(db,`intervention-trial:${trial.id}`);check(current?.revision===v.trial_revision,'Stale trial revision.');put(db,episodeKey(e.id,e.revision),e);if(receiptKey)put(db,receiptKey,{digest:lifecycleDigest(v),episode:e});return e;});
}
/** Freshness is a view, never an edit to a historical artifact or evaluation. */
export async function episodeProblems(root: string, e: Episode, reader: OiReferenceReader=oiReferenceReader(root), checkNewer=true): Promise<string[]> {
  const issues=withDb(root,db=>{
    const out:string[]=[],current=get<InterventionTrial>(db,`intervention-trial:${e.trial_id}`);if(!current)out.push('Canonical trial unavailable (portable archive only).');
    else {for(const v of visits(e)){const cv=[current.baseline,...current.followups].find(x=>x?.id===v.id);if(!cv||lifecycleDigest(cv)!==lifecycleDigest(v))out.push('Trial visit corrected; recapture episode.');}
      if(lifecycleDigest(current.assessment)!==lifecycleDigest(e.trial.assessment))out.push('Intervention assessment changed.');if(e.role==='followup'&&lifecycleDigest(current.decisions)!==lifecycleDigest(e.trial.decisions))out.push('Trial outcome review changed; recapture feedback.');}
    if(checkNewer&&all<Episode>(db,'lifecycle-episode:').some(x=>x.id===e.id&&x.revision>e.revision))out.push('Episode review superseded.');
    if(e.workflow_id){const w=get<Journey>(db,`journey:${e.workflow_id}`);if(!w||!visits(e).every(v=>v.reference.kind==='evidence'&&w.clips.some(c=>c.source_id===(v.reference as {source_id:string}).source_id)))out.push('Invalid workflow/source reference.');}
    for(const v of visits(e)){
      const p=db.prepare('SELECT MAX(rev) AS rev FROM processes WHERE id=?').get(v.process_id) as {rev:number|null};if(p.rev!==v.process_revision||get(db,`superseded-process:${v.process_id}`))out.push('Process revision stale or unavailable.');
      const ref=v.reference,snap=obj(v.source_snapshot);
      if(ref.kind==='evidence'){const s=get<EvidenceSource>(db,`evidence-source:${ref.source_id}`),i=s?.interpretations.find(x=>x.id===ref.interpretation_id);if(!s||!i||s.checksum!==snap.checksum||lifecycleDigest(i)!==lifecycleDigest(snap.interpretation)||s.interpretations.at(-1)?.id!==ref.interpretation_id)out.push('Evidence missing, corrected or superseded.');}
      else {const row=db.prepare('SELECT analysis FROM sessions WHERE spot_id=? AND sid=?').get(ref.spot_id,ref.session_id) as {analysis:string}|undefined;if(!row||lifecycleDigest(JSON.parse(row.analysis))!==lifecycleDigest(snap.analysis))out.push('Session evidence missing or corrected.');}
    }
    return out;
  });
  const live=outcomeView(root).trials.find(x=>x.trial.id===e.trial_id);if(live)issues.push(...live.result.source_warnings);
  for(const s of e.sources.flatMap(source=>source.assets)){try{const p=join(root,'media',s.media);check(lstatSync(p).isFile()&&!lstatSync(p).isSymbolicLink(),'Missing regular media.');check(createHash('sha256').update(readFileSync(p)).digest('hex')===s.checksum,'Media checksum changed.');}catch{issues.push('Source media missing or checksum changed.');}}
  const currentSpatial=listSpatialAssociations(root);
  for(const s of e.spatial){if(!currentSpatial.some(x=>x.id===s.id&&lifecycleDigest(x)===lifecycleDigest(s)))issues.push('Spatial review corrected or missing.');if(s.target.kind==='oi'){try{const r=await reader(s.target);if(r.mock||r.head_revision!==s.target.revision||r.entity_state!=='present'||r.head_entity_state!=='present')issues.push('OI reference stale, missing or unverified.');}catch{issues.push('OI reference unavailable; cannot verify current geometry.');}}}
  return [...new Set(issues)];
}
function groups(e: Episode): string[] { return [`trial:${e.trial_id}`,...(e.workflow_id?[`workflow:${e.workflow_id}`]:[]),...e.sources.flatMap(s=>[s.session,`identity:${s.identity}`,...(s.checksum?[`checksum:${s.checksum}`]:[])])]; }
/** Reject any shared workflow, session, recording or source bytes across dataset splits. */
export function validateDataset(raw: unknown, episodes: Episode[]): Dataset {
  const d=obj(raw);check(d.schema==='workflow-dataset/1','Unsupported dataset schema.');words(d.id);rev(d.version);date(d.created_at);words(d.inclusion_criteria);
  const members=array(d.members);check(members.length>0&&new Set(members.map(m=>m.id)).size===members.length,'One revision per episode in a nonempty dataset.');
  const assigned=new Map<string,Split>();for(const m of members){check(['development','validation','test'].includes(m.split),'Invalid split.');const e=episodes.find(e=>e.id===m.id&&e.revision===m.revision);check(e&&lifecycleDigest(e)===m.digest,'Episode missing or checksum mismatch.');for(const group of groups(e)){check(!assigned.has(group)||assigned.get(group)===m.split,'Split leakage: related workflows, visits or recordings must stay together.');assigned.set(group,m.split);}}
  return d as Dataset;
}
function createDataset(root:string,raw:unknown):Dataset {const v=obj(raw);return atomic(root,db=>{const es=array(v.members).map(m=>episode(db,m.id,m.revision));const d=validateDataset({schema:'workflow-dataset/1',id:words(v.id),version:rev(v.version),created_at:new Date().toISOString(),inclusion_criteria:words(v.inclusion_criteria),members:v.members.map((m:any,i:number)=>({...m,digest:lifecycleDigest(es[i])}))},es);put(db,`lifecycle-dataset:${d.id}:${d.version}`,d);return d;});}
/** Inference input contains measurements/constraints only: no reviewer labels, decisions, corrections or raw predictions. */
export function policyInput(e: Episode): InterventionTrial {
  const t=e.trial;
  const visit=(v:TrialVisit|null):TrialVisit|null=>v?{id:v.id,revision:v.revision,observed_at:v.observed_at,reference:structuredClone(v.reference),source_digest:v.source_digest,source_identity:v.source_identity,continuous_coverage:v.continuous_coverage,quarantined:v.quarantined,process_id:v.process_id,process_revision:v.process_revision,source_snapshot:null,process_snapshot:null as unknown as TrialVisit['process_snapshot'],notes:'',workload:structuredClone(v.workload),context:{...structuredClone(v.context),implementation_note:'',coverage_note:''},measurements:v.measurements.map(m=>({...m,source:''}))}:null;
  return {schema:t.schema,id:t.id,revision:t.revision,created_at:t.created_at,started_at:t.started_at,registration:t.registration,review_id:t.review_id,candidate_id:t.candidate_id,
    assessment:{candidate:{change:t.assessment.candidate.change}} as InterventionTrial['assessment'],review_snapshot:null as unknown as InterventionTrial['review_snapshot'],metrics:structuredClone(t.metrics),workload_unit:t.workload_unit,expected_changes:structuredClone(t.expected_changes),baseline:visit(t.baseline),registered_baseline:null,followups:t.followups.map(v=>visit(v)!),decisions:[],corrections:[]};
}
/** Reuse the existing comparator, proposing human review; it never performs work or claims completion. */
export function inferPolicy(input: InterventionTrial): PolicyResult {const r=evaluateTrial(input);return {status:r.status,next_action:r.next_action,action:['unknown','inconclusive'].includes(r.status)?'resolve_evidence':'review_result',completed:false,evidence_digest:r.evidence_digest,metrics:r.metrics};}
/** Score the fixed rule's safety contract against separately reviewed targets. */
function scoreChecks(e:Episode,prediction:PolicyResult):Record<string,boolean>{
  return {reviewed_outcome:prediction.status===e.review.expected_status,
    evidence_grounding:prediction.metrics.every(x=>x.baseline===null||!!e.trial.baseline?.measurements.some(y=>y.metric_id===x.metric_id&&y.kind==='measured')),
    action_validity:['resolve_evidence','review_result'].includes(prediction.action),
    constraint_compliance:prediction.action==='resolve_evidence'||evaluateTrial(policyInput(e)).reasons.every(r=>r.startsWith('Follow-up failed')),
    unsupported_completion:prediction.completed===false,
    outcome_comparability:!['improved','worse','unchanged'].includes(prediction.status)||prediction.metrics.every(x=>!['unknown','inconclusive'].includes(x.status))};
}
async function evaluateDataset(root:string,raw:unknown,reader?:OiReferenceReader):Promise<Evaluation>{const v=obj(raw);check(['validation','test'].includes(v.split),'Evaluate held-out validation or test members only.');
  const {d,es}=withDb(root,db=>{const d=get<Dataset>(db,`lifecycle-dataset:${words(v.id)}:${rev(v.version)}`);check(d,'Dataset not found.');return {d,es:d.members.map(m=>episode(db,m.id,m.revision))};});validateDataset(d,es);
  const results:Evaluation['results']=[];for(const m of d.members.filter(m=>m.split===v.split)){const e=es.find(e=>e.id===m.id)!;const issues=await episodeProblems(root,e,reader);check(!issues.length,issues.join(' '));const prediction=inferPolicy(policyInput(e));
    results.push({episode_id:e.id,revision:e.revision,mode:e.mode,expected:e.review.expected_status,prediction,checks:scoreChecks(e,prediction)});
  }check(results.length,'No held-out examples in selected split.');const report:Evaluation={schema:'workflow-evaluation/1',id:randomUUID(),created_at:new Date().toISOString(),dataset:d,policy:POLICY,split:v.split,results,passed:results.filter(r=>Object.values(r.checks).every(Boolean)).length,total:results.length,limitations:['Deterministic replay of stored observations, not live model inference or training.','Checks cover the #43 outcome-review rule only, not novel intervention generation or robot control.','Synthetic/replay cases prove software behavior, not farmer savings or generalization.','No automatic promotion; held-out answers are excluded from policyInput.']};atomic(root,db=>put(db,`lifecycle-evaluation:${report.id}`,report));return report;}
/** Validate portable content before any database write; hashes provide integrity, not trust/authenticity. */
function rejectEmbeddedMedia(value:unknown):void {
  if(typeof value==='string'){check(!/data:[^;,]+;base64,/i.test(value),'References-only bundles cannot contain embedded media.');return;}
  if(Array.isArray(value)){value.forEach(rejectEmbeddedMedia);return;}
  if(value&&typeof value==='object')for(const [key,child]of Object.entries(value)){check(!/(?:base64|image_bytes|video_bytes|audio_bytes)/i.test(key)||child===null||child==='','References-only bundles cannot contain media payload fields.');rejectEmbeddedMedia(child);}
}
export function validateBundle(raw:unknown):Bundle {rejectEmbeddedMedia(raw);const b=obj(raw);check(b.schema==='workflow-bundle/1','Unsupported bundle schema.');const es=array(b.episodes).map(validateEpisode),d=validateDataset(b.dataset,es);check(es.length===d.members.length,'Unexpected bundle episodes.');
  for(const r of array(b.evaluations)){check(r.schema==='workflow-evaluation/1'&&lifecycleDigest(r.dataset)===lifecycleDigest(d),'Invalid evaluation dataset.');words(r.id);date(r.created_at);check(['validation','test'].includes(r.split),'Invalid evaluation split.');check(obj(r.policy).type==='explicit_rules','Unsupported policy.');words(r.policy.version);const expected=d.members.filter(m=>m.split===r.split);check(array(r.results).length===expected.length&&new Set(r.results.map((x:any)=>x.episode_id)).size===expected.length,'Invalid evaluation members.');for(const x of r.results){check(expected.some(m=>m.id===x.episode_id&&m.revision===x.revision),'Invalid result reference.');check(statuses.includes(x.expected)&&statuses.includes(x.prediction.status)&&x.prediction.completed===false,'Invalid evaluation claim.');check(array(x.prediction.metrics).length>0,'Missing metrics.');check(Object.values(obj(x.checks)).every(v=>typeof v==='boolean'),'Invalid check results.');}if(r.policy.version===POLICY.version){for(const x of r.results){const e=es.find(e=>e.id===x.episode_id)!;check(x.expected===e.review.expected_status&&x.mode===e.mode,'Evaluation annotation mismatch.');check(lifecycleDigest(x.prediction)===lifecycleDigest(inferPolicy(policyInput(e))),'Evaluation prediction does not reproduce.');check(lifecycleDigest(x.checks)===lifecycleDigest(scoreChecks(e,x.prediction)),'Evaluation checks do not reproduce.');}}check(r.total===r.results.length&&r.passed===r.results.filter((x:any)=>Object.values(x.checks).every(Boolean)).length,'Invalid evaluation counts.');array(r.limitations);}
  const manifest=obj(b.manifest);check(manifest.algorithm==='sha256'&&manifest.media==='references_only'&&manifest.executable===false,'Invalid manifest.');words(manifest.runtime);check(es.every(e=>e.permissions.metadata_export),'Episode metadata export not permitted.');check(manifest.digest===lifecycleDigest({dataset:d,episodes:es,evaluations:b.evaluations}),'Bundle checksum mismatch.');return b as Bundle;}
function exportBundle(root:string,v:Record<string,any>):Bundle{return withDb(root,db=>{const d=get<Dataset>(db,`lifecycle-dataset:${words(v.id)}:${rev(v.version)}`);check(d,'Dataset not found.');const episodes=d.members.map(m=>episode(db,m.id,m.revision)),evaluations=all<Evaluation>(db,'lifecycle-evaluation:').filter(e=>lifecycleDigest(e.dataset)===lifecycleDigest(d));const payload={dataset:d,episodes,evaluations};return validateBundle({schema:'workflow-bundle/1',...payload,manifest:{algorithm:'sha256',digest:lifecycleDigest(payload),media:'references_only',runtime:'Node >=22; matching Field Ops policy version required for replay',executable:false}});});}
function importBundle(root:string,raw:unknown):unknown {const b=validateBundle(raw);return atomic(root,db=>{const entries:Array<[string,unknown]>=[...b.episodes.map(e=>[episodeKey(e.id,e.revision),e] as [string,unknown]),[`lifecycle-dataset:${b.dataset.id}:${b.dataset.version}`,b.dataset],...b.evaluations.map(e=>[`lifecycle-evaluation:${e.id}`,e] as [string,unknown])];for(const [key,value]of entries){const old=get(db,key);check(!old||lifecycleDigest(old)===lifecycleDigest(value),'Import identity collision; nothing imported.');if(!old)put(db,key,value);}return {imported:entries.length,archive_only:true,dataset:b.dataset};});}
/** Shared API/CLI. Selection is explicit, audited and never changes canonical trial/task decisions. */
export async function lifecycleCommand(root:string,raw:unknown,reader?:OiReferenceReader):Promise<unknown>{const v=obj(raw);
  switch(v.command){case 'capture':return captureEpisode(root,v,reader);case 'dataset':return createDataset(root,v);case 'evaluate':return evaluateDataset(root,v,reader);case 'export':return exportBundle(root,v);case 'import':return importBundle(root,v.bundle);
    case 'replay':{const b=validateBundle(v.bundle);return {mode:'replay',policy:POLICY,archive_only:true,results:b.episodes.map(e=>({episode_id:e.id,revision:e.revision,source_mode:e.mode,prediction:inferPolicy(policyInput(e))})),limitations:['Historical archive; canonical and OI freshness not verified. No live state mutated.']};}
    case 'select':{const r=withDb(root,db=>get<Evaluation>(db,`lifecycle-evaluation:${words(v.evaluation_id)}`));check(r&&r.policy.version===POLICY.version&&r.total>0&&r.passed===r.total,'Select a passing evaluation of the installed policy.');for(const m of r.dataset.members){const e=withDb(root,db=>episode(db,m.id,m.revision));const issues=await episodeProblems(root,e,reader);check(!issues.length,issues.join(' '));}return atomic(root,db=>{const history=all<any>(db,'lifecycle-selection:').sort((a,b)=>a.at.localeCompare(b.at));const s={id:randomUUID(),at:new Date().toISOString(),policy:r.policy,evaluation_id:r.id,reviewer:words(v.reviewer),reason:words(v.reason),previous_selection_id:history.at(-1)?.id??null};put(db,`lifecycle-selection:${s.id}`,s);return s;});}
    case 'infer':{const e=withDb(root,db=>episode(db,v.id,v.revision));const issues=await episodeProblems(root,e,reader);check(!issues.length,issues.join(' '));const selections=withDb(root,db=>all<any>(db,'lifecycle-selection:')).sort((a,b)=>a.at.localeCompare(b.at));check(selections.at(-1)?.policy.version===POLICY.version,'Select an evaluated policy before inference.');const selected=withDb(root,db=>get<Evaluation>(db,`lifecycle-evaluation:${selections.at(-1).evaluation_id}`));check(selected,'Selected evaluation unavailable.');for(const m of selected.dataset.members){const basis=withDb(root,db=>episode(db,m.id,m.revision));const stale=await episodeProblems(root,basis,reader);check(!stale.length,'Selected evaluation stale: '+stale.join(' '));}const run={id:randomUUID(),at:new Date().toISOString(),episode_id:e.id,episode_revision:e.revision,policy:POLICY,mode:'replay',prediction:inferPolicy(policyInput(e)),human_decision:'pending',performed_action:null,outcome:null,feedback_ref:{trial_id:e.trial_id,review_id:e.trial.review_id,candidate_id:e.trial.candidate_id}};atomic(root,db=>put(db,`lifecycle-run:${run.id}`,run));return run;}
    case 'view':{const data=withDb(root,db=>({episodes:all<Episode>(db,'lifecycle-episode:'),datasets:all<Dataset>(db,'lifecycle-dataset:'),evaluations:all<Evaluation>(db,'lifecycle-evaluation:'),selections:all(db,'lifecycle-selection:'),runs:all(db,'lifecycle-run:')}));const episodes=await Promise.all(data.episodes.map(async e=>({episode:e,issues:await episodeProblems(root,e,reader)})));const evaluation_status=data.evaluations.map(r=>({id:r.id,policy_installed:r.policy.version===POLICY.version,stale:r.policy.version!==POLICY.version||r.dataset.members.some(m=>episodes.find(e=>e.episode.id===m.id&&e.episode.revision===m.revision)?.issues.length!==0)}));return {...data,episodes,evaluation_status,policy:POLICY};}
    default:throw new Error('Unknown lifecycle command.');
  }
}
