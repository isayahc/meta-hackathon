// Dashboard + app server tests. Drive the real request handler with mock
// req/res objects — no listen(), so they run in the sandbox and on host.
// Exec-backed jobs (scans/compares/briefing/refresh) are covered on their
// validation paths; live model runs need a key and stay manual.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, loadSpots, buildFeed, waitForOk, fetchRemote } from './serve-dashboard.js';
import { addGoal, listGoals } from './lib/goals.js';
import { initSpot, appendSession } from './lib/spot-state.js';
import { setDoc } from './lib/db.js';

// Minimal HTTP shape: just what the handler touches.
interface MockReq {
  method: string;
  url: string;
  [Symbol.asyncIterator](): AsyncGenerator<Buffer>;
}

interface MockRes {
  status: number | null;
  body: string;
  writeHead(s: number): void;
  end(b?: string): void;
}

async function scratch(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'dash-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initSpot(root, 'north-fence', 'North fence');
  await appendSession(
    root,
    'north-fence',
    {
      stage: 'fruiting',
      suggested_state_update: 'Ripe tomatoes, aphids on row 2.',
      new_issues: ['Aphids on row 2'],
    },
    '2026-10-28T09-00-00'
  );
  await addGoal(root, { text: 'Harvest bed 1', weight: 4 });
  return root;
}

function mockReq(method: string, url: string, body: unknown = null): MockReq {
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (body !== null) yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    },
  };
}

function mockRes(): MockRes {
  return {
    status: null,
    body: '',
    writeHead(s: number) { this.status = s; },
    end(b?: string) { this.body += b ?? ''; },
  };
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

async function call(root: string, method: string, url: string, body: unknown = null, opts: { eco?: string | null } = {}) {
  const server = createServer(root, opts);
  const res = mockRes();
  const handler = server.listeners('request')[0] as unknown as Handler;
  await handler(mockReq(method, url, body) as unknown as IncomingMessage, res as unknown as ServerResponse);
  let parsed: any = null;
  try {
    parsed = JSON.parse(res.body);
  } catch { /* HTML page */ }
  return { status: res.status, body: res.body, json: parsed };
}

test('loadSpots reads spot meta + state + sessions', async (t: TestContext) => {
  const spots = await loadSpots(await scratch(t));
  assert.equal(spots.length, 1);
  assert.equal(spots[0].name, 'North fence');
  assert.equal(spots[0].stage, 'fruiting');
  assert.deepEqual(spots[0].open_issues, ['Aphids on row 2']);
  assert.deepEqual(spots[0].recent_sessions, ['2026-10-28T09-00-00']);
});

test('loadSpots lists initialized spots even without sessions', async (t: TestContext) => {
  const root = await scratch(t);
  await initSpot(root, 'empty-spot', 'Empty spot');
  assert.equal((await loadSpots(root)).length, 2);
  const bare = await mkdtemp(join(tmpdir(), 'dash-empty-'));
  t.after(() => rm(bare, { recursive: true, force: true }));
  assert.deepEqual(await loadSpots(bare), []);
});

test('buildFeed orders newest first and names spots', async (t: TestContext) => {
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

test('serves the dashboard page', async (t: TestContext) => {
  const r = await call(await scratch(t), 'GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.body, /Field Ops/);
});

test('overview exposes spots, goals, plan, eco, feed', async (t: TestContext) => {
  const root = await scratch(t);
  setDoc(root, 'plan', { plan: { ranked_actions: [] } });
  setDoc(root, 'eco', { summary: 'Site (38.5, -98). Now: test.' });
  const r = await call(root, 'GET', '/api/overview');
  assert.equal(r.status, 200);
  assert.equal(r.json.spots.length, 1);
  assert.equal(r.json.goals.length, 1);
  assert.ok(r.json.plan);
  assert.match(r.json.eco, /38\.5/);
  assert.ok(r.json.feed.length >= 2);
});

test('goals: create, done-writeback, bad id and status are 400', async (t: TestContext) => {
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
  const bad = await call(root, 'POST', `/api/goals/nope-1`, { status: 'done' });
  assert.equal(bad.status, 400);
});

test('compares: bad spot id and missing images are 400, never shelled', async (t: TestContext) => {
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

test('scan-video: missing video and bad mime are 400, never shelled', async (t: TestContext) => {
  const root = await scratch(t);
  const missing = await call(root, 'POST', '/api/scan-video', {});
  assert.equal(missing.status, 400);
  assert.match(missing.json.error, /mp4\/webm\/mov/);
  const badMime = await call(root, 'POST', '/api/scan-video', {
    videoData: 'data:image/png;base64,iVBORw0KGgo=',
  });
  assert.equal(badMime.status, 400);
  const passThrough = await call(root, 'POST', '/api/scan-video', {
    videoUrl: 'https://example.com/clip.mp4',
    frames: 99,
  });
  // URL passes validation; the job itself needs ffmpeg + key, so it must
  // fail as 400/500/502 — never 404, never a hang.
  assert.ok(passThrough.status !== null && [400, 500, 502].includes(passThrough.status));
});

test('events: list carries the spot update, add persists, bad date is 400', async (t: TestContext) => {
  const root = await scratch(t);
  const today = new Date().toISOString().slice(0, 10);
  const empty = await call(root, 'GET', '/api/events');
  assert.equal(empty.status, 200);
  assert.ok(Array.isArray(empty.json.events));
  assert.ok(empty.json.events.some((e: any) => e.kind === 'spot' && e.date === today));
  const created = await call(root, 'POST', '/api/events', { title: 'Spray test', date: '2026-10-26' });
  assert.equal(created.status, 200);
  assert.equal(created.json.event.kind, 'note');
  const again = await call(root, 'GET', '/api/events');
  assert.ok(again.json.events.some((e: any) => e.title === 'Spray test' && e.date === '2026-10-26'));
  const bad = await call(root, 'POST', '/api/events', { title: 'Spray test', date: 'tomorrow' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /YYYY-MM-DD/);
});

test('scan-video persists uploads where CLI children can find them', async (t: TestContext) => {
  // Relative roots (npm start's ./my-farm) must still land absolute paths:
  // children run from dist/ and resolve relative paths against it.
  const rel = `dash-rel-${process.pid}`;
  t.after(() => rm(join(process.cwd(), rel), { recursive: true, force: true }));
  const r = await call(rel, 'POST', '/api/scan-video', { videoData: 'data:video/mp4;base64,AAAA', frames: 1 });
  // No ffmpeg/key here, so the job itself must fail — but only AFTER persist.
  assert.ok(r.status !== null && [400, 500, 502].includes(r.status));
  const files = await readdir(join(process.cwd(), rel, 'media'));
  assert.equal(files.length, 1);
  assert.match(files[0] as string, /^clip-.*\.mp4$/);
});

test('media: serves stored clips, blocks traversal and odd extensions', async (t: TestContext) => {
  const root = await scratch(t);
  await mkdir(join(root, 'media'), { recursive: true });
  await writeFile(join(root, 'media', 'clip-x.mp4'), Buffer.from([0, 1, 2, 3]));
  assert.equal((await call(root, 'GET', '/media/clip-x.mp4')).status, 200);
  await writeFile(join(root, 'media', 'clip-x-0.gif'), Buffer.from('GIF89a'));
  assert.equal((await call(root, 'GET', '/media/clip-x-0.gif')).status, 200);
  assert.equal((await call(root, 'GET', '/media/..%2F..%2Fsecret')).status, 404);
  assert.equal((await call(root, 'GET', '/media/nope.mp4')).status, 404);
  assert.equal((await call(root, 'GET', '/media/x.txt')).status, 404);
});

test('event detail backfills actions from payload; toggles persist', async (t: TestContext) => {
  const root = await scratch(t);
  const { addEvent } = await import('./lib/events.js');
  const event = await addEvent(root, {
    title: 'Clip', date: '2026-10-29', kind: 'scan',
    payload: { suggested_next_steps: ['Wipe it', 'Tighten nozzle'] },
  });
  const id = event.id;
  // Actions backfill lazily from the payload on first detail read.
  const detail = await call(root, 'GET', `/api/events/${id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.actions.length, 2);
  assert.equal(detail.json.actions[0].status, 'open');
  const toggle = await call(root, 'POST', `/api/actions/${id}-a0`, { status: 'done' });
  assert.equal(toggle.status, 200);
  assert.equal(toggle.json.action.status, 'done');
  const again = await call(root, 'GET', `/api/events/${id}`);
  assert.equal(again.json.actions[0].status, 'done');
  assert.equal((await call(root, 'GET', '/api/events/nope')).status, 404);
  assert.equal((await call(root, 'POST', '/api/actions/nope-a0', { status: 'done' })).status, 400);
  assert.equal((await call(root, 'POST', `/api/actions/${id}-a0`, { status: 'finished' })).status, 400);
});

test('fetchRemote refuses dangerous URLs without fetching', async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), 'fetch-guard-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const img = { kinds: ['image'] as Array<'image' | 'video'>, maxBytes: 1024 };
  const vid = { kinds: ['video'] as Array<'image' | 'video'>, maxBytes: 1024 };
  await assert.rejects(fetchRemote('not a url', dir, 'x', img), /Bad URL/);
  await assert.rejects(fetchRemote('file:///etc/passwd', dir, 'x', img), /Only http/);
  await assert.rejects(fetchRemote('ftp://example.com/x.jpg', dir, 'x', img), /Only http/);
  await assert.rejects(fetchRemote('https://user:pass@example.com/x.jpg', dir, 'x', img), /credentials/);
  await assert.rejects(fetchRemote('http://127.0.0.1/x.mp4', dir, 'x', vid), /non-public/);
  await assert.rejects(fetchRemote('http://localhost/x.mp4', dir, 'x', vid), /non-public/);
  await assert.rejects(fetchRemote('http://169.254.169.254/latest', dir, 'x', vid), /non-public/);
  await assert.rejects(fetchRemote('http://[::1]/x.mp4', dir, 'x', vid), /non-public/);
});

test('unknown routes 404; non-JSON bodies 400', async (t: TestContext) => {
  const root = await scratch(t);
  assert.equal((await call(root, 'GET', '/api/nope')).status, 404);
  const server = createServer(root);
  const res = mockRes();
  const req = mockReq('POST', '/api/goals', '{not json');
  await server.listeners('request')[0](req, res);
  assert.equal(res.status, 400);
});

test('overview degrades on an empty project dir', async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), 'dash-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ov = (await call(root, 'GET', '/api/overview')).json;
  assert.deepEqual(ov.spots, []);
  assert.deepEqual(ov.goals, []);
  assert.equal(ov.plan, null);
  assert.equal(ov.eco, null);
});
