// Dashboard tests: pure loader tests always run; HTTP tests run when the
// sandbox allows listen() and skip otherwise (EACCES). No network, no API
// key (refresh is not exercised — it shells to the live API).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, loadSpots, buildFeed } from './serve-dashboard.mjs';
import { addGoal, listGoals } from './goals.mjs';

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

async function tryListen(t, root) {
  const server = createServer(root);
  try {
    await new Promise((resolve, reject) => {
      server.on('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (err) {
    if (err?.code === 'EACCES') {
      t.skip('sandbox blocks listen(); run on host for HTTP coverage');
      return null;
    }
    throw err;
  }
  t.after(() => server.close());
  const port = server.address().port;
  return async (path, opts) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, opts);
    return { status: r.status, body: await r.text() };
  };
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

test('dashboard page contains the app shell', async () => {
  const html = await readFile(new URL('./dashboard/index.html', import.meta.url), 'utf8');
  assert.match(html, /Field Ops/);
  assert.match(html, /\/api\/overview/);
  assert.match(html, /prefers-reduced-motion/);
});

test('serves the dashboard page', async (t) => {
  const get = await tryListen(t, await scratch(t));
  if (!get) return;
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.match(r.body, /Field Ops/);
});

test('overview exposes spots, goals, plan, eco, feed', async (t) => {
  const root = await scratch(t);
  await writeFile(join(root, 'plan.json'), JSON.stringify({ plan: { ranked_actions: [] } }));
  await writeFile(join(root, 'eco.json'), JSON.stringify({ summary: 'Site (38.5, -98). Now: test.' }));
  const get = await tryListen(t, root);
  if (!get) return;
  const r = await get('/api/overview');
  assert.equal(r.status, 200);
  const ov = JSON.parse(r.body);
  assert.equal(ov.spots.length, 1);
  assert.equal(ov.goals.length, 1);
  assert.ok(ov.plan);
  assert.match(ov.eco, /38\.5/);
  assert.ok(ov.feed.length >= 2);
});

test('goal done button writes back to goals.json', async (t) => {
  const root = await scratch(t);
  const get = await tryListen(t, root);
  if (!get) return;
  const before = JSON.parse((await get('/api/overview')).body);
  const r = await get(`/api/goals/${before.goals[0].id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'done' }),
  });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).goal.status, 'done');
  assert.equal((await listGoals(root))[0].status, 'done');
});

test('bad goal id is a 400, unknown routes 404', async (t) => {
  const get = await tryListen(t, await scratch(t));
  if (!get) return;
  const bad = await get('/api/goals/nope-1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'done' }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await get('/api/nope')).status, 404);
});
