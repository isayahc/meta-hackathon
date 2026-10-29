// Demo: resume briefing over every tracked spot.
// Reads spot state from the project's fieldops.db and briefs the operator:
// where things stand, blockers, next actions, and goal status.
// Text-only call (no images). Node 22+.
//   node task-briefing.mjs <project-root> [--goal "..."] [--out briefing.json]
//
// Same env and key handling as task-scan.mjs.

import { writeFile } from 'node:fs/promises';
import { listSpotBriefs } from './lib/spot-state.js';
import {
  buildRequestBody,
  buildBriefingPrompt,
  extractAnalysis,
  DEFAULT_MAX_TOKENS,
  resolveApiKey,
  type SpotBrief,
} from './lib/analyze-response.js';
import { loadEnvSync } from './lib/env.js';

// .env (cwd, then app root) fills gaps; real environment always wins.
loadEnvSync();
import { flagValue } from './lib/args.js';

const API_BASE = process.env.META_API_BASE ?? 'https://api.meta.ai/v1';
const MODEL = process.env.MUSE_MODEL ?? 'muse-spark-1.1';

const args = process.argv.slice(2);
const positionals = args.filter((a) => !a.startsWith('--'));
const goals = args
  .map((a, i) => (a === '--goal' ? args[i + 1] : a.startsWith('--goal=') ? a.slice(7) : null))
  .filter((g): g is string => typeof g === 'string' && !g.startsWith('--'));
const root = positionals[0];
const outPath = flagValue(args, '--out', null);
if (!root) {
  console.error('Usage: node task-briefing.mjs <project-root> [--goal "..."] [--out briefing.json]');
  process.exit(1);
}

const KEY = await resolveApiKey();

const spots: SpotBrief[] = await listSpotBriefs(root);
if (!spots.length) {
  console.error('No spots to brief on (run a compare with --spot first).');
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
