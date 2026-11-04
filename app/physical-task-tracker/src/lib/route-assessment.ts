/** Consumer types and transport only; spatial arithmetic lives in the pinned OI runtime adapter. */
import { OiRunnerTransport, resolveOiRoot, type OiTransport } from './oi-connector.js';
import type { ReconstructionRequest, ReconstructionVector } from './reconstruction.js';
export interface RouteAssessmentRequest {
  schema:'oi-route-assessment/1';scene_id:string;revision:number;frame:'oi-world-m-Y-up';station_ids:[string,string];
  route:ReconstructionVector[];profile:{kind:'person'|'cart';width_m:number|null;margin_m:number|null;source:string};
  evidence:ReconstructionRequest['source']['artifacts'];scale:ReconstructionRequest['scale'];
  environment:{coverage:'complete'|'partial';source:string;unknowns:string[]};
  space:{document:Record<string,unknown>;sha256:string;from_region:string;to_region:string;source:string}|null;
  alternative:{id:string;expected_base_revision:number;positions:Array<{entity_id:string;position:ReconstructionVector}>}|null;
}
export interface RouteCheck {id:string;status:'passed'|'failed'|'unknown'|'unsupported';reason:string;[key:string]:unknown}
export interface RouteAssessment {
  schema:'oi-route-assessment/1';scene_id:string;revision:number;head_revision:number;input_digest:string;result_digest:string;
  checks:RouteCheck[];geometric_path_length_m:number|null;validated_walkable_route_length_m:null;
  traversability:'failed'|'unknown';stale:boolean;mutations:0;mock:boolean;[key:string]:unknown;
}
/** Refuse malformed responses and any claim beyond this version's physical-applicability boundary. */
export function readRouteAssessment(value:unknown,request:RouteAssessmentRequest):RouteAssessment {
  const r=value as RouteAssessment;
  if(!r||r.schema!=='oi-route-assessment/1'||r.scene_id!==request.scene_id||r.revision!==request.revision||
      !Number.isSafeInteger(r.head_revision)||r.head_revision<r.revision||typeof r.stale!=='boolean'||typeof r.mock!=='boolean'||
      !/^[a-f0-9]{64}$/.test(r.input_digest)||!/^[a-f0-9]{64}$/.test(r.result_digest)||
      !Array.isArray(r.checks)||!r.checks.length||r.checks.some(c=>!c||typeof c.id!=='string'||typeof c.reason!=='string'||!['passed','failed','unknown','unsupported'].includes(c.status))||
      !(r.geometric_path_length_m===null||(Number.isFinite(r.geometric_path_length_m)&&r.geometric_path_length_m>0))||
      r.validated_walkable_route_length_m!==null||!['failed','unknown'].includes(r.traversability)||r.mutations!==0)
    throw new Error('Malformed or unsupported OI route assessment.');
  return r;
}
/** Run a discovered operation without starting the app or committing scene changes. */
export async function routeAssessmentCommand(action:'capabilities'|'assess'|'compare',payload:Record<string,unknown>,
  transport:OiTransport=new OiRunnerTransport(resolveOiRoot())):Promise<unknown>{
  const result=await transport.request('route-assessment',{...payload,action});
  return action==='assess'?readRouteAssessment(result,payload.request as RouteAssessmentRequest):result;
}
