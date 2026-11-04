// Goals model + optimizer prompt tests. No network, no API key.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addGoal, listGoals, setGoalStatus } from './lib/goals.js';
import { buildOptimizerPrompt } from './lib/analyze-response.js';
import { buildProcessFromScan } from './lib/processes.js';

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
  await assert.rejects(async () => (await addGoal(root, { text: '  ' })), /required/);
  const g = await addGoal(root, { text: 'Water north row' });
  await assert.rejects(async () => (await setGoalStatus(root, g.id, 'soon')), /Bad status/);
  await assert.rejects(async () => (await setGoalStatus(root, 'nope-1', 'done')), /No goal/);
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
test('optimizer prompt carries corrected processes with revisions', () => {
  const process = buildProcessFromScan({
    id: 'proc-mulch',
    analysis: { observed_task: 'Mulch the north fence', suggested_next_steps: ['Finish spreading by hand'] },
  });
  process.rev = 2;
  process.steps[0]!.claim = 'corrected';
  const p = buildOptimizerPrompt([], [], [], null, [process]);
  assert.match(p, /proc-mulch/);
  assert.match(p, /rev 2/);
  assert.match(p, /Finish spreading by hand/);
  assert.match(p, /claim=corrected/);
  assert.match(p, /farmer-corrected steps outrank/);
});

test('optimizer keeps late steps, long constraints, and dependency uncertainty', () => {
  const process = buildProcessFromScan({
    id: 'long',
    analysis: { suggested_next_steps: Array.from({ length: 51 }, (_, i) => `Step ${i}`) },
  });
  process.steps[50]!.preconditions = ['x'.repeat(200) + ' wait for soil to dry'];
  process.steps[1]!.requires_unknown = false;
  process.steps[2]!.requires = ['long-s1'];
  const prompt = buildOptimizerPrompt([], [], [], null, [process]);
  assert.ok(prompt.includes(JSON.stringify(process)));
  assert.match(prompt, /\[long-s0\].*requires=unknown/);
  assert.match(prompt, /\[long-s1\].*requires=none/);
  assert.match(prompt, /\[long-s2\].*requires=unknown; known=long-s1/);
  assert.ok(prompt.includes(process.steps[50]!.preconditions[0]!));
});

