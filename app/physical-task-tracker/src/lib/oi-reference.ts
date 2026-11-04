/** Read-only reference inspection through the existing pinned OI connector. */
import { join } from 'node:path';
import { OiRunnerTransport, OiError, resolveOiRoot, readOiIdentity, OI_DEFAULT_WORKBENCH_ORIGIN, type OiTransport } from './oi-connector.js';

export interface OiReference {
  kind: 'oi'; scene_id: string; revision: number;
  entity_kind: 'scene' | 'instance' | 'region' | 'occupancy'; entity_id: string;
}
/** A projection of OI's response, never a local spatial validity verdict. */
export interface OiReferenceInspection {
  scene_id: string; revision: number; head_revision: number; name: string;
  entity_state: 'present' | 'missing' | 'unsupported'; head_entity_state: 'present' | 'missing' | 'unsupported';
  changed: boolean | null; scale: 'unknown' | 'unscaled'; scale_reason: string;
  revision_url: string; head_url: string;
  entities: Array<{ id: string; name: string; kind: 'instance' }>;
  mock: boolean;
}
export type OiReferenceReader = (reference: OiReference) => Promise<OiReferenceInspection>;

/** Construct a lazy runtime reader; missing OI is reported when queried, not on app startup. */
export function oiReferenceReader(root: string, transport?: OiTransport): OiReferenceReader {
  return async reference => {
    let runtime = transport;
    if (!runtime) {
      const oiRoot = resolveOiRoot();
      const identity = await readOiIdentity(oiRoot);
      if (!identity.pinned) throw new OiError('OI_PIN_MISMATCH', 'The OI checkout differs from the reviewed connector pin. Use the pinned checkout before verifying links.');
      runtime = new OiRunnerTransport(oiRoot);
    }
    const result = await runtime.request<OiReferenceInspection>('inspect', {
      sceneId: reference.scene_id, revision: reference.revision, entityKind: reference.entity_kind, entityId: reference.entity_id,
      dataDir: process.env.OI_SCENE_DATA_DIR || join(root, 'oi-scenes'), workbenchOrigin: process.env.OI_WORKBENCH_ORIGIN || OI_DEFAULT_WORKBENCH_ORIGIN,
    });
    if (!result || result.scene_id !== reference.scene_id || result.revision !== reference.revision || !Number.isSafeInteger(result.head_revision)
      || result.head_revision < result.revision || !['present','missing','unsupported'].includes(result.entity_state)
      || !['present','missing','unsupported'].includes(result.head_entity_state) || !['unknown','unscaled'].includes(result.scale)
      || !Array.isArray(result.entities) || typeof result.mock !== 'boolean') {
      throw new OiError('OI_BAD_RESPONSE', 'OI returned an incompatible reference inspection. No link was revalidated.');
    }
    for (const link of [result.revision_url, result.head_url]) {
      const url = new URL(link);
      if (!['http:', 'https:'].includes(url.protocol)) throw new OiError('OI_BAD_RESPONSE', 'OI returned an unsupported viewer URL.');
    }
    return result;
  };
}
