// Goals model: operator goals live in <project>/goals.json and steer the
// optimizer. A goal is { id, text, deadline, weight 1-5, status, created }.
// Status moves open -> at-risk -> done (or back) as briefings report.
// No dependencies. Node 18+.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export function goalsPath(root) {
  return join(root, 'goals.json');
}

export async function listGoals(root) {
  try {
    const raw = await readFile(goalsPath(root), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveGoals(root, goals) {
  await mkdir(root, { recursive: true });
  await writeFile(goalsPath(root), JSON.stringify(goals, null, 2));
}

function slugify(text, n) {
  const slug =
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'goal';
  return `${slug}-${n}`;
}

export async function addGoal(root, { text, deadline = null, weight = 3 }) {
  if (!text?.trim()) throw new Error('Goal text is required.');
  const w = Math.min(5, Math.max(1, Number(weight) || 3));
  const goals = await listGoals(root);
  const goal = {
    id: slugify(text, goals.length + 1),
    text: text.trim(),
    deadline,
    weight: w,
    status: 'open',
    created: new Date().toISOString(),
  };
  goals.push(goal);
  await saveGoals(root, goals);
  return goal;
}

export async function setGoalStatus(root, id, status) {
  const allowed = new Set(['open', 'at-risk', 'done']);
  if (!allowed.has(status)) {
    throw new Error(`Bad status "${status}": want open, at-risk, or done.`);
  }
  const goals = await listGoals(root);
  const goal = goals.find((g) => g.id === id);
  if (!goal) throw new Error(`No goal "${id}".`);
  goal.status = status;
  await saveGoals(root, goals);
  return goal;
}
