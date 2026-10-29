// Durable actions: the checkable next steps from a video scan, persisted
// per calendar event so checklist state survives refresh. Actions are
// deliberately NOT goals: completing every action on an entry never closes
// anything in the goals table — no code path connects the two.
// No dependencies beyond node:sqlite (via lib/db).
import { withDb } from './db.js';

export type ActionStatus = 'open' | 'done';

export interface VideoAction {
  id: string;
  event_id: string;
  idx: number;
  text: string;
  status: ActionStatus;
  created_at: string;
  updated_at: string;
}

interface ActionRow {
  id: string;
  event_id: string;
  idx: number;
  text: string;
  status: ActionStatus;
  created_at: string;
  updated_at: string;
}

function toAction(r: ActionRow): VideoAction {
  return {
    id: r.id,
    event_id: r.event_id,
    idx: r.idx,
    text: r.text,
    status: r.status,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export async function listActions(root: string, eventId: string): Promise<VideoAction[]> {
  return withDb(root, (db) =>
    (
      db
        .prepare('SELECT id, event_id, idx, text, status, created_at, updated_at FROM actions WHERE event_id = ? ORDER BY idx')
        .all(eventId) as unknown as ActionRow[]
    ).map(toAction)
  );
}

// Insert one row per step, skipping ones already stored. Stable ids:
// `<eventId>-a<idx>`. Idempotent — safe to call on every read.
export async function syncActions(root: string, eventId: string, steps: string[]): Promise<VideoAction[]> {
  const clean = steps.map((s) => String(s ?? '').trim()).filter(Boolean);
  return withDb(root, (db) => {
    const now = new Date().toISOString();
    const ins = db.prepare(
      'INSERT INTO actions(id, event_id, idx, text, status, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?) ON CONFLICT(event_id, idx) DO NOTHING'
    );
    clean.forEach((text, idx) => {
      ins.run(`${eventId}-a${idx}`, eventId, idx, text, 'open', now, now);
    });
    return (
      db
        .prepare('SELECT id, event_id, idx, text, status, created_at, updated_at FROM actions WHERE event_id = ? ORDER BY idx')
        .all(eventId) as unknown as ActionRow[]
    ).map(toAction);
  });
}

const ALLOWED: ReadonlySet<string> = new Set(['open', 'done']);

export async function setActionStatus(root: string, id: string, status: string): Promise<VideoAction> {
  if (!ALLOWED.has(status)) {
    throw new Error(`Bad status "${status}": want open or done.`);
  }
  return withDb(root, (db) => {
    const row = db
      .prepare('SELECT id, event_id, idx, text, status, created_at, updated_at FROM actions WHERE id = ?')
      .get(id) as unknown as ActionRow | undefined;
    if (!row) throw new Error(`No action "${id}".`);
    db.prepare('UPDATE actions SET status = ?, updated_at = ? WHERE id = ?').run(
      status,
      new Date().toISOString(),
      id
    );
    return toAction({ ...row, status: status as ActionStatus });
  });
}
