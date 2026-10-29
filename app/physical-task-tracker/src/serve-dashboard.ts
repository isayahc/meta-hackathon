// Field Ops app server: serves dashboard/index.html plus a JSON API that
// runs the sibling CLIs as jobs (scan, compare, briefing, optimizer) and
// manages goals. Project state lives in <projectDir>/fieldops.db.
// Keyless model jobs fail fast with the reason.
//   node dist/serve-dashboard.js <projectDir> [--port 8123] [--eco <lat,lon>] [--open]
// Node 22+. One runtime dependency: @meta-sam/parser (SAM overlay CLI).

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { execFile } from 'node:child_process';
import { readFile, writeFile, readdir, rm, mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listGoals, setGoalStatus, addGoal } from './lib/goals.js';
import { listStoredEvents, getStoredEvent, addEvent, dayOf, isDay, type CalendarEvent } from './lib/events.js';
import { listActions, syncActions, setActionStatus } from './lib/actions.js';
import { listSpotBriefs, recentSessions } from './lib/spot-state.js';
import { getDoc } from './lib/db.js';
import { loadEnvSync } from './lib/env.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // data-URL image cap
const JOB_TIMEOUT_MS = 300000; // model calls are slow; surface hangs as 502s

// Shell out to a sibling CLI, parse its stdout JSON. Nonzero exit (bad key,
// API error, truncated output) rejects with the script's stderr.
export function runScript(name: string, args: string[], { timeoutMs = JOB_TIMEOUT_MS } = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [join(HERE, name), ...args],
      { cwd: HERE, timeout: timeoutMs },
      (err, stdout, stderr) => {
        if (err) {
          const why = err.killed ? `timed out after ${timeoutMs}ms` : `${stderr || err.message}`;
          reject(new Error(`${name}: ${why}`.slice(0, 500)));
        } else {
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(new Error(`${name} returned non-JSON: ${stdout.slice(0, 200)}`));
          }
        }
      }
    );
  });
}

export async function readBody(req: IncomingMessage, limit: number = MAX_UPLOAD_BYTES): Promise<any> {
  let size = 0;
  let body = '';
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new Error(`Body over ${limit} bytes.`);
    body += buf.toString('utf8');
  }
  try {
    return JSON.parse(body || '{}');
  } catch {
    throw new Error('Body is not JSON.');
  }
}

export interface ImageInput {
  imageUrl?: unknown;
  imageData?: unknown;
}

// {imageUrl} passes through; {imageData} must be a png/jpeg/webp data URL
// and is written to dir. Returns a path or URL the CLIs accept.
export async function materializeImage(img: ImageInput, dir: string, base: string): Promise<string> {
  if (typeof img?.imageUrl === 'string' && img.imageUrl) {
    return fetchRemote(img.imageUrl, dir, base, { kinds: ['image'], maxBytes: MAX_UPLOAD_BYTES });
  }
  const m = /^data:(image\/(png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(
    typeof img?.imageData === 'string' ? img.imageData : ''
  );
  if (!m) throw new Error('Provide {imageUrl} or {imageData} as a png/jpeg/webp data URL.');
  const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
  const path = join(dir, `${base}.${ext}`);
  await writeFile(path, Buffer.from(m[3] as string, 'base64'));
  return path;
}

const VIDEO_MIMES = ['video/mp4', 'video/webm', 'video/quicktime'] as const;

export async function materializeVideo(
  input: { videoUrl?: unknown; videoData?: unknown },
  dir: string,
  base = 'clip'
): Promise<string> {
  if (typeof input?.videoUrl === 'string' && input.videoUrl) {
    return fetchRemote(input.videoUrl, dir, base, { kinds: ['video'], maxBytes: 200 * 1024 * 1024 });
  }
  const m = /^data:(video\/(mp4|webm|quicktime));base64,([A-Za-z0-9+/=]+)$/.exec(
    typeof input?.videoData === 'string' ? input.videoData : ''
  );
  if (!m || !(VIDEO_MIMES as readonly string[]).includes(m[1] as string)) {
    throw new Error('Provide {videoUrl} or {videoData} as an mp4/webm/mov data URL.');
  }
  const ext = m[2] === 'quicktime' ? 'mov' : (m[2] as string);
  const safe = base.replace(/[^A-Za-z0-9_-]/g, '') || 'clip';
  const path = join(dir, `${safe}.${ext}`);
  await writeFile(path, Buffer.from(m[3] as string, 'base64'));
  return path;
}

function isBlockedIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && (b as number) >= 16 && (b as number) <= 31) || (a === 192 && b === 168)
    );
  }
  if (isIP(ip) === 6) {
    const low = ip.toLowerCase();
    return low === '::1' || low === '::' || low.startsWith('fe80:') || low.startsWith('fc') || low.startsWith('fd');
  }
  return true;
}

async function assertPublicHost(hostname: string): Promise<void> {
  let addrs: Array<{ address: string }>;
  try {
    addrs = await lookup(hostname, { all: true });
  } catch {
    throw new Error(`Could not resolve host "${hostname}".`);
  }
  if (!addrs.length || addrs.some((a) => isBlockedIp(a.address))) {
    throw new Error(`Refusing non-public host "${hostname}".`);
  }
}

function extFromContentType(ct: string): string {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
  };
  const ext = map[ct];
  if (!ext) throw new Error(`Refusing content-type "${ct || 'unknown'}".`);
  return ext;
}

// Bounded, SSRF-safe remote fetch for URL inputs: http(s) only, no creds,
// no private/link-local/loopback targets (re-checked per redirect hop),
// max 3 redirects, per-hop 60s timeout, strict size caps, allowlisted
// content types. Returns the saved local path — CLIs never see raw URLs.
export async function fetchRemote(
  urlStr: string,
  dir: string,
  base: string,
  opts: { kinds: Array<'image' | 'video'>; maxBytes: number }
): Promise<string> {
  let current = urlStr;
  for (let hop = 0; hop <= 3; hop++) {
    let u: URL;
    try {
      u = new URL(current);
    } catch {
      throw new Error(`Bad URL "${String(urlStr).slice(0, 120)}".`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error('Only http(s) URLs are fetched.');
    }
    if (u.username || u.password) throw new Error('URLs with credentials are refused.');
    await assertPublicHost(u.hostname);
    let res: Response;
    try {
      res = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(60000) });
    } catch (e) {
      throw new Error(`Fetch failed: ${(e as Error).message.slice(0, 200)}`);
    }
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      try {
        await res.body?.cancel();
      } catch { /* best effort */ }
      current = new URL(location, current).toString();
      continue;
    }
    if (!res.ok) throw new Error(`Fetch failed: HTTP ${res.status}.`);
    const ct = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (!opts.kinds.some((k) => ct.startsWith(`${k}/`))) {
      throw new Error(`Refusing content-type "${ct || 'unknown'}".`);
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > opts.maxBytes) {
      throw new Error(`Remote file over ${opts.maxBytes} bytes.`);
    }
    const reader = res.body?.getReader();
    if (!reader) throw new Error('Empty response body.');
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > opts.maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`Remote file over ${opts.maxBytes} bytes.`);
      }
      chunks.push(Buffer.from(value));
    }
    const safe = base.replace(/[^A-Za-z0-9_-]/g, '') || 'remote';
    const path = join(dir, `${safe}.${extFromContentType(ct)}`);
    await writeFile(path, Buffer.concat(chunks));
    return path;
  }
  throw new Error('Too many redirects.');
}

export function cleanSpotId(id: unknown): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/.test(id)) {
    throw new Error(`Bad spot id "${String(id)}": letters, numbers, - and _ only.`);
  }
  return id;
}

export interface OverviewSpot {
  id: string;
  name: string;
  stage: string | null;
  summary: string | null;
  open_issues: string[];
  session_count: number;
  recent_sessions: string[];
  updated_at: string | null;
}

export async function loadSpots(root: string): Promise<OverviewSpot[]> {
  const spots: OverviewSpot[] = [];
  for (const b of await listSpotBriefs(root)) {
    spots.push({
      id: b.id,
      name: b.name ?? b.id,
      stage: b.stage ?? null,
      summary: b.summary ?? null,
      open_issues: b.open_issues ?? [],
      session_count: b.session_count ?? 0,
      recent_sessions: await recentSessions(root, b.id),
      updated_at: b.updated_at ?? null,
    });
  }
  return spots;
}

export interface FeedEvent {
  at: string;
  text: string;
  sort: string;
}

export function buildFeed(spots: OverviewSpot[]): FeedEvent[] {
  const events: FeedEvent[] = [];
  for (const s of spots) {
    for (const sid of s.recent_sessions ?? []) {
      events.push({ at: sid.replace(/-/g, ':').slice(0, 19).replace('T', ' ') || sid, text: `${s.name}: visit recorded`, sort: sid });
    }
    for (const issue of s.open_issues ?? []) {
      events.push({ at: s.updated_at ?? '', text: `${s.name}: ${issue}`, sort: s.updated_at ?? '' });
    }
  }
  return events.sort((a, b) => (b.sort > a.sort ? 1 : -1)).slice(0, 15);
}

export function createServer(rootArg: string, { eco = null }: { eco?: string | null } = {}) {
  // Absolute from the start: CLI children run from dist/, so stored paths
  // (media clips, the db) must resolve identically in every process.
  const root = resolve(rootArg);
  const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (code: number, obj: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const html = await readFile(join(HERE, 'dashboard', 'index.html'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/overview') {
        const spots = await loadSpots(root);
        const goals = await listGoals(root);
        const plan = await getDoc(root, 'plan');
        const ecoDoc = (await getDoc(root, 'eco')) as { summary?: string } | null;
        json(200, { spots, goals, plan, eco: ecoDoc?.summary ?? null, feed: buildFeed(spots) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/goals') {
        const { text, deadline = null, weight = 3 } = await readBody(req);
        const goal = await addGoal(root, { text, deadline, weight });
        json(200, { ok: true, goal });
        return;
      }
      const goalMatch = req.method === 'POST' && /^\/api\/goals\/([^/]+)$/.exec(url.pathname);
      if (goalMatch) {
        const { status } = await readBody(req);
        const goal = await setGoalStatus(root, decodeURIComponent(goalMatch[1] as string), status);
        json(200, { ok: true, goal });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/scans') {
        const workdir = await mkdtemp(join(tmpdir(), 'fieldops-scan-'));
        try {
          const { imageUrl, imageData } = await readBody(req);
          const src = await materializeImage({ imageUrl, imageData }, workdir, 'visit');
          const analysis = await runScript('task-scan.js', [src]);
          json(200, { ok: true, analysis });
        } finally {
          await rm(workdir, { recursive: true, force: true });
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/scan-video') {
        // Uploads persist under <project>/media so calendar entries can play
        // the referenced clip later. URL inputs reference nothing local.
        const { videoUrl, videoData, frames = 4 } = await readBody(req, 200 * 1024 * 1024);
        const n = Math.min(12, Math.max(1, Number(frames) || 4));
        let src: string;
        let media: string | null = null;
        let gifPrefix: string | null = null;
        let mediaDir = '';
        if (typeof videoUrl === 'string' && videoUrl) {
          mediaDir = join(root, 'media');
          await mkdir(mediaDir, { recursive: true });
          gifPrefix = `clip-${new Date().toISOString().replace(/[:.]/g, '-')}`;
          src = await materializeVideo({ videoUrl }, mediaDir, gifPrefix);
          media = src.split(/[\\/]/).pop() ?? null;
        } else {
          mediaDir = join(root, 'media');
          await mkdir(mediaDir, { recursive: true });
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          gifPrefix = `clip-${stamp}`;
          src = await materializeVideo({ videoUrl, videoData }, mediaDir, gifPrefix);
          media = src.split(/[\\/]/).pop() ?? null;
        }
        const scanArgs = [src, '--frames', String(n)];
        if (gifPrefix) scanArgs.push('--gifs', mediaDir, '--gif-prefix', gifPrefix);
        const analysis = await runScript('task-scan-video.js', scanArgs);
        let eventId: string | null = null;
        try {
          const a = (analysis ?? {}) as { observed_task?: unknown; stage?: unknown; recorded_at?: unknown; gifs?: unknown };
          if (gifPrefix) {
            try {
              a.gifs = (await readdir(mediaDir))
                .filter((f) => f.startsWith(`${gifPrefix}-`) && f.endsWith('.gif'))
                .sort();
            } catch { a.gifs = []; }
          }
          let savedEvent: { id: string } | null = null;
          if (typeof a.observed_task === 'string' && a.observed_task.trim()) {
            savedEvent = await addEvent(root, {
              title: a.observed_task.trim().slice(0, 120),
              date: dayOf(a.recorded_at) ?? new Date().toISOString().slice(0, 10),
              kind: 'scan',
              detail: typeof a.stage === 'string' ? a.stage.slice(0, 120) : null,
              payload: analysis,
              media,
            });
          }
          if (savedEvent) {
            eventId = savedEvent.id;
            (a as { event?: unknown }).event = eventId;
            const rawSteps = ((analysis ?? {}) as { suggested_next_steps?: unknown }).suggested_next_steps;
            const steps = Array.isArray(rawSteps) ? rawSteps.filter((s): s is string => typeof s === 'string') : [];
            await syncActions(root, eventId, steps);
          }
        } catch (e) { console.error(`calendar record failed: ${(e as Error).message}`); }
        json(200, { ok: true, analysis });
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
        const name = decodeURIComponent(url.pathname.slice('/media/'.length));
        if (!name || name.includes('/') || name.includes('\\') || !/\.(mp4|webm|mov|gif)$/i.test(name)) {
          json(404, { ok: false, error: 'not found' });
          return;
        }
        try {
          const data = await readFile(join(root, 'media', name));
          const type = /\.webm$/i.test(name)
            ? 'video/webm'
            : /\.mov$/i.test(name)
              ? 'video/quicktime'
              : /\.gif$/i.test(name)
                ? 'image/gif'
                : 'video/mp4';
          res.writeHead(200, { 'Content-Type': type });
          res.end(data);
        } catch {
          json(404, { ok: false, error: 'not found' });
        }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        const stored = await listStoredEvents(root);
        const goals = await listGoals(root);
        const spots = await loadSpots(root);
        const derived: CalendarEvent[] = [];
        for (const g of goals) {
          if (g.status !== 'done' && g.deadline && isDay(g.deadline)) {
            derived.push({
              id: `goal-${g.id}`, title: g.text, date: g.deadline, time: null,
              kind: 'goal', detail: `due (weight ${g.weight}/5)`, payload: null, media: null, created_at: g.created ?? '',
            });
          }
        }
        for (const s of spots) {
          const day = dayOf(s.updated_at);
          if (day) {
            derived.push({
              id: `spot-${s.id}`, title: `${s.name} updated`, date: day, time: null,
              kind: 'spot', detail: s.summary?.slice(0, 120) ?? null, payload: null, media: null, created_at: s.updated_at ?? '',
            });
          }
        }
        const events = [...stored, ...derived].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
        json(200, { events });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/events') {
        const { title, date, time = null } = await readBody(req);
        const event = await addEvent(root, { title, date, time, kind: 'note' });
        json(200, { ok: true, event });
        return;
      }
      const eventMatch = req.method === 'GET' && /^\/api\/events\/([^/]+)$/.exec(url.pathname);
      if (eventMatch) {
        const event = await getStoredEvent(root, decodeURIComponent(eventMatch[1] as string));
        if (!event) {
          json(404, { ok: false, error: 'not found' });
          return;
        }
        let actions = await listActions(root, event.id);
        if (!actions.length && event.payload) {
          try {
            const steps = (JSON.parse(event.payload) as { suggested_next_steps?: unknown }).suggested_next_steps;
            if (Array.isArray(steps)) {
              actions = await syncActions(
                root,
                event.id,
                steps.filter((s): s is string => typeof s === 'string')
              );
            }
          } catch { /* leave empty */ }
        }
        json(200, { event, actions });
        return;
      }
      const actionMatch = req.method === 'POST' && /^\/api\/actions\/([^/]+)$/.exec(url.pathname);
      if (actionMatch) {
        const { status } = await readBody(req);
        const action = await setActionStatus(root, decodeURIComponent(actionMatch[1] as string), status);
        json(200, { ok: true, action });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/compares') {
        const workdir = await mkdtemp(join(tmpdir(), 'fieldops-compare-'));
        try {
          const { spot, before, after, goal = null } = await readBody(req);
          const id = cleanSpotId(spot);
          const a = await materializeImage(before, workdir, 'before');
          const b = await materializeImage(after, workdir, 'after');
          const args = [a, b, '--spot', id, '--root', root];
          if (goal) args.push('--goal', goal);
          const analysis = await runScript('task-compare.js', args);
          json(200, { ok: true, spot: id, analysis });
        } finally {
          await rm(workdir, { recursive: true, force: true });
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/briefing') {
        const briefing = await runScript('task-briefing.js', [root]);
        json(200, { ok: true, briefing });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/refresh') {
        const jobArgs = [root];
        if (eco) jobArgs.push('--eco', eco);
        await runScript('task-optimize.js', jobArgs);
        json(200, { ok: true });
        return;
      }
      json(404, { ok: false, error: 'not found' });
    } catch (err) {
      const msg = (err as Error).message;
      const code = /No goal|No action|Event title|Bad event|Bad status|Bad URL|Only http|credentials|non-public|Refusing|Too many redirects|Could not resolve|Bad spot|Provide \{|not JSON|over \d+|Bad --eco|Bad location|No spots|Nothing to optimize|Set META_API_KEY|Empty key|required/i.test(msg)
        ? 400
        : /task-\w+\.m?js:|timed out/i.test(msg)
          ? 502
          : 500;
      json(code, { ok: false, error: msg.slice(0, 500) });
    }
  });
  return server;
}

export async function waitForOk(url: string, tries = 50, delayMs = 100): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

export function openUrl(url: string): Promise<boolean> {
  const parts =
    process.platform === 'win32'
      ? ['cmd', '/c', 'start', '""', url]
      : process.platform === 'darwin'
        ? ['open', url]
        : ['xdg-open', url];
  return new Promise((resolve) => {
    execFile(parts[0] as string, parts.slice(1), (err: unknown) => resolve(!err));
  });
}

function flagValue(args: string[], name: string, def: string | null): string | null {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1]?.startsWith('--') ? (args[i + 1] as string) : def;
}

const invokedAsMain = import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`;
if (invokedAsMain) {
  // .env (cwd, then app root) fills gaps; children inherit it. Real env wins.
  loadEnvSync();
  const args = process.argv.slice(2);
  const rootArg = args.find((a) => !a.startsWith('--')) ?? null;
  if (!rootArg) {
    console.error(
      'Usage: node dist/serve-dashboard.js <projectDir> [--port 8123] [--eco <lat,lon>] [--open]'
    );
    process.exit(2);
  }
  // Absolute: CLI children run from dist/, so every stored path must
  // resolve identically no matter the child's working directory.
  const root = resolve(rootArg);
  const port = Number(flagValue(args, '--port', '8123'));
  const eco = flagValue(args, '--eco', null);
  const open = args.includes('--open');
  const server = createServer(root, { eco });
  const url = `http://localhost:${port}`;
  server.listen(port, '127.0.0.1', async () => {
    console.log(`Field Ops dashboard: ${url}  (project: ${root})`);
    if (open) {
      if (await waitForOk(`${url}/api/overview`)) {
        if (await openUrl(url)) console.log('Opened in your browser.');
        else console.log(`Could not open a browser automatically — open ${url} yourself.`);
      } else {
        console.log(`Server is up but unreachable at ${url} — open it yourself.`);
      }
    } else {
      console.log('Open that URL in a browser (or re-run with --open). Ctrl+C to stop.');
    }
  });
}
