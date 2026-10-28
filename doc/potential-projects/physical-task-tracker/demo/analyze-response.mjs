// Helpers for the task-scan demo: request building, response handling,
// and API-key persistence. Importing this module performs no network or
// filesystem side effects - safe to import from tests.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_MAX_TOKENS = 4096;

// Key lives OUTSIDE the repo so it can never be committed.
export function configPath() {
  const base = process.env.APPDATA ?? join(homedir(), '.config');
  return join(base, 'meta-hackathon', 'demo-key.json');
}

export async function loadSavedKey() {
  try {
    const raw = await readFile(configPath(), 'utf8');
    const key = JSON.parse(raw)?.key;
    return typeof key === 'string' && key.trim() ? key.trim() : null;
  } catch {
    return null;
  }
}

export async function saveKey(key) {
  const path = configPath();
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify({ key }), { mode: 0o600 });
}

function readHidden(query) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(query);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const onData = (ch) => {
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

async function askYesNo(query) {
  process.stdout.write(query);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (ch) => {
      stdin.pause();
      stdin.removeListener('data', onData);
      resolve(/^\s*y(es)?\s*$/i.test(ch));
    };
    stdin.on('data', onData);
  });
}

// Resolution order: env, saved file (outside the repo), hidden prompt
// with an offer to remember. Throws when non-interactive and keyless.
export async function resolveApiKey() {
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

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Single image files are single-frame visits; directories are frame sets;
// anything else goes down the ffmpeg video path.
export function classifySource(isDirectory, ext) {
  if (!isDirectory && ['.jpg', '.jpeg', '.png', '.webp'].includes(String(ext).toLowerCase())) {
    return 'image';
  }
  return isDirectory ? 'frames-dir' : 'video';
}

// Probe a video file with ffprobe. Returns
// { duration, width, height, fps, codec } or throws with the ffprobe stderr.
// execFile is injected so tests can stub it; defaults to node:child_process.
export async function getVideoMeta(path, execFileImpl = null) {
  const { execFile } = await import('node:child_process');
  const run = execFileImpl ?? execFile;
  const out = await new Promise((resolve, reject) => {
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
  const info = JSON.parse(out);
  const stream = info.streams?.[0] ?? {};
  const [num, den] = String(stream.avg_frame_rate ?? '0/1').split('/').map(Number);
  return {
    duration: Number(info.format?.duration ?? NaN),
    width: Number(stream.width ?? NaN),
    height: Number(stream.height ?? NaN),
    fps: den ? num / den : NaN,
    codec: stream.codec_name ?? null,
  };
}

// Overlay SVG: mask paths translated by their bounds, boxes as rects.
// paths: [{d, left, top}], boxes: [{left, top, right, bottom}].
export function buildOverlaySvg({ width, height, imageHref, boxes = [], paths = [] }) {
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

export function buildRequestBody({
  model,
  prompt,
  imageUrl = null,
  imageUrls = [],
  // Labeled follow-up sections: [{ label, imageUrls }] appended after the
  // main images, e.g. a second visit to compare against the first.
  sections = [],
  maxTokens = DEFAULT_MAX_TOKENS,
  reasoningEffort = null,
}) {
  const urls = imageUrl ? [imageUrl, ...imageUrls] : imageUrls;
  const content = [
    { type: 'text', text: prompt },
    ...urls.map((url) => ({ type: 'image_url', image_url: { url } })),
  ];
  for (const section of sections) {
    content.push({ type: 'text', text: section.label });
    for (const url of section.imageUrls ?? []) {
      content.push({ type: 'image_url', image_url: { url } });
    }
  }
  const body = {
    model,
    // OpenAI-compatible token budget. If the provider instead expects
    // max_completion_tokens, adjust here.
    max_tokens: maxTokens,
    messages: [{ role: 'user', content }],
  };
  // Forwarded only when set: unknown params can get the request rejected,
  // so reasoning effort stays opt-in (e.g. REASONING_EFFORT=low).
  if (reasoningEffort) body.reasoning_effort = reasoningEffort;
  return body;
}

export function formatTimestamp(totalSeconds) {
  const s = Math.max(0, Number(totalSeconds) || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)},${pad(ms, 3)}`;
}

export function formatSrt(segments) {
  return (
    segments
      .map(
        (seg, i) =>
          `${i + 1}\n${formatTimestamp(seg.start)} --> ${formatTimestamp(seg.end)}\n${seg.label}\n`
      )
      .join('\n') + '\n'
  );
}

export function normalizeSegments(segments, duration = null) {
  if (!Array.isArray(segments)) return null;
  const clean = [];
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

export function extractAnalysis(data) {
  const choice = data?.choices?.[0];
  if (!choice) {
    return {
      ok: false,
      code: 'empty_response',
      error: 'Provider returned no choices.',
      detail: data,
    };
  }
  const finish =
    choice.finish_reason ?? choice.native_finish_reason ?? 'unknown';
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
      error:
        'Model returned free text instead of the requested JSON task analysis.',
      raw: text,
      usage,
    };
  }
}
