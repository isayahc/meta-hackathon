import type { Cell } from './record-model.js';
// Durable actions: the checkable next steps from a video scan, persisted
// per calendar event so checklist state survives refresh. Actions are
// deliberately NOT goals: completing every action on an entry never closes
// anything in the goals table. Reviewed contribution links live in task metadata.
// Persistence uses the selected project record backend (lib/records).
import { withRecords } from './records.js';
import { editTask, planningView } from './task-planning.js';

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
  return await withRecords(root, (db) =>
    (
      db.select('actions', { where: { event_id: eventId }, order: ["idx"], fields: ["id","event_id","idx","text","status","created_at","updated_at"] }) as unknown as ActionRow[]
    ).map(toAction)
  );
}

// Insert one row per step, skipping ones already stored. Stable ids:
// `<eventId>-a<idx>`. Idempotent — safe to call on every read.
export async function syncActions(root: string, eventId: string, steps: string[]): Promise<VideoAction[]> {
  const clean = steps.map((s) => String(s ?? '').trim()).filter(Boolean);
  return await withRecords(root, (db) => {
    const now = new Date().toISOString();
    const ins = (_p0: Cell, _p1: Cell, _p2: Cell, _p3: Cell, _p4: Cell, _p5: Cell, _p6: Cell) => db.insert('actions', { id: _p0, event_id: _p1, idx: _p2, text: _p3, status: _p4, created_at: _p5, updated_at: _p6 }, { conflict: ["event_id","idx"], ignore: true });
    clean.forEach((text, idx) => {
      ins(`${eventId}-a${idx}`, eventId, idx, text, 'open', now, now);
    });
    return (
      db.select('actions', { where: { event_id: eventId }, order: ["idx"], fields: ["id","event_id","idx","text","status","created_at","updated_at"] }) as unknown as ActionRow[]
    ).map(toAction);
  });
}

const ALLOWED: ReadonlySet<string> = new Set(['open', 'done']);

export async function setActionStatus(root: string, id: string, status: string): Promise<VideoAction> {
  if (!ALLOWED.has(status)) {
    throw new Error(`Bad status "${status}": want open or done.`);
  }
  const task = (await planningView(root)).tasks.find(t => t.id === id);
  if (!task) throw new Error(`No action "${id}".`);
  await editTask(root, id, task.revision, { execution: status === 'done' ? 'done' : 'open' }, 'Checklist status changed by operator');
  return await withRecords(root, (db) => {
    const row = db.first('actions', { where: { id: id }, fields: ["id","event_id","idx","text","status","created_at","updated_at"] }) as unknown as ActionRow | undefined;
    if (!row) throw new Error(`No action "${id}".`);
    return toAction(row);
  });
}

