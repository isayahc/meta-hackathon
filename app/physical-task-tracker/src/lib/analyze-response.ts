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
  creationTime: string | null;
}

type ExecFn = (
  cmd: string,
  args: string[],
  cb: (err: Error | null, stdout: string, stderr: string) => void
) => unknown;

// Probe a video file with ffprobe. execFile is injected so tests can stub
// it; defaults to node:child_process.
// Transport-failure detail: the underlying cause chain (code + message per
// link, AggregateError contents flattened) as one bounded line. Only codes
// and messages are ever emitted — never stacks, headers, keys, or payload
// bytes — with bearer/data-URL shapes redacted defensively. Class names
// are omitted: callers assert /AggregateError/ stays out of stderr.
const TRANSPORT_PART_MAX = 200;
const TRANSPORT_LINKS_MAX = 6;
const TRANSPORT_TOTAL_MAX = 800;

function sanitizeTransportText(s: string): string {
  return s
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/g, 'Bearer [REDACTED]')
    .replace(/data:(image|video)\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, 'data:...[REDACTED]');
}

function collectTransportLinks(err: unknown, out: string[]): void {
  if (out.length >= TRANSPORT_LINKS_MAX || err === null || err === undefined) return;
  if (Array.isArray(err)) {
    for (const item of err) collectTransportLinks(item, out);
    return;
  }
  if (typeof err !== 'object') {
    out.push(String(err));
    return;
  }
  const rec = err as { errors?: unknown; cause?: unknown; code?: unknown; message?: unknown };
  if (Array.isArray(rec.errors) && rec.errors.length) {
    for (const item of rec.errors) collectTransportLinks(item, out);
  } else {
    const code = typeof rec.code === 'string' && rec.code ? rec.code : null;
    const msg = typeof rec.message === 'string' && rec.message ? rec.message : null;
    if (code && msg) out.push(`${code}: ${msg}`);
    else if (code) out.push(code);
    else if (msg) out.push(msg);
  }
  collectTransportLinks(rec.cause, out);
}

// Full error detail for the server log: JSON-safe serialization of the
// failure with nested cause/errors, redacted and bounded. Temporary
// diagnostic companion to the one-line summary above.
const SERIALIZE_DEPTH_MAX = 4;
const SERIALIZE_KEYS_MAX = 20;
const SERIALIZE_STRING_MAX = 500;
const SERIALIZE_TOTAL_MAX = 2000;

function toPlainError(err: unknown, depth: number, seen: Set<object>): unknown {
  if (err === null || err === undefined) return err;
  if (typeof err === 'string') return sanitizeTransportText(err.slice(0, SERIALIZE_STRING_MAX));
  if (typeof err !== 'object') return err;
  if (seen.has(err)) return '[Circular]';
  if (depth <= 0) return '[Truncated]';
  seen.add(err);
  if (Array.isArray(err)) {
    return err.slice(0, SERIALIZE_KEYS_MAX).map((item) => toPlainError(item, depth - 1, seen));
  }
  const rec = err as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof rec.name === 'string') out.name = rec.name.slice(0, 80);
  if (typeof rec.code === 'string') out.code = rec.code.slice(0, 80);
  if (typeof rec.message === 'string') out.message = sanitizeTransportText(rec.message.slice(0, SERIALIZE_STRING_MAX));
  for (const key of Object.keys(rec)) {
    if (Object.keys(out).length >= SERIALIZE_KEYS_MAX) break;
    if (key === 'name' || key === 'code' || key === 'message' || key === 'stack' || key === 'cause' || key === 'errors') continue;
    if (/^(authorization|api[_-]?key|apikey|token|secret|passwd|password)$/i.test(key)) out[key] = '[REDACTED]';
    else out[key] = toPlainError(rec[key], depth - 1, seen);
  }
  if (rec.cause !== undefined) out.cause = toPlainError(rec.cause, depth - 1, seen);
  if (rec.errors !== undefined) out.errors = toPlainError(rec.errors, depth - 1, seen);
  return out;
}

export function serializeTransportError(err: unknown): string {
  try {
    const json = JSON.stringify(toPlainError(err, SERIALIZE_DEPTH_MAX, new Set()));
    return (typeof json === 'string' ? json : 'null').slice(0, SERIALIZE_TOTAL_MAX);
  } catch {
    return '"[Unserializable]"';
  }
}

export function formatTransportError(err: unknown): string {
  const links: string[] = [];
  collectTransportLinks(err, links);
  const parts = links.length ? links : ['unknown network error'];
  return parts
    .map((p) => sanitizeTransportText(p.replace(/\s+/g, ' ').trim()).slice(0, TRANSPORT_PART_MAX))
    .join(' <- ')
    .slice(0, TRANSPORT_TOTAL_MAX);
}

// POST JSON with Bearer auth. Network failures exit cleanly on stderr
// (stdout stays pure JSON) instead of an undici stack dump.
export async function postApi(url: string, key: string, body: unknown): Promise<Response> {
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error(`API unreachable: ${formatTransportError(e)}`);
    console.error(`detail: ${serializeTransportError(e)}`);
    process.exit(1);
  }
}
export async function getVideoMeta(path: string, execFileImpl: ExecFn | null = null): Promise<VideoMeta> {
  const { execFile } = await import('node:child_process');
  const run: ExecFn = execFileImpl ?? (execFile as unknown as ExecFn);
  const out = await new Promise<string>((resolve, reject) => {
    run(
      'ffprobe',
      [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height,avg_frame_rate,codec_name:format=duration:format_tags=creation_time',
        '-of', 'json',
        path,
      ],
      (err, stdout, stderr) =>
        err ? reject(new Error(`ffprobe failed: ${String(stderr).trim().slice(0, 200)}`)) : resolve(stdout)
    );
  });
  const info = JSON.parse(out) as {
    streams?: Array<{ width?: number; height?: number; avg_frame_rate?: string; codec_name?: string }>;
    format?: { duration?: string; tags?: { creation_time?: string } };
  };
  const stream = info.streams?.[0] ?? {};
  const [num, den] = String(stream.avg_frame_rate ?? '0/1').split('/').map(Number);
  return {
    duration: Number(info.format?.duration ?? NaN),
    width: Number(stream.width ?? NaN),
    height: Number(stream.height ?? NaN),
    fps: den ? (num as number) / (den as number) : NaN,
    codec: stream.codec_name ?? null,
    creationTime: info.format?.tags?.creation_time ?? null,
  };
}

// When a clip was recorded: container creation_time first (what the camera
// wrote), file mtime as fallback, unknown when neither parses. Advisory
// only — never assert a date the bytes don't support.
export interface RecordedAt {
  at: string | null;
  source: 'container' | 'mtime' | 'unknown';
}

export function resolveRecordedAt(
  container: string | null | undefined,
  mtimeMs: number | null | undefined
): RecordedAt {
  if (typeof container === 'string' && !Number.isNaN(Date.parse(container))) {
    return { at: new Date(container).toISOString(), source: 'container' };
  }
  if (typeof mtimeMs === 'number' && Number.isFinite(mtimeMs)) {
    return { at: new Date(mtimeMs).toISOString(), source: 'mtime' };
  }
  return { at: null, source: 'unknown' };
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
export interface OptimizerProcessStep {
  id: string;
  label: string;
  claim: string;
  execution: string;
  requires: string[];
  observed_order: number | null;
  unknowns: string[];
}

export interface OptimizerProcess {
  id: string;
  rev: number;
  title: string;
  goals: Array<{ label: string; execution: string }>;
  steps: OptimizerProcessStep[];
  gaps: string[];
}

export function buildOptimizerPrompt(
  goals: Goal[],
  spots: SpotBrief[],
  constraints: string[] = [],
  ecoSummary: string | null = null,
  processes: OptimizerProcess[] = []
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
  const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);
  const processBlock = processes.length
    ? '\nFarmer processes (current revisions; farmer-corrected steps outrank older spot summaries where they conflict):\n' +
      processes
        .map((p) => {
          const shown = p.steps.slice(0, 50);
          const lines = shown.map(
            (s) =>
              `  - [${s.id}] "${clip(s.label, 160)}" claim=${s.claim} exec=${s.execution}` +
              ` requires=${s.requires.length ? s.requires.join(',') : 'none'}` +
              ` order=${s.observed_order ?? 'none'}`
          );
          if (p.steps.length > shown.length) lines.push(`  - (+${p.steps.length - shown.length} more steps not shown)`);
          for (const g of p.gaps.slice(0, 10)) lines.push(`  ! gap: ${clip(g, 160)}`);
          for (const s of shown) {
            for (const u of s.unknowns.slice(0, 3)) lines.push(`  ! ${s.id} unknown: ${clip(u, 160)}`);
          }
          return (
            `- [${p.id}] "${clip(p.title, 160)}" (rev ${p.rev})\n` +
            p.goals.map((g) => `  goal: ${clip(g.label, 160)} [${g.execution}]`).join('\n') +
            (p.goals.length ? '\n' : '') +
            lines.join('\n')
          );
        })
        .join('\n') +
      '\n'
    : '';
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
    processBlock +
    constraintBlock
  );
}

// Floor-plan prompt: strict observation JSON over a plan image. Versioned:
// run evidence records which prompt produced each observation set.
export const FLOORPLAN_PROMPT_VERSION = 'floorplan-v5';

export function buildFloorplanPrompt(): string {
  return `You are the vision layer of a Field Ops task tracker reading a floor-plan image.
Report ONLY what the drawing shows. Reply with strict JSON, no markdown fences:
{
  "site": {"width_m": 0, "depth_m": 0, "height_m": 0 or null} or null,
  "siteEvidence": "where any dimensions came from, or why scale is unknown",
  "rooms": [{"label": "name", "kind": "room|zone|outdoor|volume", "polygon": [[0,0]] or null, "status": "observed|inferred"}],
  "walls": [{"label": "name", "kind": "wall|partition", "regions": ["room label", "optional second"], "path": [[0,0],[1,1]] or null, "thickness_m": 0 or null, "height_m": 0 or null, "status": "observed|inferred"}],
  "openings": [{"wall": 0, "kind": "door|passage|window|gate", "span": [0.4, 0.6], "traversable": true, "status": "observed|inferred"}],
  "equipment": [{"label": "name", "region": "room label", "polygon": [[0,0]] or null, "status": "observed|inferred"}],
  "unresolved": ["what you cannot tell: missing scale, unreadable labels, ambiguous connectivity"]
}
Rules: polygons/paths are normalized [0,1] plan coordinates with origin top-left. "wall" is a wall-array index. Spans are fractions along the wall within [0,1]. NEVER invent dimensions: site null when no scale bar or figured dimensions are visible; height_m null (never 0, never a guess) when plan dimensions are visible but heights are not; geometry null when unmeasurable; put every ambiguity in unresolved. A wall path is exactly its two endpoints and touches at most two rooms: split angled, bay, or multi-room walls into one wall entry per straight run. Equipment is furniture/fixtures with visible footprints. Walls reference room labels exactly: exterior walls list only interior rooms, never the words room, zone, outdoor, or volume unless you emitted a room with that exact label. Before replying, verify every wall path has exactly two points, every wall touches at most two rooms, every region names a room label from this reply, and every opening wall index exists; fix any violation first.`;
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
  | { ok: true; analysis: unknown; raw: string; usage?: unknown }
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
    return { ok: true, analysis: JSON.parse(text), raw: text, usage };
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
