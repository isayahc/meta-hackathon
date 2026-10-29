// Dashboard + app server tests. Drive the real request handler with mock
// req/res objects — no listen(), so they run in the sandbox and on host.
// Exec-backed jobs (scans/compares/briefing/refresh) are covered on their
// validation paths; live model runs need a key and stay manual.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, loadSpots, buildFeed, waitForOk } from './serve-dashboard.mjs';
import { addGoal, listGoals } from './lib/goals.mjs';

async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), 'dash-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spot = join(root, 'spots', 'north-fence');
  await mkdir(join(spot, 'sessions', '2026-10-28T09-00-00'), { recursive: true });
  await writeFile(join(spot, 'spot.json'), JSON.stringify({ name: 'North fence' }));
  await writeFile(
    join(spot, 'state.json'),
    JSON.stringify({
      stage: 'fruiting',
      summary: 'Ripe tomatoes, aphids on row 2.',
      open_issues: ['Aphids on row 2'],
      session_ids: ['2026-10-28T09-00-00'],
      updated_at: '2026-10-28T09:00:00Z',
    })
  );
  await addGoal(root, { text: 'Harvest bed 1', weight: 4 });
  return root;
}

function mockReq(method, url, body = null) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req[Symbol.asyncIterator] = async function* () {
    if (body !== null) yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  };
  return req;
}

function mockRes() {
  return {
    status: null, body: '',
    writeHead(s) { this.status = s; },
    end(b) { this.body += b ?? ''; },
  };
}

async function call(root, method, url, body = null, opts = {}) {
  const server = createServer(root, opts);
  const res = mockRes();
  await server.listeners('request')[0](mockReq(method, url, body), res);
  let parsed = null;
  try {
    parsed = JSON.parse(res.body);
  } catch { /* HTML page */ }
  return { status: res.status, body: res.body, json: parsed };
}

test('loadSpots reads spot meta + state + sessions', async (t) => {
  const spots = await loadSpots(await scratch(t));
  assert.equal(spots.length, 1);
  assert.equal(spots[0].name, 'North fence');
  assert.equal(spots[0].stage, 'fruiting');
  assert.deepEqual(spots[0].open_issues, ['Aphids on row 2']);
  assert.deepEqual(spots[0].recent_sessions, ['2026-10-28T09-00-00']);
});

test('loadSpots skips spots without state; empty project gives []', async (t) => {
  const root = await scratch(t);
  await mkdir(join(root, 'spots', 'empty-spot'), { recursive: true });
  assert.equal((await loadSpots(root)).length, 1);
  const bare = await mkdtemp(join(tmpdir(), 'dash-empty-'));
  t.after(() => rm(bare, { recursive: true, force: true }));
  assert.deepEqual(await loadSpots(bare), []);
});

test('buildFeed orders newest first and names spots', async (t) => {
  const feed = buildFeed(await loadSpots(await scratch(t)));
  assert.ok(feed.length >= 2);
  assert.match(feed[0].text, /North fence/);
  for (let i = 1; i < feed.length; i++) assert.ok(feed[i - 1].sort >= feed[i].sort);
});

test('waitForOk gives up fast on a dead port (--open readiness probe)', async () => {
  const t0 = Date.now();
  assert.equal(await waitForOk('http://127.0.0.1:1/api/overview', 2, 10), false);
  assert.ok(Date.now() - t0 < 2000);
});

test('dashboard page contains the app shell', async () => {
  const html = await readFile(new URL('./dashboard/index.html', import.meta.url), 'utf8');
  assert.match(html, /Field Ops/);
  assert.match(html, /\/api\/overview/);
  assert.match(html, /prefers-reduced-motion/);
  assert.match(html, /id="scanform"/);
  assert.match(html, /id="compareform"/);
  assert.match(html, /id="goalform"/);
});

test('serves the dashboard page', async (t) => {
  const r = await call(await scratch(t), 'GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.body, /Field Ops/);
});

test('overview exposes spots, goals, plan, eco, feed', async (t) => {
  const root = await scratch(t);
  await writeFile(join(root, 'plan.json'), JSON.stringify({ plan: { ranked_actions: [] } }));
  await writeFile(join(root, 'eco.json'), JSON.stringify({ summary: 'Site (38.5, -98). Now: test.' }));
  const r = await call(root, 'GET', '/api/overview');
  assert.equal(r.status, 200);
  assert.equal(r.json.spots.length, 1);
  assert.equal(r.json.goals.length, 1);
  assert.ok(r.json.plan);
  assert.match(r.json.eco, /38\.5/);
  assert.ok(r.json.feed.length >= 2);
});

test('goals: create, done-writeback, bad id and status are 400', async (t) => {
  const root = await scratch(t);
  const created = await call(root, 'POST', '/api/goals', { text: 'Water bed 3', weight: 2 });
  assert.equal(created.status, 200);
  assert.match(created.json.goal.id, /^water-bed-3-/);
  assert.equal((await listGoals(root)).length, 2);
  const empty = await call(root, 'POST', '/api/goals', { text: '  ' });
  assert.equal(empty.status, 400);
  const done = await call(root, 'POST', `/api/goals/${created.json.goal.id}`, { status: 'done' });
  assert.equal(done.status, 200);
  assert.equal(done.json.goal.status, 'done');
  const bad = await call(root, 'POST', '/api/goals/nope-1', { status: 'done' });
  assert.equal(bad.status, 400);
});

test('compares: bad spot id and missing images are 400, never shelled', async (t) => {
  const root = await scratch(t);
  const pic = { imageUrl: 'https://example.com/a.jpg' };
  const badSpot = await call(root, 'POST', '/api/compares', { spot: '../evil', before: pic, after: pic });
  assert.equal(badSpot.status, 400);
  assert.match(badSpot.json.error, /Bad spot/);
  const noImages = await call(root, 'POST', '/api/compares', { spot: 'bed-3', before: {}, after: pic });
  assert.equal(noImages.status, 400);
  assert.match(noImages.json.error, /data URL/);
  const noScanImage = await call(root, 'POST', '/api/scans', {});
  assert.equal(noScanImage.status, 400);
});

test('unknown routes 404; non-JSON bodies 400', async (t) => {
  const root = await scratch(t);
  assert.equal((await call(root, 'GET', '/api/nope')).status, 404);
  const server = createServer(root);
  const res = mockRes();
  const req = mockReq('POST', '/api/goals', '{not json');
  await server.listeners('request')[0](req, res);
  assert.equal(res.status, 400);
});

test('overview degrades on an empty project dir', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dash-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ov = (await call(root, 'GET', '/api/overview')).json;
  assert.deepEqual(ov.spots, []);
  assert.deepEqual(ov.goals, []);
  assert.equal(ov.plan, null);
  assert.equal(ov.eco, null);
});
