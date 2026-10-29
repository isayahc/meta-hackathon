// Helpers for the task tracker: request building, response handling,
// API-key persistence, prompts, overlays, SRT. Importing this module
// performs no network or filesystem side effects - safe for tests.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Goal } from './goals.js';

export const DEFAULT_MAX_TOKENS = 4096;

// Key lives OUTSIDE the repo so it can never be committed.
export function configPath(): string {
  const base = process.env.APPDATA ?? join(homedir(), '.config');
  return join(base, 'meta-hackathon', 'demo-key.json');
}

export async function loadSavedKey(): Promise<string | null> {
  try {
    const raw = await readFile(configPath(), 'utf8');
    const key: unknown = (JSON.parse(raw) as { key?: unknown })?.key;
    return typeof key === 'string' && key.trim() ? key.trim() : null;
  } catch {
    return null;
  }
}

export async function saveKey(key: string): Promise<void> {
  const path = configPath();
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify({ key }), { mode: 0o600 });
}

function readHidden(query: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(query);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch: string) => {
      if (ch === '\r' || ch === '\n' || ch === String.fromCharCode(4)) {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(buf);
      } else if (ch === String.fromCharCode(3)) {
        process.stdout.write('\n');
        process.exit(1);
      } else if (ch === String.fromCharCode(127) || ch === '\b') {
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

// Resolution order: env, saved file (outside the repo), hidden prompt
// with an offer to remember. Throws when non-interactive and keyless.
export async function resolveApiKey(): Promise<string> {
  const env = process.env.META_API_KEY;
  if (env?.trim()) return env.trim();
  const saved = await loadSavedKey();
  if (saved) return saved;
  if (!process.stdin.isTTY) {
    throw new Error('Set META_API_KEY first (no terminal to prompt on).');
  }
  const key = (await readHidden('Meta API key (input hidden): ')).trim();
  if (!key) throw new Error('Empty key, aborting.');
  if (await askYesNo('Remember this key for next time? [y/N] ')) {
    await saveKey(key);
    console.error(`Saved to ${configPath()} (outside the repo).`);
  }
  return key;
}

function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Single image files are single-frame visits; directories are frame sets;
// anything else goes down the ffmpeg video path.
export function classifySource(isDirectory: boolean, ext: string): string {
  if (!isDirectory && ['.jpg', '.jpeg', '.png', '.webp'].includes(String(ext).toLowerCase())) {
    return 'image';
  }
  return isDirectory ? 'frames-dir' : 'video';
}

export interface VideoMeta {
  duration: number;
  width: number;
  height: number;
  fps: number;
  codec: string | null;
}

type ExecFn = (
  cmd: string,
  args: string[],
  cb: (err: Error | null, stdout: string, stderr: string) => void
) => unknown;

// Probe a video file with ffprobe. execFile is injected so tests can stub
// it; defaults to node:child_process.
export async function getVideoMeta(path: string, execFileImpl: ExecFn | null = null): Promise<VideoMeta> {
  const { execFile } = await import('node:child_process');
  const run: ExecFn = execFileImpl ?? (execFile as unknown as ExecFn);
  const out = await new Promise<string>((resolve, reject) => {
    run(
      'ffprobe',
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,avg_frame_rate,codec_name:format=duration',
        '-of', 'json',
        path,
      ],
      (err, stdout, stderr) =>
        err ? reject(new Error(`ffprobe failed: ${String(stderr).trim().slice(0, 200)}`)) : resolve(stdout)
    );
  });
  const info = JSON.parse(out) as {
    streams?: Array<{ width?: number; height?: number; avg_frame_rate?: string; codec_name?: string }>;
    format?: { duration?: string };
  };
  const stream = info.streams?.[0] ?? {};
  const [num, den] = String(stream.avg_frame_rate ?? '0/1').split('/').map(Number);
  return {
    duration: Number(info.format?.duration ?? NaN),
    width: Number(stream.width ?? NaN),
    height: Number(stream.height ?? NaN),
    fps: den ? (num as number) / (den as number) : NaN,
    codec: stream.codec_name ?? null,
  };
}

export interface SpotBrief {
  id: string;
  name?: string;
  stage?: string;
  summary?: string;
  open_issues?: string[];
  session_count?: number;
  updated_at?: string;
}

// Briefing prompt over spot states. goals: free-text operator goals.
export function buildBriefingPrompt(spots: SpotBrief[], goals: string[] = []): string {
  const lines = spots.map((s) => {
    const issues =
      s.open_issues?.length
        ? s.open_issues.map((i) => `    - ${i}`).join('\n')
        : '    - none recorded';
    return (
      `Spot "${s.id}" (${s.name ?? s.id}):\n` +
      `  stage: ${s.stage ?? 'unknown'}\n` +
      `  sessions: ${s.session_count ?? 0}, last update: ${s.updated_at ?? 'never'}\n` +
      `  standing state: ${s.summary || '(none recorded)'}\n` +
      `  open issues:\n${issues}`
    );
  });
  const goalBlock = goals.length
    ? `\nThe operator's stated goals:\n${goals.map((g) => `- ${g}`).join('\n')}\n` +
      'For each goal, report on-track, at-risk, or unknown with one line of evidence.\n'
    : '';
  return (
    'You are the resume briefer for a farm-operations task tracker. ' +
    'Below are the standing states of every tracked spot. Brief the operator ' +
    'as if they are starting a shift. Reply with strict JSON, no markdown fences:\n' +
    '{\n' +
    '  "overall": "two sentences: where things stand",\n' +
    '  "per_spot": [{"id": "spot id", "status": "one line", "needs_attention": true}],\n' +
    '  "blockers": ["anything stopping work"],\n' +
    '  "next_actions": ["concrete actions ordered by urgency"]' +
    (goals.length ? ',\n  "goal_status": [{"goal": "verbatim goal", "status": "on-track|at-risk|unknown", "evidence": "one line"}]' : '') +
    '\n}\n' +
    '\nSpots:\n' +
    lines.join('\n\n') +
    goalBlock
  );
}

// Optimizer prompt: rank what to do next from goals, spot states, and
// constraints. constraints: [strings] such as weather windows, labor,
// daylight, equipment. ecoSummary: optional field-conditions block
// (see eco summarizeEco), or null.
export function buildOptimizerPrompt(
  goals: Goal[],
  spots: SpotBrief[],
  constraints: string[] = [],
  ecoSummary: string | null = null
): string {
  const open = goals.filter((g) => g.status !== 'done');
  const goalLines = open.length
    ? open
        .map(
          (g) =>
            `- [${g.id}] (weight ${g.weight}/5${g.deadline ? `, due ${g.deadline}` : ', no deadline'}) ${g.text} [${g.status}]`
        )
        .join('\n')
    : '(no open goals — optimize for general upkeep and risk reduction)';
  const spotLines = spots.length
    ? spots
        .map((s) => {
          const issues =
            s.open_issues?.length
              ? s.open_issues.map((i) => `    ! ${i}`).join('\n')
              : '    ! none recorded';
          return (
            `Spot "${s.id}" (${s.name ?? s.id}), stage: ${s.stage ?? 'unknown'}:\n` +
            `  ${s.summary || '(no standing state)'}\n${issues}`
          );
        })
        .join('\n\n')
    : '(no spots observed yet)';
  const constraintBlock = constraints.length
    ? `\nHard constraints (never violate):\n${constraints.map((c) => `- ${c}`).join('\n')}\n`
    : '';
  return (
    'You are the operations optimizer for a farm-operations task tracker. ' +
    'Given the goals, the observed state of every spot, and the hard ' +
    'constraints, decide what to do next. Reply with strict JSON, no markdown fences:\n' +
    '{\n' +
    '  "ranked_actions": [{"action": "concrete verb-first task", "why": "goal or risk it serves", "effort": "small|medium|large", "do_first_if": "condition that would reprioritize it"}],\n' +
    '  "deferred": [{"action": "task", "why": "why it waits"}],\n' +
    '  "goal_effects": [{"goal_id": "id", "effect": "advanced|at-risk|blocked|unaffected", "evidence": "one line"}]\n' +
    '}\n' +
    'Rules: order by goal weight divided by effort, soonest deadline first on ' +
    'ties; every ranked action must name the goal or risk it serves; anything ' +
    'violating a hard constraint goes in deferred with the reason.\n' +
    `\nOpen goals:\n${goalLines}\n` +
    `\nObserved spots:\n${spotLines}\n` +
    (ecoSummary ? `\nField conditions (ecology data):\n${ecoSummary}\n` : '') +
    constraintBlock
  );
}

export interface MaskPath {
  d: string;
  left: number;
  top: number;
}

export interface MaskBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// Overlay SVG: mask paths translated by their bounds, boxes as rects.
export function buildOverlaySvg({
  width,
  height,
  imageHref,
  boxes = [],
  paths = [],
}: {
  width: number;
  height: number;
  imageHref?: string;
  boxes?: MaskBox[];
  paths?: MaskPath[];
}): string {
  const W = Math.max(1, Math.ceil(Number(width) || 0));
  const H = Math.max(1, Math.ceil(Number(height) || 0));
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`,
  ];
  if (imageHref) {
    parts.push(`<image href="${escapeXml(imageHref)}" x="0" y="0" width="${W}" height="${H}"/>`);
  }
  for (const [i, p] of paths.entries()) {
    const color = `hsl(${(i * 137) % 360} 90% 55%)`;
    parts.push(
      `<path d="${escapeXml(p.d)}" transform="translate(${p.left} ${p.top})" fill="${color}" fill-opacity="0.35" stroke="${color}" stroke-width="2"/>`
    );
  }
  for (const b of boxes) {
    parts.push(
      `<rect x="${b.left}" y="${b.top}" width="${b.right - b.left}" height="${b.bottom - b.top}" fill="none" stroke="white" stroke-width="2"/>`
    );
  }
  parts.push('</svg>');
  return parts.join('\n') + '\n';
}

export interface PromptSection {
  label: string;
  imageUrls?: string[];
}

export interface RequestBodyOptions {
  model: string;
  prompt: string;
  imageUrl?: string | null;
  imageUrls?: string[];
  // Labeled follow-up sections appended after the main images, e.g. a
  // second visit to compare against the first.
  sections?: PromptSection[];
  maxTokens?: number;
  reasoningEffort?: string | null;
}

export function buildRequestBody({
  model,
  prompt,
  imageUrl = null,
  imageUrls = [],
  sections = [],
  maxTokens = DEFAULT_MAX_TOKENS,
  reasoningEffort = null,
}: RequestBodyOptions): Record<string, unknown> {
  const urls = imageUrl ? [imageUrl, ...imageUrls] : imageUrls;
  const content: Array<Record<string, unknown>> = [
    { type: 'text', text: prompt },
    ...urls.map((url) => ({ type: 'image_url', image_url: { url } })),
  ];
  for (const section of sections) {
    content.push({ type: 'text', text: section.label });
    for (const url of section.imageUrls ?? []) {
      content.push({ type: 'image_url', image_url: { url } });
    }
  }
  const body: Record<string, unknown> = {
    model,
    // OpenAI-compatible token budget. If the provider instead expects
    // max_completion_tokens, adjust here.
    max_tokens: maxTokens,
    messages: [{ role: 'user', content }],
  };
  // Forwarded only when set: unknown params can get the request rejected,
  // so reasoning effort stays opt-in (e.g. REASONING_EFFORT=low).
  if (reasoningEffort) body['reasoning_effort'] = reasoningEffort;
  return body;
}

export function formatTimestamp(totalSeconds: number): string {
  const s = Math.max(0, Number(totalSeconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)},${pad(ms, 3)}`;
}

export interface SrtSegment {
  start: number;
  end: number;
  label: string;
}

export function formatSrt(segments: SrtSegment[]): string {
  return (
    segments
      .map(
        (seg, i) =>
          `${i + 1}\n${formatTimestamp(seg.start)} --> ${formatTimestamp(seg.end)}\n${seg.label}\n`
      )
      .join('\n') + '\n'
  );
}

export function normalizeSegments(
  segments: Array<{ start?: unknown; end?: unknown; label?: unknown }>,
  duration: number | null = null
): SrtSegment[] | null {
  if (!Array.isArray(segments)) return null;
  const clean: SrtSegment[] = [];
  for (const seg of segments) {
    const start = Number(seg?.start);
    const end = Number(seg?.end);
    const label = String(seg?.label ?? '').trim();
    if (!label || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || start < 0)
      continue;
    clean.push({
      start,
      end: duration ? Math.min(end, duration) : end,
      label,
    });
  }
  clean.sort((a, b) => a.start - b.start);
  return clean.length ? clean : null;
}

interface ProviderChoice {
  finish_reason?: string;
  native_finish_reason?: string;
  message?: { content?: unknown };
}

interface ProviderResponse {
  choices?: ProviderChoice[];
  usage?: unknown;
}

export type AnalysisResult =
  | { ok: true; analysis: unknown; raw: string }
  | { ok: false; code: string; error: string; usage?: unknown; raw?: string; detail?: unknown };

export function extractAnalysis(data: ProviderResponse): AnalysisResult {
  const choice = data?.choices?.[0];
  if (!choice) {
    return {
      ok: false,
      code: 'empty_response',
      error: 'Provider returned no choices.',
      detail: data,
    };
  }
  const finish = choice.finish_reason ?? choice.native_finish_reason ?? 'unknown';
  const content = choice.message?.content ?? null;
  const usage = data.usage ?? null;

  if (finish === 'length') {
    return {
      ok: false,
      code: 'truncated',
      error:
        "Response truncated (finish_reason='length'): the model spent its " +
        'token budget before writing the analysis. Raise the token limit ' +
        'or lower reasoning effort.',
      usage,
    };
  }
  if (content === null || content === undefined || String(content).trim() === '') {
    return {
      ok: false,
      code: 'empty_content',
      error: `Empty task analysis (finish_reason='${finish}').`,
      usage,
    };
  }
  const text = String(content);
  try {
    return { ok: true, analysis: JSON.parse(text), raw: text };
  } catch {
    return {
      ok: false,
      code: 'not_json',
      error: 'Model returned free text instead of the requested JSON task analysis.',
      raw: text,
      usage,
    };
  }
}
