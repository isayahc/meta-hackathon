// serve-dashboard.mjs — run script for the Field Ops dashboard.
// Serves dashboard/index.html plus a small JSON API over a project dir:
// spots + sessions, goals.json, cached plan.json, cached eco.json.
//   node serve-dashboard.mjs <projectDir> [--port 8123] [--eco <lat,lon>] [--open]
// Then open http://localhost:8123 in a browser (--open loads it for you).
//
// Pages poll /api/overview every 5s. "Re-run optimizer" shells out to
// task-optimize.mjs (needs the Meta key; failures surface in the UI).
// "done" buttons write back to goals.json. Persist eco with:
//   node eco.mjs <lat,lon> --out <projectDir>/eco.json
// Node 18+, no dependencies.

import { createServer as createHttpServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readdir, readFile, writeFile, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listGoals, setGoalStatus, addGoal } from './lib/goals.mjs';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // data-URL image cap
const JOB_TIMEOUT_MS = 300000; // model calls are slow; surface hangs as 502s

// Shell out to a sibling CLI, parse its stdout JSON. Nonzero exit (bad key,
// API error, truncated output) rejects with the script's stderr.
export function runScript(name, args, { timeoutMs = JOB_TIMEOUT_MS } = {}) {
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

export async function readBody(req, limit = MAX_UPLOAD_BYTES) {
  let size = 0;
  let body = '';
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error(`Body over ${limit} bytes.`);
    body += chunk;
  }
  try {
    return JSON.parse(body || '{}');
  } catch {
    throw new Error('Body is not JSON.');
  }
}

// {imageUrl} passes through; {imageData} must be a png/jpeg/webp data URL
// and is written to dir. Returns a path or URL the CLIs accept.
export async function materializeImage(img, dir, base) {
  if (img?.imageUrl) return img.imageUrl;
  const m = /^data:(image\/(png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(img?.imageData ?? '');
  if (!m) throw new Error('Provide {imageUrl} or {imageData} as a png/jpeg/webp data URL.');
  const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
  const path = join(dir, `${base}.${ext}`);
  await writeFile(path, Buffer.from(m[3], 'base64'));
  return path;
}

export function cleanSpotId(id) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/.test(id ?? '')) {
    throw new Error(`Bad spot id "${id}": letters, numbers, - and _ only.`);
  }
  return id;
}

const HERE = dirname(fileURLToPath(import.meta.url));

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export async function loadSpots(root) {
  let ids = [];
  try {
    ids = (await readdir(join(root, 'spots'))).sort();
  } catch {
    return [];
  }
  const spots = [];
  for (const id of ids) {
    const dir = join(root, 'spots', id);
    const meta = (await readJson(join(dir, 'spot.json'), {})) ?? {};
    const state = await readJson(join(dir, 'state.json'), null);
    if (!state) continue;
    let sessions = [];
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

export function buildFeed(spots) {
  const events = [];
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

export function createServer(root, { eco = null } = {}) {
  const server = createHttpServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = (code, obj) => {
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
        const goal = await setGoalStatus(root, decodeURIComponent(goalMatch[1]), status);
        json(200, { ok: true, goal });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/scans') {
        const workdir = await mkdtemp(join(tmpdir(), 'fieldops-scan-'));
        try {
          const { imageUrl, imageData } = await readBody(req);
          const src = await materializeImage({ imageUrl, imageData }, workdir, 'visit');
          const analysis = await runScript('task-scan.mjs', [src]);
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
          const analysis = await runScript('task-compare.mjs', args);
          json(200, { ok: true, spot: id, analysis });
        } finally {
          await rm(workdir, { recursive: true, force: true });
        }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/briefing') {
        const briefing = await runScript('task-briefing.mjs', [root]);
        json(200, { ok: true, briefing });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/refresh') {
        const args = ['task-optimize.mjs', root, '--out', join(root, 'plan.json')];
        if (eco) args.push('--eco', eco);
        await runScript(args.shift(), args);
        json(200, { ok: true });
        return;
      }
      json(404, { ok: false, error: 'not found' });
    } catch (err) {
      const msg = err.message;
      const code = /No goal|Bad status|Bad spot|Provide \{|not JSON|over \d+|Bad --eco|Bad location|No spots|Nothing to optimize|Set META_API_KEY|Empty key|required/i.test(msg)
        ? 400
        : /task-\w+\.mjs:|timed out/i.test(msg)
          ? 502
          : 500;
      json(code, { ok: false, error: msg.slice(0, 500) });
    }
  });
  return server;
}

export async function waitForOk(url, tries = 50, delayMs = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

export function openUrl(url) {
  const parts =
    process.platform === 'win32'
      ? ['cmd', '/c', 'start', '""', url]
      : process.platform === 'darwin'
        ? ['open', url]
        : ['xdg-open', url];
  return new Promise((resolve) => {
    execFile(parts[0], parts.slice(1), { stdio: 'ignore' }, (err) => resolve(!err));
  });
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const args = process.argv.slice(2);
  const root = args.find((a) => !a.startsWith('--')) ?? null;
  const flagValue = (name, def) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
  };
  if (!root) {
    console.error(
      'Usage: node serve-dashboard.mjs <projectDir> [--port 8123] [--eco <lat,lon>] [--open]'
    );
    process.exit(2);
  }
  const port = Number(flagValue('--port', '8123'));
  const eco = flagValue('--eco', null);
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
