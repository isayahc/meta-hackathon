// Demo: ask a Muse model to read farm-task state from a work photo.
// Zero dependencies. Node 18+.
//   META_API_KEY=... node task-scan.mjs <image-path-or-url>
//
// Env:
//   META_API_KEY      optional - prompted (hidden) when missing and stdin is a TTY
//   META_API_BASE     optional - default https://api.meta.ai/v1
//   MUSE_MODEL        optional - default muse-spark-1.1
//   MAX_TOKENS        optional - default 4096
//   REASONING_EFFORT  optional - forwarded as reasoning_effort when set
//                       (low|medium|high); only set if the provider supports it

import { readFile } from 'node:fs/promises';

async function askYesNo(query: string): Promise<boolean> {
  process.stdout.write(query);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch: string) => {
      stdin.pause();
      stdin.removeListener('data', onData);
      resolve(/^\s*y(es)?\s*$/i.test(ch));
    };
    stdin.on('data', onData);
  });
}
import {
  buildRequestBody,
  extractAnalysis,
  DEFAULT_MAX_TOKENS,
  configPath,
  loadSavedKey,
  saveKey,
} from './lib/analyze-response.js';
import { loadEnvSync } from './lib/env.js';

// .env (cwd, then app root) fills gaps; real environment always wins.
loadEnvSync();

const API_BASE = process.env.META_API_BASE ?? 'https://api.meta.ai/v1';
const MODEL = process.env.MUSE_MODEL ?? 'muse-spark-1.1';
function readHidden(query: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(query);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch: string) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(buf);
      } else if (ch === '\u0003') {
        process.stdout.write('\n');
        process.exit(1);
      } else if (ch === '\u007f' || ch === '\b') {
        buf = buf.slice(0, -1);
      } else {
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

let KEY: string | null = process.env.META_API_KEY ?? (await loadSavedKey());
if (!KEY) {
  if (!process.stdin.isTTY) {
    console.error('Set META_API_KEY first (no terminal to prompt on).');
    process.exit(1);
  }
  KEY = (await readHidden('Meta API key (input hidden): ')).trim();
  if (!KEY) {
    console.error('Empty key, aborting.');
    process.exit(1);
  }
  if (await askYesNo('Remember this key for next time? [y/N] ')) {
    await saveKey(KEY);
    console.error(`Saved to ${configPath()} (outside the repo).`);
  }
}

const input = process.argv[2];
if (!input) {
  console.error('Usage: node task-scan.mjs <image-path-or-url>');
  process.exit(1);
}

let imageUrl;
if (/^https?:\/\//i.test(input)) {
  imageUrl = input;
} else {
  const bytes = await readFile(input);
  const ext = input.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
  imageUrl = `data:image/${ext};base64,${bytes.toString('base64')}`;
}

const prompt = `You are the vision layer of a farm-operations task tracker.
Look at this work photo and report ONLY what you can observe.
Reply with strict JSON, no markdown fences:
{
  "observed_task": "one line: what work is happening",
  "workers_visible": 0,
  "stage": "one line: what stage the job is at",
  "progress_cues": ["visible evidence of progress"],
  "safety_flags": ["visible hazards, if any"],
  "suggested_next_steps": ["concrete next actions"],
  "confidence": "low|medium|high",
  "unknowns": ["what you cannot tell from this photo"]
}`;

const maxTokens =
  Number.parseInt(process.env.MAX_TOKENS ?? '', 10) || DEFAULT_MAX_TOKENS;
const body = buildRequestBody({
  model: MODEL,
  prompt,
  imageUrl,
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
  if (result.usage)
    console.error(`usage: ${JSON.stringify(result.usage)}`);
  if (result.raw)
    console.error(`--- raw model output ---\n${result.raw}`);
  if (result.detail)
    console.error(
      `--- raw response ---\n${JSON.stringify(result.detail).slice(0, 1000)}`
    );
  process.exit(1);
}
console.log(JSON.stringify(result.analysis, null, 2));
