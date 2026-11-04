/** Public CLI/HTTP integration over the shared task store; no listening server. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createServer } from './serve-dashboard.js';
import { addGoal, listGoals } from './lib/goals.js';
import { configurePlanning, proposePlan, decidePlan } from './lib/task-planning.js';

test('HTTP task links, legacy checklist completion, calendar and CLI share one task identity', async t => {
  const root = await mkdtemp(join(tmpdir(), 'planning-api-')); t.after(() => rm(root, { recursive: true, force: true }));
  const handler = createServer(root).listeners('request')[0];
  async function request(method: string, url: string, payload?: unknown) {
    let status = 0, body = '';
    const req = { method, url, async *[Symbol.asyncIterator]() { if (payload) yield Buffer.from(JSON.stringify(payload)); } };
    const res = { writeHead(code: number) { status = code; }, end(value: string) { body = value; } };
    await handler(req, res); return { status, json: JSON.parse(body) };
  }
  const goal = await addGoal(root, { text: 'Prepare trays' });
  const create = await request('POST', '/api/task-planning', { command: 'create', request_id: 'one', task: { text: 'Fill tray', completion_criteria: 'Filled', active_minutes: 20, estimate_source: 'Operator', links: [{ goal_id: goal.id, explanation: 'One tray contributes', origin: 'human', review: 'confirmed' }] } });
  assert.equal(create.status, 200); const task = create.json;
  const cli = fileURLToPath(new URL('./task-planning.js', import.meta.url));
  const command = join(root, 'command.json'); await writeFile(command, JSON.stringify({ command: 'edit', id: task.id, revision: task.revision, patch: { remaining_minutes: 25 }, reason: 'Measured setup time' }));
  const result = await promisify(execFile)(process.execPath, [cli, '--root', root, '--command', command]);
  assert.equal(JSON.parse(result.stdout).id, task.id);
  assert.equal((await request('POST', '/api/task-planning', { command: 'edit', id: task.id, revision: task.revision, patch: {}, reason: 'stale' })).status, 409);
  configurePlanning(root, 1, { timezone: 'America/New_York', person: 'operator', max_minutes: 120, resources: {}, availability: [{ start: '2030-01-10T09:00:00-05:00', end: '2030-01-10T11:00:00-05:00' }] });
  const plan = proposePlan(root, '2030-01-10', '2030-01-10T08:00:00-05:00');
  decidePlan(root, plan.id, 'accepted', 'Reviewed', '2030-01-10T08:00:00-05:00');
  const events = (await request('GET', '/api/events')).json.events;
  const block = events.find((e: { task_id: string }) => e.task_id === task.id);
  assert.equal(block.time, '09:00'); assert.equal(block.scheduling, 'accepted'); assert.deepEqual(block.goal_ids, [goal.id]);
  assert.equal((await request('POST', `/api/actions/${task.id}`, { status: 'done' })).status, 200);
  const view = (await request('GET', '/api/task-planning')).json;
  assert.equal(view.tasks.length, 1); assert.equal(view.tasks[0].execution, 'done'); assert.equal((await listGoals(root))[0].status, 'open');
});

test('optimizer UI adopts a task rather than completing the parent goal', async () => {
  const html = await readFile(new URL('./dashboard/index.html', import.meta.url), 'utf8');
  const functionBody = html.slice(html.indexOf('function renderActions('), html.indexOf('function renderFeed('));
  assert.match(functionBody, /Review as task/); assert.match(functionBody, /command: 'create'/); assert.doesNotMatch(functionBody, /setGoal\(/);
});
