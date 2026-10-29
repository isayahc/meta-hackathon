// Spot state: folders + JSON giving each tracked spot a memory.
// Layout under a project root:
//   spots/<spot-id>/spot.json                  { id, name, created }
//   spots/<spot-id>/sessions/<timestamp>/analysis.json
//   spots/<spot-id>/state.json                 { stage, summary, open_issues,
//                                                session_ids, updated_at }
// No dependencies. Node 18+.

import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

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
  [key: string]: unknown;
}

export function spotDir(root: string, id: string): string {
  return join(root, 'spots', id);
}

export async function initSpot(
  root: string,
  id: string,
  name: string | null = null
): Promise<{ dir: string; meta: SpotMeta; state: SpotState }> {
  const dir = spotDir(root, id);
  await mkdir(join(dir, 'sessions'), { recursive: true });
  const meta: SpotMeta = {
    id,
    name: name ?? id,
    created: new Date().toISOString(),
  };
  await writeFile(join(dir, 'spot.json'), JSON.stringify(meta, null, 2));
  const state: SpotState = {
    stage: 'unobserved',
    summary: '',
    open_issues: [],
    session_ids: [],
    updated_at: meta.created,
  };
  await writeFile(join(dir, 'state.json'), JSON.stringify(state, null, 2));
  return { dir, meta, state };
}

export async function readState(root: string, id: string): Promise<SpotState> {
  const raw = await readFile(join(spotDir(root, id), 'state.json'), 'utf8');
  return JSON.parse(raw) as SpotState;
}

export async function listSessions(root: string, id: string): Promise<string[]> {
  const dir = join(spotDir(root, id), 'sessions');
  return (await readdir(dir)).sort();
}

// Append a model analysis as a new session and fold it into state.json.
export async function appendSession(
  root: string,
  id: string,
  analysis: VisitAnalysis,
  sessionId: string | null = null
): Promise<{ sessionId: string; state: SpotState }> {
  const dir = spotDir(root, id);
  const sid = sessionId ?? new Date().toISOString().replace(/[:.]/g, '-');
  const sessionDir = join(dir, 'sessions', sid);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, 'analysis.json'), JSON.stringify(analysis, null, 2));
  let state: SpotState;
  try {
    state = await readState(root, id);
  } catch {
    await initSpot(root, id);
    state = await readState(root, id);
  }
  const next: SpotState = {
    stage: (analysis.stage ?? analysis.progress_delta ?? state.stage) as string,
    summary: (analysis.suggested_state_update ?? state.summary) as string,
    open_issues: Array.isArray(analysis.new_issues)
      ? (analysis.new_issues as string[])
      : state.open_issues,
    session_ids: [...new Set([...(state.session_ids ?? []), sid])],
    updated_at: new Date().toISOString(),
  };
  await writeFile(join(dir, 'state.json'), JSON.stringify(next, null, 2));
  return { sessionId: sid, state: next };
}
