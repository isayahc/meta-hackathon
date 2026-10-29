// Calendar event store tests. No network, no API key.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addEvent, listStoredEvents, isDay, isTime, dayOf } from './events.js';

async function freshRoot(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'events-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('addEvent persists and lists back', async (t: TestContext) => {
  const root = await freshRoot(t);
  assert.deepEqual(await listStoredEvents(root), []);
  const e = await addEvent(root, { title: 'Spray bottle reassembled', date: '2026-10-26', kind: 'scan' });
  assert.match(e.id, /^spray-bottle-reassembled-\d+$/);
  assert.equal(e.time, null);
  const all = await listStoredEvents(root);
  assert.equal(all.length, 1);
  assert.equal(all[0]?.title, 'Spray bottle reassembled');
});

test('addEvent rejects bad title, date, and time', async (t: TestContext) => {
  const root = await freshRoot(t);
  await assert.rejects(addEvent(root, { title: '  ', date: '2026-10-26' }), /title/);
  await assert.rejects(addEvent(root, { title: 'X', date: 'tomorrow' }), /YYYY-MM-DD/);
  await assert.rejects(addEvent(root, { title: 'X', date: '2026-10-26', time: '9am' }), /HH:MM/);
  await assert.rejects(addEvent(root, { title: 'X', date: '2026-10-26', time: '25:00' }), /HH:MM/);
  assert.deepEqual(await listStoredEvents(root), []);
});

test('day helpers accept strict shapes only', () => {
  assert.equal(isDay('2026-10-26'), true);
  assert.equal(isDay('2026-13-40'), false);
  assert.equal(isDay('tomorrow'), false);
  assert.equal(isDay(null), false);
  assert.equal(isTime('09:30'), true);
  assert.equal(isTime('9:30'), false);
  assert.equal(isTime('24:00'), false);
  assert.equal(dayOf('2026-10-26T18:24:00.000Z'), '2026-10-26');
  assert.equal(dayOf('garbage'), null);
  assert.equal(dayOf(null), null);
});
