// Legacy JSON -> SQLite migration tests. No network, no API key.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, withDb, getDoc, setDoc, dbExists } from './db.js';
import { listGoals } from './goals.js';
import { readState, listSessions, readSession } from './spot-state.js';
import { listStoredEvents } from './events.js';

async function legacyRoot(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'db-migrate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, 'goals.json'),
    JSON.stringify([{ id: 'old-1', text: 'Old goal', deadline: null, weight: 2, status: 'open', created: '2026-01-01T00:00:00Z' }])
  );
  const spot = join(root, 'spots', 'north-fence');
  await mkdir(join(spot, 'sessions', '2026-10-28T09-00-00'), { recursive: true });
  await writeFile(join(spot, 'spot.json'), JSON.stringify({ id: 'north-fence', name: 'North fence', created: '2026-01-01T00:00:00Z' }));
  await writeFile(
    join(spot, 'state.json'),
    JSON.stringify({
      stage: 'fruiting',
      summary: 'Ripe tomatoes.',
      open_issues: ['Aphids'],
      session_ids: ['2026-10-28T09-00-00'],
      updated_at: '2026-10-28T09:00:00Z',
    })
  );
  await writeFile(
    join(spot, 'sessions', '2026-10-28T09-00-00', 'analysis.json'),
    JSON.stringify({ stage: 'fruiting' })
  );
  await writeFile(
    join(root, 'events.json'),
    JSON.stringify([{ id: 'e-1', title: 'Old event', date: '2026-10-26', time: null, kind: 'note', detail: null, created_at: '2026-01-01T00:00:00Z' }])
  );
  await writeFile(join(root, 'plan.json'), JSON.stringify({ plan: { ranked_actions: [] } }));
  await writeFile(join(root, 'eco.json'), JSON.stringify({ summary: 'Old eco.' }));
  return root;
}

test('first open migrates legacy JSON files into tables', async (t: TestContext) => {
  const root = await legacyRoot(t);
  assert.equal(dbExists(root), false);
  openDb(root).close();
  assert.equal(dbExists(root), true);

  const goals = await listGoals(root);
  assert.equal(goals.length, 1);
  assert.equal(goals[0]?.text, 'Old goal');

  const state = await readState(root, 'north-fence');
  assert.equal(state.stage, 'fruiting');
  assert.deepEqual(state.session_ids, ['2026-10-28T09-00-00']);
  assert.deepEqual(await listSessions(root, 'north-fence'), ['2026-10-28T09-00-00']);
  assert.equal((await readSession(root, 'north-fence', '2026-10-28T09-00-00')).stage, 'fruiting');

  const events = await listStoredEvents(root);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.title, 'Old event');

  assert.deepEqual((getDoc(root, 'plan') as any)?.plan, { ranked_actions: [] });
  assert.equal((getDoc(root, 'eco') as any)?.summary, 'Old eco.');
});

test('migration is idempotent and docs round-trip', async (t: TestContext) => {
  const root = await legacyRoot(t);
  openDb(root).close();
  openDb(root).close();
  assert.equal((await listGoals(root)).length, 1);
  setDoc(root, 'plan', { plan: { ranked_actions: [{ action: 'Do', why: 'test' }] } });
  assert.equal(((getDoc(root, 'plan') as any)?.plan?.ranked_actions as unknown[]).length, 1);
});

test('fresh roots start empty', async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), 'db-fresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  openDb(root).close();
  assert.deepEqual(await listGoals(root), []);
  assert.equal(getDoc(root, 'plan'), null);
  withDb(root, (db) => {
    db.prepare('INSERT INTO spots(id, name, stage, summary, open_issues, session_ids, updated_at, created) VALUES(?, ?, ?, ?, ?, ?, ?, ?)').run(
      'x', 'X', 'unobserved', '', '[]', '[]', new Date().toISOString(), new Date().toISOString()
    );
  });
});
