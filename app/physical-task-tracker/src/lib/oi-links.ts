import type { Cell } from './record-model.js';
// OI references for Field Ops entities. A spot or goal links to OI scenes
// and entities by id only — geometry, validation, and revisions stay in OI.
// Links survive reopening the project (they live in fieldops.db).
import type { RecordTransaction } from './record-model.js';
import { withRecords } from './records.js';

export type OiEntityKind = 'spot' | 'goal';

export interface OiLinkInput {
  scene_id: string;
  revision: number;
  oi_entity_id: string;
  oi_revision?: string;
  role?: string;
}

export interface OiLink extends Required<OiLinkInput> {
  entity_kind: OiEntityKind;
  entity_id: string;
  updated_at: string;
}

function checkKind(kind: string): asserts kind is OiEntityKind {
  if (kind !== 'spot' && kind !== 'goal') throw new Error(`Bad OI link kind "${kind}": want spot or goal.`);
}

export async function linkOiEntities(
  root: string,
  kind: OiEntityKind,
  id: string,
  links: OiLinkInput[]
): Promise<OiLink[]> {
  checkKind(kind);
  if (!id.trim()) throw new Error('OI link needs an entity id.');
  return await withRecords(root, (db) => {
    const now = new Date().toISOString();
    const upsert = (_p0: Cell, _p1: Cell, _p2: Cell, _p3: Cell, _p4: Cell, _p5: Cell, _p6: Cell, _p7: Cell) => db.insert('oi_links', { entity_kind: _p0, entity_id: _p1, scene_id: _p2, revision: _p3, oi_entity_id: _p4, oi_revision: _p5, role: _p6, updated_at: _p7 }, { conflict: ["entity_kind","entity_id","oi_entity_id"], update: ["scene_id","revision","oi_revision","role","updated_at"] });
    for (const link of links) {
      if (!link.scene_id.trim() || !link.oi_entity_id.trim()) {
        throw new Error('OI link needs scene_id and oi_entity_id.');
      }
      if (!Number.isInteger(link.revision) || link.revision < 1) {
        throw new Error('OI link needs a positive integer revision.');
      }
      upsert(kind, id, link.scene_id, link.revision, link.oi_entity_id, link.oi_revision ?? '', link.role ?? 'space', now);
    }
    return readOiLinksSync(db, kind, id);
  });
}

// Read-through for reopen: every OI reference attached to this entity.
export async function readOiLinks(root: string, kind: OiEntityKind, id: string): Promise<OiLink[]> {
  checkKind(kind);
  return await withRecords(root, (db) => readOiLinksSync(db, kind, id));
}

function readOiLinksSync(db: RecordTransaction, kind: OiEntityKind, id: string): OiLink[] {
  const rows = db.select('oi_links', { where: { entity_kind: kind, entity_id: id }, order: ["oi_entity_id"], fields: ["entity_kind","entity_id","scene_id","revision","oi_entity_id","oi_revision","role","updated_at"] }) as unknown as OiLink[];
  return rows;
}

export async function unlinkOiEntity(root: string, kind: OiEntityKind, id: string, oiEntityId: string): Promise<boolean> {
  checkKind(kind);
  return await withRecords(root, (db) => {
    const res = db.remove('oi_links', { entity_kind: kind, entity_id: id, oi_entity_id: oiEntityId });
    return Number(res.changes) > 0;
  });
}

