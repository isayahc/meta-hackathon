// Spot state: each tracked spot keeps a standing memory in fieldops.db.
//   spots      one row per spot: name, stage, summary, open_issues,
//              session_ids, updated_at
//   sessions   one row per visit: spot_id, analysis JSON
// No dependencies beyond node:sqlite (via lib/db).
import { withRecords } from './records.js';
import type { SpotBrief } from './analyze-response.js';

export interface SpotMeta {
  id: string;
  name: string;
  created: string;
}

export interface SpotState {
  stage: string;
  summary: string;
  open_issues: string[];
  session_ids: string[];
  updated_at: string;
}

// Compare/diff model output folded into state on every session.
export interface VisitAnalysis {
  stage?: string;
  progress_delta?: string;
  suggested_state_update?: string;
  new_issues?: string[];
  same_location?: boolean;
  [key: string]: unknown;
}

interface SpotRow {
  id: string;
  name: string;
  stage: string;
  summary: string;
  open_issues: string;
  session_ids: string;
  updated_at: string;
  created: string;
}

function parseList(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export async function initSpot(
  root: string,
  id: string,
  name: string | null = null
): Promise<{ meta: SpotMeta; state: SpotState }> {
  return await withRecords(root, (db) => {
    const now = new Date().toISOString();
    db.insert('spots', { id: id, name: name ?? id, stage: 'unobserved', summary: '', open_issues: '[]', session_ids: '[]', updated_at: now, created: now }, { conflict: ["id"], ignore: true });
    const row = db.first('spots', { where: { id: id }, fields: ["id","name","stage","summary","open_issues","session_ids","updated_at","created"] }) as unknown as SpotRow;
    return {
      meta: { id: row.id, name: row.name, created: row.created },
      state: {
        stage: row.stage,
        summary: row.summary,
        open_issues: parseList(row.open_issues),
        session_ids: parseList(row.session_ids),
        updated_at: row.updated_at,
      },
    };
  });
}

export async function readState(root: string, id: string): Promise<SpotState> {
  return await withRecords(root, (db) => {
    const row = db.first('spots', { where: { id: id }, fields: ["stage","summary","open_issues","session_ids","updated_at"] }) as
      | Omit<SpotRow, 'id' | 'name' | 'created'>
      | undefined;
    if (!row) throw new Error(`No spot "${id}".`);
    return {
      stage: row.stage,
      summary: row.summary,
      open_issues: parseList(row.open_issues),
      session_ids: parseList(row.session_ids),
      updated_at: row.updated_at,
    };
  });
}

export async function listSessions(root: string, id: string): Promise<string[]> {
  return await withRecords(root, (db) =>
    (
      db.select('sessions', { where: { spot_id: id }, order: ["created","sid"], fields: ["sid"] }) as unknown as Array<{ sid: string }>
    ).map((r) => r.sid)
  );
}

export async function readSession(root: string, id: string, sessionId: string): Promise<VisitAnalysis> {
  return await withRecords(root, (db) => {
    const row = db.first('sessions', { where: { sid: sessionId, spot_id: id }, fields: ["analysis"] }) as unknown as
      | { analysis: string }
      | undefined;
    if (!row) throw new Error(`No session "${sessionId}" for spot "${id}".`);
    return JSON.parse(row.analysis) as VisitAnalysis;
  });
}

// Append a model analysis as a new session and fold it into spot state.
export async function appendSession(
  root: string,
  id: string,
  analysis: VisitAnalysis,
  sessionId: string | null = null
): Promise<{ sessionId: string; state: SpotState; quarantined: boolean }> {
  return await withRecords(root, (db) => {
    const sid = sessionId ?? new Date().toISOString().replace(/[:.]/g, '-');
    let row = db.first('spots', { where: { id: id }, fields: ["stage","summary","open_issues","session_ids","updated_at"] }) as
      | Omit<SpotRow, 'id' | 'name' | 'created'>
      | undefined;
    if (!row) {
      const now = new Date().toISOString();
      db.insert('spots', { id: id, name: id, stage: 'unobserved', summary: '', open_issues: '[]', session_ids: '[]', updated_at: now, created: now });
      row = { stage: 'unobserved', summary: '', open_issues: '[]', session_ids: '[]', updated_at: now };
    }
    const state: SpotState = {
      stage: row.stage,
      summary: row.summary,
      open_issues: parseList(row.open_issues),
      session_ids: parseList(row.session_ids),
      updated_at: row.updated_at,
    };
    db.insert('sessions', { sid: sid, spot_id: id, analysis: JSON.stringify(analysis), created: new Date().toISOString() }, { ignore: true });
    // Verification gate (minimum viable): the session is always recorded
    // for the audit trail, but standing state only folds trusted analyses.
    // same_location === false means the model doubts the visit matches this
    // spot — keep prior stage/summary/issues untouched (quarantined).
    const trusted = analysis.same_location !== false;
    const next: SpotState = trusted
      ? {
          stage: (analysis.stage ?? analysis.progress_delta ?? state.stage) as string,
          summary: (analysis.suggested_state_update ?? state.summary) as string,
          open_issues: Array.isArray(analysis.new_issues)
            ? (analysis.new_issues as string[])
            : state.open_issues,
          session_ids: [...new Set([...(state.session_ids ?? []), sid])],
          updated_at: new Date().toISOString(),
        }
      : {
          ...state,
          session_ids: [...new Set([...(state.session_ids ?? []), sid])],
          updated_at: new Date().toISOString(),
        };
    db.update('spots', { id: id }, { stage: next.stage, summary: next.summary, open_issues: JSON.stringify(next.open_issues), session_ids: JSON.stringify(next.session_ids), updated_at: next.updated_at });
    return { sessionId: sid, state: next, quarantined: !trusted };
  });
}

// Every spot with standing state, for briefings, the optimizer, and the
// dashboard overview. Replaces the three copies of spots-dir walking.
export async function listSpotBriefs(root: string): Promise<SpotBrief[]> {
  return await withRecords(root, (db) => {
    const rows = db.select('spots', { order: ["id"], fields: ["id","name","stage","summary","open_issues","session_ids","updated_at"] }) as Array<
      Omit<SpotRow, 'created'>
    >;
    const counts = new Map<string, number>();
    for (const r of db.counts('sessions', 'spot_id') as Array<{ spot_id: string; n: number }>) {
      counts.set(r.spot_id, r.n);
    }
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      stage: r.stage,
      summary: r.summary,
      open_issues: parseList(r.open_issues),
      session_count: counts.get(r.id) ?? parseList(r.session_ids).length,
      updated_at: r.updated_at,
    }));
  });
}

// Recent session ids per spot, newest first — for the overview feed.
export async function recentSessions(root: string, id: string, limit = 5): Promise<string[]> {
  const all = await listSessions(root, id);
  return all.slice(-limit).reverse();
}

