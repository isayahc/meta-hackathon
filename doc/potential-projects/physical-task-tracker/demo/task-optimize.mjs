// Demo: optimizer over goals + spot state.
// Ranks next actions from <project>/goals.json, every tracked spot's
// state.json, and hard constraints (--constraint, repeatable).
// Text-only call (no images). Node 18+.
//   node task-optimize.mjs <project-root> [--goal "text" --deadline DATE --weight 1-5]
//       [--set-status <id>=<open|at-risk|done>] [--constraint "..."] [--offline] [--out plan.json]
//
// Same env and key handling as task-briefing.mjs.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildRequestBody,
  buildOptimizerPrompt,
  extractAnalysis,
  DEFAULT_MAX_TOKENS,
  resolveApiKey,
} from './analyze-response.mjs';
import { addGoal, listGoals, setGoalStatus } from './goals.mjs';

const API_BASE = process.env.META_API_BASE ?? 'https://api.meta.ai/v1';
const MODEL = process.env.MUSE_MODEL ?? 'muse-spark-1.1';

const args = process.argv.slice(2);
const positionals = args.filter((a) => !a.startsWith('--'));
const flagValue = (name, def) => {
  const eq = args.find((a) => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const flagAll = (name) =>
  args.flatMap((a, i) => (a === name && args[i + 1] && !args[i + 1].startsWith('--') ? [args[i + 1]] : []));
const root = positionals[0];
const outPath = flagValue('--out', null);
const offline = args.includes('--offline');
if (!root) {
  console.error(
    'Usage: node task-optimize.mjs <project-root> [--goal "text" --deadline DATE --weight 1-5]\n' +
      '       [--set-status <id>=<open|at-risk|done>] [--constraint "..."] [--offline] [--out plan.json]'
  );
  process.exit(1);
}

for (const text of flagAll('--goal')) {
  const g = await addGoal(root, {
    text,
    deadline: flagValue('--deadline', null),
    weight: flagValue('--weight', 3),
  });
  console.error(`goal added: ${g.id}`);
}
const assign = flagValue('--set-status', null);
if (assign) {
  const i = assign.indexOf('=');
  if (i === -1) {
    console.error(`Bad --set-status "${assign}": want <id>=<status>.`);
    process.exit(1);
  }
  const g = await setGoalStatus(root, assign.slice(0, i), assign.slice(i + 1)).catch((e) => {
    console.error(`set-status failed: ${e.message}`);
    process.exit(1);
  });
  console.error(`goal ${g.id} -> ${g.status}`);
}
const constraints = flagAll('--constraint');

let spotIds = [];
try {
  spotIds = (await readdir(join(root, 'spots'))).sort();
} catch { /* goals-only project: optimize from goals alone */ }

const spots = [];
for (const id of spotIds) {
  const dir = join(root, 'spots', id);
  let meta = { id, name: id };
  try {
    meta = { id, name: id, ...JSON.parse(await readFile(join(dir, 'spot.json'), 'utf8')) };
  } catch { /* uninitialized spot: name falls back to id */ }
  let state = {};
  try {
    state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
  } catch {
    console.error(`Skipping spot "${id}": no state.json (run a compare with --spot first).`);
    continue;
  }
  spots.push({
    id,
    name: meta.name ?? id,
    stage: state.stage,
    summary: state.summary,
    open_issues: state.open_issues,
    session_count: state.session_ids?.length ?? 0,
    updated_at: state.updated_at,
  });
}

const goals = await listGoals(root);
if (!spots.length && !goals.length) {
  console.error('Nothing to optimize: no spot state and no goals (add --goal to start).');
  process.exit(1);
}
const prompt = buildOptimizerPrompt(goals, spots, constraints);

if (offline) {
  console.log(prompt);
  process.exit(0);
}

const KEY = await resolveApiKey();
const maxTokens = Number.parseInt(process.env.MAX_TOKENS ?? '', 10) || DEFAULT_MAX_TOKENS;
const body = buildRequestBody({
  model: MODEL,
  prompt,
  maxTokens,
  reasoningEffort: process.env.REASONING_EFFORT ?? null,
});

const res = await fetch(`${API_BASE}/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${KEY}`,
  },
  body: JSON.stringify(body),
});

if (!res.ok) {
  console.error(`API error ${res.status}: ${(await res.text()).slice(0, 500)}`);
  process.exit(1);
}

const result = extractAnalysis(await res.json());
if (!result.ok) {
  console.error(`ERROR [${result.code}]: ${result.error}`);
  if (result.usage) console.error(`usage: ${JSON.stringify(result.usage)}`);
  if (result.raw) console.error(`--- raw model output ---\n${result.raw}`);
  if (result.detail) console.error(`--- raw response ---\n${JSON.stringify(result.detail).slice(0, 1000)}`);
  process.exit(1);
}
const text = JSON.stringify({ goals_open: goals.filter((g) => g.status !== 'done').length, goals_total: goals.length, spots: spots.length, plan: result.analysis }, null, 2);
if (outPath) await writeFile(outPath, text + '\n');
console.log(text);
