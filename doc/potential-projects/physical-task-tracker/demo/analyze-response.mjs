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

export function buildRequestBody({
  model,
  prompt,
  imageUrl = null,
  imageUrls = [],
  maxTokens = DEFAULT_MAX_TOKENS,
  reasoningEffort = null,
}) {
  const urls = imageUrl ? [imageUrl, ...imageUrls] : imageUrls;
  const body = {
    model,
    // OpenAI-compatible token budget. If the provider instead expects
    // max_completion_tokens, adjust here.
    max_tokens: maxTokens,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          ...urls.map((url) => ({ type: 'image_url', image_url: { url } })),
        ],
      },
    ],
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
