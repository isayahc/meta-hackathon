// serve-dashboard.mjs — run script for the Field Ops dashboard.
// Serves dashboard/index.html plus a small JSON API over a project dir:
// spots + sessions, goals.json, cached plan.json, cached eco.json.
//   node serve-dashboard.mjs <projectDir> [--port 8123] [--eco <lat,lon>]
// Then open http://localhost:8123 in a browser.
//
// Pages poll /api/overview every 5s. "Re-run optimizer" shells out to
// task-optimize.mjs (needs the Meta key; failures surface in the UI).
// "done" buttons write back to goals.json. Persist eco with:
//   node eco.mjs <lat,lon> --out <projectDir>/eco.json
// Node 18+, no dependencies.

import { createServer as createHttpServer } from 'node:http';
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listGoals, setGoalStatus } from './lib/goals.mjs';

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
      const goalMatch = req.method === 'POST' && /^\/api\/goals\/([^/]+)$/.exec(url.pathname);
      if (goalMatch) {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { status } = JSON.parse(body || '{}');
        const goal = await setGoalStatus(root, decodeURIComponent(goalMatch[1]), status);
        json(200, { ok: true, goal });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/refresh') {
        const args = [join(HERE, 'task-optimize.mjs'), root, '--out', join(root, 'plan.json')];
        if (eco) args.push('--eco', eco);
        await new Promise((resolve, reject) => {
          execFile(process.execPath, args, { cwd: HERE }, (err, stdout, stderr) => {
            if (err) reject(new Error(`${stderr || err.message}`.slice(0, 500)));
            else resolve(stdout);
          });
        });
        json(200, { ok: true });
        return;
      }
      json(404, { ok: false, error: 'not found' });
    } catch (err) {
      json(err.message.includes('No goal') || err.message.includes('Bad status') ? 400 : 500, {
        ok: false,
        error: err.message.slice(0, 500),
      });
    }
  });
  return server;
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const args = process.argv.slice(2);
  const root = args.find((a) => !a.startsWith('--')) ?? null;
  const flagValue = (name, def) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
  };
  if (!root) {
    console.error('Usage: node serve-dashboard.mjs <projectDir> [--port 8123] [--eco <lat,lon>]');
    process.exit(2);
  }
  const port = Number(flagValue('--port', '8123'));
  const eco = flagValue('--eco', null);
  const server = createServer(root, { eco });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Field Ops dashboard: http://localhost:${port}  (project: ${root})`);
    console.log('Open that URL in a browser. Ctrl+C to stop.');
  });
}
