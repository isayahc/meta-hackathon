// Durable video-action tests. No network, no API key.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listActions, syncActions, setActionStatus } from './actions.js';
import { addEvent } from './events.js';
import { listGoals } from './goals.js';

async function freshRoot(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'actions-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function seeded(t: TestContext) {
  const root = await freshRoot(t);
  const event = await addEvent(root, { title: 'Clip', date: '2026-10-29', kind: 'scan' });
  return { root, event };
}

test('syncActions inserts once with stable ids and is idempotent', async (t: TestContext) => {
  const { root, event } = await seeded(t);
  assert.deepEqual(await listActions(root, event.id), []);
  const first = await syncActions(root, event.id, ['Wipe it', 'Tighten nozzle']);
  assert.deepEqual(first.map((a) => a.id), [`${event.id}-a0`, `${event.id}-a1`]);
  assert.ok(first.every((a) => a.status === 'open'));
  const again = await syncActions(root, event.id, ['Wipe it', 'Tighten nozzle']);
  assert.equal(again.length, 2);
  assert.deepEqual(
    (await listActions(root, event.id)).map((a) => a.text),
    ['Wipe it', 'Tighten nozzle']
  );
});

test('setActionStatus flips open/done and rejects bad ids and statuses', async (t: TestContext) => {
  const { root, event } = await seeded(t);
  await syncActions(root, event.id, ['Wipe it']);
  const id = `${event.id}-a0`;
  assert.equal((await setActionStatus(root, id, 'done')).status, 'done');
  assert.equal((await setActionStatus(root, id, 'open')).status, 'open');
  await assert.rejects(setActionStatus(root, id, 'finished'), /Bad status/);
  await assert.rejects(setActionStatus(root, 'nope-a0', 'done'), /No action/);
});

test('toggling actions never touches goals (action/goal split)', async (t: TestContext) => {
  const { root, event } = await seeded(t);
  await syncActions(root, event.id, ['Wipe it']);
  await setActionStatus(root, `${event.id}-a0`, 'done');
  assert.deepEqual(await listGoals(root), []);
});
