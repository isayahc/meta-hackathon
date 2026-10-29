// Demo: compare two visits to the same spot and report what changed.
// The tracking inflection point: single-visit analysis becomes a diff.
// Each visit is a video file (needs ffmpeg) or a directory of frame images.
// Zero app dependencies. Node 22+.
//   node task-compare.mjs <visit-a> <visit-b> [--frames N] [--goal "..."]
//
// Same env and key handling as task-scan.mjs.

import { readdir, readFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname, basename, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  buildRequestBody,
  extractAnalysis,
  DEFAULT_MAX_TOKENS,
  classifySource,
  resolveApiKey,
} from './lib/analyze-response.js';
import { loadEnvSync } from './lib/env.js';

// .env (cwd, then app root) fills gaps; real environment always wins.
loadEnvSync();
import type { VisitAnalysis } from './lib/spot-state.js';
import { flagValue } from './lib/args.js';

const execFileAsync = promisify(execFile);

const API_BASE = process.env.META_API_BASE ?? 'https://api.meta.ai/v1';
const MODEL = process.env.MUSE_MODEL ?? 'muse-spark-1.1';

const args = process.argv.slice(2);
const positionals = args.filter((a) => !a.startsWith('--'));
const [visitA, visitB] = positionals;
const PER_VISIT = Math.max(1, Number.parseInt(flagValue(args, '--frames', '3'), 10) || 3);
const GOAL = flagValue(args, '--goal', null);
if (!visitA || !visitB) {
  console.error('Usage: node task-compare.mjs <visit-a> <visit-b> [--frames N] [--goal "..."]');
  process.exit(1);
}

const KEY = await resolveApiKey();
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const tmpDirs: string[] = [];

function pickEven(files: string[], n: number): string[] {
  if (files.length <= n) return files;
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(files[Math.floor((i * files.length) / n)] as string);
  return out;
}

async function loadFrames(source: string, n: number, tag: string): Promise<string[]> {
  const st = await stat(source).catch(() => null);
  if (!st) {
    console.error(`Not found: ${source}`);
    process.exit(1);
  }
  let paths = [];
  const kind = classifySource(st.isDirectory(), extname(source));
  if (kind === 'image') {
    paths = [source];
  } else if (kind === 'frames-dir') {
    const files = (await readdir(source))
      .filter((f) => IMAGE_EXTS.has(extname(f).toLowerCase()))
      .sort()
      .map((f) => join(source, f));
    if (!files.length) {
      console.error(`No images in ${source}`);
      process.exit(1);
    }
    paths = pickEven(files, n);
  } else {
    const ffmpegOk = await execFileAsync('ffmpeg', ['-version'])
      .then(() => true)
      .catch(() => false);
    if (!ffmpegOk) {
      console.error('ffmpeg is required for video files (or pass frames directories).');
      process.exit(1);
    }
    const { stdout: durOut } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      source,
    ]).catch(() => ({ stdout: '' }));
    const duration = Number.parseFloat(durOut) || 0;
    const dir = await mkdtemp(join(tmpdir(), 'task-compare-'));
    tmpDirs.push(dir);
    for (let i = 0; i < n; i++) {
      const t = duration > 0 ? (duration * (i + 0.5)) / n : i * 2;
      const out = join(dir, `frame-${String(i).padStart(3, '0')}.jpg`);
      await execFileAsync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', source, '-frames:v', '1', '-q:v', '3', out]);
      paths.push(out);
    }
    console.error(`${tag}: extracted ${paths.length} frames.`);
  }
  const toDataUrl = async (p: string): Promise<string> => {
    const bytes = await readFile(p);
    const ext = extname(p).toLowerCase() === '.png' ? 'png' : 'jpeg';
    return `data:image/${ext};base64,${bytes.toString('base64')}`;
  };
  const urls: string[] = [];
  for (const p of paths) urls.push(await toDataUrl(p));
  return urls;
}

const urlsA = await loadFrames(visitA, PER_VISIT, 'visit A');
const urlsB = await loadFrames(visitB, PER_VISIT, 'visit B');
for (const d of tmpDirs) await rm(d, { recursive: true, force: true });

const goalBlock = GOAL
  ? `\nThe grower's stated goal is: "${GOAL}". For every change, say whether it moves that goal forward, and flag anything putting it at risk.`
  : '';

const prompt = `You are the vision layer of a farm-operations task tracker.
The first ${urlsA.length} images are VISIT A (earlier). The images after the "VISIT B (later)" marker are a later visit to the same spot.
Compare B against A. Report ONLY what you can observe. Reply with strict JSON, no markdown fences:
{
  "same_location": true,
  "same_location_reason": "one line of visual evidence",
  "changed": ["what is visibly different in B"],
  "unchanged": ["what is visibly the same"],
  "progress_delta": "one line: did the work advance, stall, or regress",
  "new_issues": ["new problems visible in B, if any"],
  "suggested_state_update": "one paragraph: the new standing state of this spot",
  "confidence": "low|medium|high",
  "unknowns": ["what you cannot tell from these images"]
}${goalBlock}`;

const maxTokens =
  Number.parseInt(process.env.MAX_TOKENS ?? '', 10) || DEFAULT_MAX_TOKENS;
const body = buildRequestBody({
  model: MODEL,
  prompt,
  imageUrls: urlsA,
  sections: [{ label: 'VISIT B (later):', imageUrls: urlsB }],
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
console.log(JSON.stringify(result.analysis, null, 2));

const spotFlag = flagValue(args, '--spot', null);
if (spotFlag) {
  const { appendSession } = await import('./lib/spot-state.js');
  const rootFlag = flagValue(args, '--root', null);
  const id = rootFlag ? spotFlag : basename(spotFlag);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/.test(id)) {
    console.error(`Bad spot id "${id}": letters, numbers, - and _ only.`);
    process.exit(1);
  }
  const root = rootFlag ?? dirname(dirname(spotFlag));
  const { sessionId } = await appendSession(root, id, result.analysis as VisitAnalysis);
  console.error(`Saved session ${sessionId} to ${spotFlag}.`);
}
