// Demo: segment objects in an image with SAM 3.1 and save an SVG overlay.
// Zero app dependencies besides @meta-sam/parser (see package.json).
// Node 18+.
//   node sam-segment.mjs <image-url-or-path> "<noun phrase>" [--out overlay.svg]
//
// Concept prompts are short noun phrases ("center pivot irrigation field"),
// not commands. See README for details.
//
// Env: META_API_BASE, MUSE_MODEL (model id, default sam-3.1), MAX_TOKENS,
// REASONING_EFFORT. API key via META_API_KEY env, saved file, or prompt.

import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import {
  parseImageStream,
  recordsOfKind,
  decodeMaskToSVGPath,
} from '@meta-sam/parser';
import {
  resolveApiKey,
  buildOverlaySvg,
} from './lib/analyze-response.js';
import { loadEnvSync } from './lib/env.js';

// .env (cwd, then app root) fills gaps; real environment always wins.
loadEnvSync();

const API_BASE = process.env.META_API_BASE ?? 'https://api.meta.ai/v1';
const MODEL = process.env.MUSE_MODEL ?? 'sam-3.1';

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--'));
const outFlag = args.find((a) => a.startsWith('--out'));
const outPath: string | null = outFlag
  ? outFlag.includes('=')
    ? (outFlag.split('=')[1] ?? null)
    : (args[args.indexOf(outFlag) + 1] ?? null)
  : null;
const concept = args.filter((a) => !a.startsWith('--'))[1];
if (!input || !concept) {
  console.error('Usage: node sam-segment.mjs <image-url-or-path> "<noun phrase>" [--out overlay.svg]');
  process.exit(1);
}

const KEY = await resolveApiKey();

let imageUrl: string | undefined;
let imageHref = input;
if (/^https?:\/\//i.test(input)) {
  imageUrl = input;
} else {
  const bytes = await readFile(input);
  const ext = extname(input).toLowerCase() === '.png' ? 'png' : 'jpeg';
  imageUrl = `data:image/${ext};base64,${bytes.toString('base64')}`;
  imageHref = basename(input);
}

const res = await fetch(`${API_BASE}/responses`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${KEY}`,
  },
  body: JSON.stringify({
    model: MODEL,
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: concept },
          { type: 'input_image', image_url: imageUrl },
        ],
      },
    ],
  }),
});

if (!res.ok) {
  console.error(`API error ${res.status}: ${(await res.text()).slice(0, 500)}`);
  process.exit(1);
}

const data: any = await res.json();
if (data.status && data.status !== 'completed') {
  console.error(`ERROR: response status '${data.status}': ${JSON.stringify(data.error ?? data.incomplete_details ?? '').slice(0, 300)}`);
  process.exit(1);
}
const lane = data.output
  ?.find((o: any) => o.type === 'message')
  ?.content?.find((c: any) => c.type === 'output_text')?.text;
if (!lane) {
  console.error('ERROR [no_output]: model returned no segmentation lane.');
  process.exit(1);
}

async function* events() {
  yield { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, content_index: 0, delta: lane };
  yield { type: 'response.output_text.done', item_id: 'm1', output_index: 0, content_index: 0, text: lane };
  yield { type: 'response.completed' };
}

const parsed = parseImageStream(events());
for await (const _ of parsed) /* drain */;
const result = await parsed.finalResult;
if (result.outcome?.status && result.outcome.status !== 'completed') {
  console.error(`ERROR [incomplete]: ${JSON.stringify(result.outcome).slice(0, 300)}`);
  process.exit(1);
}
for (const d of result.diagnostics ?? []) {
  console.error(`warn ${d.code}: ${d.message}`);
}

const boxes = [...recordsOfKind(result.records, 'box')].map((b) => ({
  id: b.objectId,
  left: b.left,
  top: b.top,
  right: b.right,
  bottom: b.bottom,
  ...(b.confidence !== undefined ? { confidence: b.confidence } : {}),
}));
const paths = [...recordsOfKind(result.records, 'mask')].map((m) => ({
  id: m.objectId,
  left: m.bounds.left,
  top: m.bounds.top,
  right: m.bounds.right,
  bottom: m.bounds.bottom,
  d: decodeMaskToSVGPath(m.mask),
}));
const maxRight = Math.max(0, ...boxes.map((b) => b.right), ...paths.map((p) => p.right));
const maxBottom = Math.max(0, ...boxes.map((b) => b.bottom), ...paths.map((p) => p.bottom));
const svg = buildOverlaySvg({
  width: maxRight,
  height: maxBottom,
  imageHref,
  boxes,
  paths,
});

const target = outPath ?? 'sam-output.svg';
await writeFile(target, svg);
console.log(JSON.stringify({ segments: boxes.length, svg: target, boxes }, null, 2));
