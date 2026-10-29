// Demo: test video understanding over farm work.
// Sends N frames (a video file via ffmpeg, or a directory of frame images)
// to a Muse model and asks what changed between them - task progression.
// Zero dependencies besides ffmpeg (only needed for video files). Node 18+.
//   node task-scan-video.mjs <video-file | frames-dir> [--frames N]
//
// Same env as task-scan.mjs (key prompt with outside-the-repo persistence).

import { readdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  buildRequestBody,
  extractAnalysis,
  DEFAULT_MAX_TOKENS,
  formatSrt,
  normalizeSegments,
  classifySource,
  getVideoMeta,
  loadSavedKey,
  saveKey,
} from './lib/analyze-response.js';
import { loadEnvSync } from './lib/env.js';

// .env (cwd, then app root) fills gaps; real environment always wins.
loadEnvSync();

// Inspect a clip without spending an API call:
//   node task-scan-video.mjs --meta <video-file>
if (process.argv.includes('--meta')) {
  const target = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!target) {
    console.error('Usage: node task-scan-video.mjs --meta <video-file>');
    process.exit(1);
  }
  try {
    console.log(JSON.stringify(await getVideoMeta(target), null, 2));
  } catch (e) {
    console.error(`ERROR: ${(e as Error).message}`);
    process.exit(1);
  }
  process.exit(0);
}

const execFileAsync = promisify(execFile);

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
    console.error('Key saved outside the repo.');
  }
}

const args = process.argv.slice(2);
const input = args.find((a) => !a.startsWith('--'));
const framesFlag = args.find((a) => a.startsWith('--frames'));
const FRAME_COUNT = Math.max(
  2,
  Number.parseInt(framesFlag?.split('=')[1] ?? args[args.indexOf('--frames') + 1] ?? '4', 10) || 4
);
if (!input) {
  console.error('Usage: node task-scan-video.mjs <video-file | frames-dir> [--frames N] [--srt] [--duration SECS]');
  process.exit(1);
}
const SRT_MODE = args.includes('--srt');
let videoDuration: number | null = null;

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const { stat } = await import('node:fs/promises');
const st = await stat(input).catch(() => null);
if (!st) {
  console.error(`Not found: ${input}`);
  process.exit(1);
}

let framePaths: string[] = [];
let tmpDir: string | null = null;
if (classifySource(st.isDirectory(), extname(input)) === 'image') {
  framePaths = [input];
} else if (st.isDirectory()) {
  const files = (await readdir(input))
    .filter((f) => IMAGE_EXTS.has(extname(f).toLowerCase()))
    .sort()
    .map((f) => join(input, f));
  if (!files.length) {
    console.error(`No images in ${input}`);
    process.exit(1);
  }
  framePaths = pickEven(files, FRAME_COUNT);
  if (SRT_MODE) {
    const dArg = args.find((a) => a.startsWith('--duration'));
    const dVal = dArg
      ? dArg.includes('=')
        ? dArg.split('=')[1]
        : args[args.indexOf(dArg) + 1]
      : null;
    videoDuration = Number.parseFloat(dVal ?? '') || null;
    if (!videoDuration) {
      console.error('--srt with a frames directory needs --duration SECS (video length).');
      process.exit(1);
    }
  }
} else {
  // Video file: extract evenly spaced frames with ffmpeg.
  const ffmpegOk = await execFileAsync('ffmpeg', ['-version'])
    .then(() => true)
    .catch(() => false);
  if (!ffmpegOk) {
    console.error('ffmpeg is required for video files (or pass a frames directory).');
    process.exit(1);
  }
  const { stdout: durOut } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    input,
  ]).catch(() => ({ stdout: '' }));
  const duration = Number.parseFloat(durOut) || 0;
  videoDuration = duration > 0 ? duration : null;
  tmpDir = await mkdtemp(join(tmpdir(), 'task-scan-frames-'));
  for (let i = 0; i < FRAME_COUNT; i++) {
    const t = duration > 0 ? (duration * (i + 0.5)) / FRAME_COUNT : i * 2;
    const out = join(tmpDir, `frame-${String(i).padStart(3, '0')}.jpg`);
    await execFileAsync('ffmpeg', [
      '-v', 'error',
      '-ss', String(t),
      '-i', input,
      '-frames:v', '1',
      '-q:v', '3',
      out,
    ]);
    framePaths.push(out);
  }
  console.error(`Extracted ${framePaths.length} frames.`);
}

function pickEven(files: string[], n: number): string[] {
  if (files.length <= n) return files;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(files[Math.floor((i * files.length) / n)] as string);
  }
  return out;
}

const toDataUrl = async (p: string): Promise<string> => {
  const bytes = await readFile(p);
  const ext = extname(p).toLowerCase() === '.png' ? 'png' : 'jpeg';
  return `data:image/${ext};base64,${bytes.toString('base64')}`;
};
const imageUrls = [];
for (const p of framePaths) imageUrls.push(await toDataUrl(p));
if (tmpDir) await rm(tmpDir, { recursive: true, force: true });

const durationHint = videoDuration
  ? `, which is ${videoDuration.toFixed(1)} seconds long`
  : '';
const prompt = SRT_MODE
  ? `You are the vision layer of a farm-operations task tracker.
These ${imageUrls.length} frames are in time order from the same video${durationHint}.
Divide the video into action segments. Report ONLY what you can observe.
Reply with strict JSON, no markdown fences - a bare array:
[{"start": 0.0, "end": 3.2, "label": "athlete runs up with javelin"}, ...]
Rules: times in seconds${videoDuration ? ` from 0 to ${videoDuration.toFixed(1)}` : ''}; segments must not overlap; cover only parts where a distinct action happens; short labels.`
  : `You are the vision layer of a farm-operations task tracker.
These ${imageUrls.length} frames are in time order from the same job.
Report ONLY what you can observe. Reply with strict JSON, no markdown fences:
{
  "same_location": true,
  "observed_task": "one line: what work is happening",
  "progression": "what visibly changed from the first frame to the last",
  "per_frame": ["one line each: what each frame shows"],
  "stage": "one line: what stage the job is at",
  "suggested_next_steps": ["concrete next actions"],
  "confidence": "low|medium|high",
  "unknowns": ["what you cannot tell from these frames"]
}`;

const maxTokens =
  Number.parseInt(process.env.MAX_TOKENS ?? '', 10) || DEFAULT_MAX_TOKENS;
const body = buildRequestBody({
  model: MODEL,
  prompt,
  imageUrls,
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
if (SRT_MODE) {
  const segments = normalizeSegments(
    result.analysis as Array<{ start?: unknown; end?: unknown; label?: unknown }>,
    videoDuration
  );
  if (!segments) {
    console.error('ERROR [no_segments]: model returned no usable action segments.');
    console.error(`--- raw model output ---\n${JSON.stringify(result.analysis).slice(0, 1000)}`);
    process.exit(1);
  }
  const srt = formatSrt(segments);
  const srtPath = st.isDirectory()
    ? join(input, 'actions.srt')
    : input.replace(/\.[^.]+$/, '') + '.srt';
  await writeFile(srtPath, srt);
  console.log(`Wrote ${srtPath} (${segments.length} cues)`);
  console.log(srt);
} else {
  console.log(JSON.stringify(result.analysis, null, 2));
  console.error(`(via frames: ${framePaths.map((p) => basename(p)).join(', ')})`);
}
