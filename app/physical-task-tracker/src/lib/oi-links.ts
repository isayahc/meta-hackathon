// OI references for Field Ops entities. A spot or goal links to OI scenes
// and entities by id only — geometry, validation, and revisions stay in OI.
// Links survive reopening the project (they live in fieldops.db).
import type { DatabaseSync } from 'node:sqlite';
import { withDb } from './db.js';

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
  return withDb(root, (db) => {
    const now = new Date().toISOString();
    const upsert = db.prepare(
      'INSERT INTO oi_links(entity_kind, entity_id, scene_id, revision, oi_entity_id, oi_revision, role, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?) ' +
        'ON CONFLICT(entity_kind, entity_id, oi_entity_id) DO UPDATE SET scene_id = excluded.scene_id, revision = excluded.revision, oi_revision = excluded.oi_revision, role = excluded.role, updated_at = excluded.updated_at'
    );
    for (const link of links) {
      if (!link.scene_id.trim() || !link.oi_entity_id.trim()) {
        throw new Error('OI link needs scene_id and oi_entity_id.');
      }
      if (!Number.isInteger(link.revision) || link.revision < 1) {
        throw new Error('OI link needs a positive integer revision.');
      }
      upsert.run(kind, id, link.scene_id, link.revision, link.oi_entity_id, link.oi_revision ?? '', link.role ?? 'space', now);
    }
    return readOiLinksSync(db, kind, id);
  });
}

// Read-through for reopen: every OI reference attached to this entity.
export async function readOiLinks(root: string, kind: OiEntityKind, id: string): Promise<OiLink[]> {
  checkKind(kind);
  return withDb(root, (db) => readOiLinksSync(db, kind, id));
}

function readOiLinksSync(db: DatabaseSync, kind: OiEntityKind, id: string): OiLink[] {
  const rows = db.prepare('SELECT entity_kind, entity_id, scene_id, revision, oi_entity_id, oi_revision, role, updated_at FROM oi_links WHERE entity_kind = ? AND entity_id = ? ORDER BY oi_entity_id').all(kind, id) as unknown as OiLink[];
  return rows;
}

export async function unlinkOiEntity(root: string, kind: OiEntityKind, id: string, oiEntityId: string): Promise<boolean> {
  checkKind(kind);
  return withDb(root, (db) => {
    const res = db.prepare('DELETE FROM oi_links WHERE entity_kind = ? AND entity_id = ? AND oi_entity_id = ?').run(kind, id, oiEntityId);
    return Number(res.changes) > 0;
  });
}
