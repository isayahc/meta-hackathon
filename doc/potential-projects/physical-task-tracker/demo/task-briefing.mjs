// Demo: resume briefing over every tracked spot.
// Reads <project>/spots/<id>/{spot.json,state.json} and briefs the operator:
// where things stand, blockers, next actions, and goal status.
// Text-only call (no images). Node 18+.
//   node task-briefing.mjs <project-root> [--goal "..."] [--out briefing.json]
//
// Same env and key handling as task-scan.mjs.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  buildRequestBody,
  buildBriefingPrompt,
  extractAnalysis,
  DEFAULT_MAX_TOKENS,
  resolveApiKey,
} from './lib/analyze-response.mjs';

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
const goals = args
  .map((a, i) => (a === '--goal' ? args[i + 1] : a.startsWith('--goal=') ? a.slice(7) : null))
  .filter((g) => typeof g === 'string' && !g.startsWith('--'));
const root = positionals[0];
const outPath = flagValue('--out', null);
if (!root) {
  console.error('Usage: node task-briefing.mjs <project-root> [--goal "..."] [--out briefing.json]');
  process.exit(1);
}

const KEY = await resolveApiKey();

let spotIds;
try {
  spotIds = (await readdir(join(root, 'spots'))).sort();
} catch {
  console.error(`No spots found under ${join(root, 'spots')}.`);
  process.exit(1);
}
if (!spotIds.length) {
  console.error('No spots to brief on.');
  process.exit(1);
}

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
if (!spots.length) {
  console.error('No spots with state to brief on.');
  process.exit(1);
}

const prompt = buildBriefingPrompt(spots, goals);
const maxTokens =
  Number.parseInt(process.env.MAX_TOKENS ?? '', 10) || DEFAULT_MAX_TOKENS;
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
  if (result.detail)
    console.error(`--- raw response ---\n${JSON.stringify(result.detail).slice(0, 1000)}`);
  process.exit(1);
}
const text = JSON.stringify(result.analysis, null, 2);
if (outPath) await writeFile(outPath, text + '\n');
console.log(text);
