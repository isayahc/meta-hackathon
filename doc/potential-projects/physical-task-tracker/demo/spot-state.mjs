// Spot state: folders + JSON giving each tracked spot a memory.
// Layout under a project root:
//   spots/<spot-id>/spot.json                  { id, name, created }
//   spots/<spot-id>/sessions/<timestamp>/analysis.json
//   spots/<spot-id>/state.json                 { stage, summary, open_issues,
//                                                session_ids, updated_at }
// No dependencies. Node 18+.

import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export function spotDir(root, id) {
  return join(root, 'spots', id);
}

export async function initSpot(root, id, name = null) {
  const dir = spotDir(root, id);
  await mkdir(join(dir, 'sessions'), { recursive: true });
  const meta = {
    id,
    name: name ?? id,
    created: new Date().toISOString(),
  };
  await writeFile(join(dir, 'spot.json'), JSON.stringify(meta, null, 2));
  const state = {
    stage: 'unobserved',
    summary: '',
    open_issues: [],
    session_ids: [],
    updated_at: meta.created,
  };
  await writeFile(join(dir, 'state.json'), JSON.stringify(state, null, 2));
  return { dir, meta, state };
}

export async function readState(root, id) {
  const raw = await readFile(join(spotDir(root, id), 'state.json'), 'utf8');
  return JSON.parse(raw);
}

export async function listSessions(root, id) {
  const dir = join(spotDir(root, id), 'sessions');
  return (await readdir(dir)).sort();
}

// Append a model analysis as a new session and fold it into state.json.
// analysis: compare/diff JSON with stage, suggested_state_update, new_issues.
export async function appendSession(root, id, analysis, sessionId = null) {
  const dir = spotDir(root, id);
  const sid =
    sessionId ?? new Date().toISOString().replace(/[:.]/g, '-');
  const sessionDir = join(dir, 'sessions', sid);
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, 'analysis.json'),
    JSON.stringify(analysis, null, 2)
  );
  let state;
  try {
    state = await readState(root, id);
  } catch {
    await initSpot(root, id);
    state = await readState(root, id);
  }
  const next = {
    stage: analysis.stage ?? analysis.progress_delta ?? state.stage,
    summary: analysis.suggested_state_update ?? state.summary,
    open_issues: Array.isArray(analysis.new_issues)
      ? analysis.new_issues
      : state.open_issues,
    session_ids: [...new Set([...(state.session_ids ?? []), sid])],
    updated_at: new Date().toISOString(),
  };
  await writeFile(join(dir, 'state.json'), JSON.stringify(next, null, 2));
  return { sessionId: sid, state: next };
}
