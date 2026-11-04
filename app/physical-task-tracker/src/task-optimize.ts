// Demo: optimizer over goals + spot state.
// Ranks next actions from the project's goals table, every tracked spot's
// standing state, and hard constraints (--constraint, repeatable).
// Text-only call (no images). Node 22+.
//   node task-optimize.mjs <project-root> [--goal "text" --deadline DATE --weight 1-5]
//       [--set-status <id>=<open|at-risk|done>] [--constraint "..."]
//       [--eco <lat,lon> | --eco-file samples/eco-x.json] [--offline] [--out plan.json]
//
// The finished plan is stored in the project's fieldops.db (and exported
// to --out when given). Same env and key handling as task-briefing.mjs.

import { readFile, writeFile } from 'node:fs/promises';
import {
  buildRequestBody,
  buildOptimizerPrompt,
  type OptimizerProcess,
  extractAnalysis,
  DEFAULT_MAX_TOKENS,
  resolveApiKey,
  postApi,
} from './lib/analyze-response.js';
import { addGoal, listGoals, setGoalStatus } from './lib/goals.js';
import { fetchEco, normalizeSoil, ecoConstraints, summarizeEco, type WeatherDoc } from './lib/eco.js';
import { type SpotBrief } from './lib/analyze-response.js';
import { listSpotBriefs } from './lib/spot-state.js';
import { setDoc } from './lib/db.js';
import { listProcesses, readProcess, type ProcessDoc } from './lib/processes.js';
import { loadEnvSync } from './lib/env.js';
import { flagValue, flagAll } from './lib/args.js';

// .env (cwd, then app root) fills gaps; real environment always wins.
loadEnvSync();

const API_BASE = process.env.META_API_BASE ?? 'https://api.meta.ai/v1';
const MODEL = process.env.MUSE_MODEL ?? 'muse-spark-1.1';

const args = process.argv.slice(2);
const positionals = args.filter((a) => !a.startsWith('--'));
const root = positionals[0];
const outPath = flagValue(args, '--out', null);
const offline = args.includes('--offline');
if (!root) {
  console.error(
    'Usage: node task-optimize.mjs <project-root> [--goal "text" --deadline DATE --weight 1-5]\n' +
      '       [--set-status <id>=<open|at-risk|done>] [--constraint "..."]\n' +
      '       [--eco <lat,lon> | --eco-file samples/eco-x.json] [--offline] [--out plan.json]'
  );
  process.exit(1);
}

for (const text of flagAll(args, '--goal')) {
  const g = await addGoal(root, {
    text,
    deadline: flagValue(args, '--deadline', null),
    weight: Number(flagValue(args, '--weight', '3')),
  });
  console.error(`goal added: ${g.id}`);
}
const assign = flagValue(args, '--set-status', null);
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
function toOptimizerProcess(doc: ProcessDoc): OptimizerProcess {
  return {
    id: doc.id,
    rev: doc.rev,
    title: doc.title,
    goals: doc.goals.map((g) => ({ label: g.label, execution: g.execution })),
    steps: doc.steps.map((s) => ({ id: s.id, label: s.label, claim: s.claim, execution: s.execution, requires: s.requires, observed_order: s.observed_order, unknowns: s.unknowns })),
    gaps: doc.gaps,
  };
}

const constraints = flagAll(args, '--constraint');

// Ecology fusion: live fetch (--eco lat,lon) or a saved capture
// (--eco-file samples/eco-x.json). Either way the summary lands in the db.
let ecoSummary: string | null = null;
const ecoLoc = flagValue(args, '--eco', null);
const ecoFile = flagValue(args, '--eco-file', null);
if (ecoLoc || ecoFile) {
  const doc = (ecoFile ? JSON.parse(await readFile(ecoFile, 'utf8')) : null) as {
    location?: { lat: number; lon: number };
    weather?: WeatherDoc;
    soilDoc?: unknown;
    soil?: unknown;
  } | null;
  const [lat, lon] = doc?.location
    ? [doc.location.lat, doc.location.lon]
    : (ecoLoc ?? ',').split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    console.error(`Bad location: want --eco <lat,lon> or an --eco-file with .location.`);
    process.exit(1);
  }
  let weather: WeatherDoc;
  let soil: ReturnType<typeof normalizeSoil>;
  if (doc?.weather) {
    weather = doc.weather;
    soil = normalizeSoil((doc.soilDoc ?? doc.soil) as Parameters<typeof normalizeSoil>[0]);
  } else {
    ({ weather, soil } = await fetchEco(lat as number, lon as number).catch((e: unknown) => {
      console.error(`eco fetch failed: ${(e as Error).message}`);
      process.exit(1);
    }));
  }
  const ecoRules = ecoConstraints(weather, soil);
  constraints.push(...ecoRules);
  ecoSummary = summarizeEco(weather, soil, lat as number, lon as number);
  setDoc(root, 'eco', { summary: ecoSummary, location: { lat, lon } });
  console.error(`eco: ${lat},${lon} -> ${ecoRules.length} weather/soil constraints`);
}

const spots: SpotBrief[] = await listSpotBriefs(root);

const goals = await listGoals(root);
if (!spots.length && !goals.length) {
  console.error('Nothing to optimize: no spot state and no goals (add --goal to start).');
  process.exit(1);
}
const suppliedCurrents = await listProcesses(root);
const suppliedDocs: ProcessDoc[] = [];
for (const c of suppliedCurrents) suppliedDocs.push(await readProcess(root, c.process_id, c.rev));
const suppliedBasis = suppliedDocs.map((d) => ({ process_id: d.id, rev: d.rev }));
const prompt = buildOptimizerPrompt(goals, spots, constraints, ecoSummary, suppliedDocs.map(toOptimizerProcess));

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

const res = await postApi(`${API_BASE}/chat/completions`, KEY, body);

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
// A correction landing mid-generation must not save as current against a
// revision the model never saw: re-read and mark stale instead of current.
const freshBasis = await listProcesses(root);
const moved = suppliedBasis.filter((b) => (freshBasis.find((f) => f.process_id === b.process_id)?.rev ?? -1) !== b.rev);
const added = freshBasis.filter((f) => !suppliedBasis.some((b) => b.process_id === f.process_id));
const wentStale = moved.length > 0 || added.length > 0;
const planObj = {
  goals_open: goals.filter((g) => g.status !== 'done').length,
  goals_total: goals.length,
  spots: spots.length,
  process_basis: suppliedBasis,
  stale: wentStale,
  ...(wentStale ? { stale_reason: `process revisions changed during generation: ${[...moved.map((m) => m.process_id), ...added.map((a) => a.process_id)].join(', ')}` } : {}),
  plan: result.analysis,
};
setDoc(root, 'plan', planObj);
const text = JSON.stringify(planObj, null, 2);
if (outPath) await writeFile(outPath, text + '\n');
console.log(text);
