// Goals model + optimizer prompt tests. No network, no API key.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addGoal, listGoals, setGoalStatus } from './lib/goals.js';
import { buildOptimizerPrompt } from './lib/analyze-response.js';

async function freshRoot(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'goals-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('addGoal persists with clamped weight and slug id', async (t: TestContext) => {
  const root = await freshRoot(t);
  const g = await addGoal(root, { text: 'Finish transplanting bed 3', weight: 9 });
  assert.equal(g.weight, 5);
  assert.match(g.id, /^finish-transplanting-bed-3-\d+$/);
  assert.equal(g.status, 'open');
  assert.deepEqual((await listGoals(root)).length, 1);
});

test('addGoal rejects empty text; setGoalStatus validates', async (t: TestContext) => {
  const root = await freshRoot(t);
  await assert.rejects(() => addGoal(root, { text: '  ' }), /required/);
  const g = await addGoal(root, { text: 'Water north row' });
  await assert.rejects(() => setGoalStatus(root, g.id, 'soon'), /Bad status/);
  await assert.rejects(() => setGoalStatus(root, 'nope-1', 'done'), /No goal/);
  assert.equal((await setGoalStatus(root, g.id, 'at-risk')).status, 'at-risk');
});

test('listGoals returns [] outside any project', async (t: TestContext) => {
  assert.deepEqual(await listGoals(await freshRoot(t)), []);
});

test('optimizer prompt ranks by weight/deadline, hides done goals', () => {
  const p = buildOptimizerPrompt(
    [
      { id: 'a-1', text: 'Harvest bed 1', deadline: '2026-11-01', weight: 5, status: 'open', created: '' },
      { id: 'b-2', text: 'Paint shed', deadline: null, weight: 1, status: 'done', created: '' },
    ],
    [{ id: 'bed1', name: 'Bed 1', stage: 'fruiting', summary: 'Ripe tomatoes.', open_issues: ['Aphids on row 2'] }],
    ['No spraying before rain window closes']
  );
  assert.match(p, /Harvest bed 1/);
  assert.match(p, /weight 5\/5/);
  assert.match(p, /Aphids on row 2/);
  assert.match(p, /No spraying before rain/);
  assert.doesNotMatch(p, /Paint shed/);
  assert.match(p, /ranked_actions/);
});

test('optimizer prompt degrades gracefully with no goals or spots', () => {
  const p = buildOptimizerPrompt([], [], []);
  assert.match(p, /no open goals/i);
  assert.match(p, /no spots observed/i);
});
