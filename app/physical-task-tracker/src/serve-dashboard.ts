// Field Ops app server: serves dashboard/index.html plus a JSON API that
// runs the sibling CLIs as jobs (scan, compare, briefing, optimizer) and
// manages goals.json. Keyless model jobs fail fast with the reason.
//   node dist/serve-dashboard.js <projectDir> [--port 8123] [--eco <lat,lon>] [--open]
// Node 18+, no runtime dependencies.

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { readdir, readFile, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listGoals, setGoalStatus, addGoal } from './lib/goals.js';

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
  if (typeof img?.imageUrl === 'string' && img.imageUrl) return img.imageUrl;
  const m = /^data:(image\/(png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(
    typeof img?.imageData === 'string' ? img.imageData : ''
  );
  if (!m) throw new Error('Provide {imageUrl} or {imageData} as a png/jpeg/webp data URL.');
  const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
  const path = join(dir, `${base}.${ext}`);
  await writeFile(path, Buffer.from(m[3] as string, 'base64'));
  return path;
}

export function cleanSpotId(id: unknown): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/.test(id)) {
    throw new Error(`Bad spot id "${String(id)}": letters, numbers, - and _ only.`);
  }
  return id;
}

async function readJson(path: string, fallback: any): Promise<any> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
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
  let ids: string[] = [];
  try {
    ids = (await readdir(join(root, 'spots'))).sort();
  } catch {
    return [];
  }
  const spots: OverviewSpot[] = [];
  for (const id of ids) {
    const dir = join(root, 'spots', id);
    const meta = ((await readJson(join(dir, 'spot.json'), {})) ?? {}) as { name?: string };
    const state = await readJson(join(dir, 'state.json'), null);
    if (!state) continue;
    let sessions: string[] = [];
    try {
      sessions = (await readdir(join(dir, 'sessions'))).sort().reverse();
    } catch { /* no sessions yet */ }
    spots.push({
      id,
      name: meta.name ?? id,
      stage: state.stage ?? null,
      summary: state.summary ?? null,
      open_issues: state.open_issues ?? [],
      session_count: state.session_ids?.length ?? sessions.length,
      recent_sessions: sessions.slice(0, 5),
      updated_at: state.updated_at ?? null,
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

export function createServer(root: string, { eco = null }: { eco?: string | null } = {}) {
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
        const plan = await readJson(join(root, 'plan.json'), null);
        const ecoDoc = await readJson(join(root, 'eco.json'), null);
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
      if (req.method === 'POST' && url.pathname === '/api/compares') {
        const workdir = await mkdtemp(join(tmpdir(), 'fieldops-compare-'));
        try {
          const { spot, before, after, goal = null } = await readBody(req);
          const id = cleanSpotId(spot);
          const a = await materializeImage(before, workdir, 'before');
          const b = await materializeImage(after, workdir, 'after');
          const args = [a, b, '--spot', join(root, 'spots', id)];
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
        const jobArgs = [root, '--out', join(root, 'plan.json')];
        if (eco) jobArgs.push('--eco', eco);
        await runScript('task-optimize.js', jobArgs);
        json(200, { ok: true });
        return;
      }
      json(404, { ok: false, error: 'not found' });
    } catch (err) {
      const msg = (err as Error).message;
      const code = /No goal|Bad status|Bad spot|Provide \{|not JSON|over \d+|Bad --eco|Bad location|No spots|Nothing to optimize|Set META_API_KEY|Empty key|required/i.test(msg)
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
  const args = process.argv.slice(2);
  const root = args.find((a) => !a.startsWith('--')) ?? null;
  if (!root) {
    console.error(
      'Usage: node dist/serve-dashboard.js <projectDir> [--port 8123] [--eco <lat,lon>] [--open]'
    );
    process.exit(2);
  }
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
