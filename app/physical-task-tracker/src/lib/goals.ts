// Goals model: operator goals live in <project>/goals.json and steer the
// optimizer. Status moves open -> at-risk -> done (or back) as briefings
// report. No dependencies. Node 18+.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export type GoalStatus = 'open' | 'at-risk' | 'done';

export interface Goal {
  id: string;
  text: string;
  deadline: string | null;
  weight: number;
  status: GoalStatus;
  created: string;
}

export interface NewGoal {
  text: string;
  deadline?: string | null;
  weight?: number;
}

export function goalsPath(root: string): string {
  return join(root, 'goals.json');
}

export async function listGoals(root: string): Promise<Goal[]> {
  try {
    const raw = await readFile(goalsPath(root), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Goal[]) : [];
  } catch {
    return [];
  }
}

async function saveGoals(root: string, goals: Goal[]): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(goalsPath(root), JSON.stringify(goals, null, 2));
}

function slugify(text: string, n: number): string {
  const slug =
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'goal';
  return `${slug}-${n}`;
}

export async function addGoal(root: string, { text, deadline = null, weight = 3 }: NewGoal): Promise<Goal> {
  if (!text?.trim()) throw new Error('Goal text is required.');
  const w = Math.min(5, Math.max(1, Number(weight) || 3));
  const goals = await listGoals(root);
  const goal: Goal = {
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

const ALLOWED: ReadonlySet<string> = new Set(['open', 'at-risk', 'done']);

export async function setGoalStatus(root: string, id: string, status: string): Promise<Goal> {
  if (!ALLOWED.has(status)) {
    throw new Error(`Bad status "${status}": want open, at-risk, or done.`);
  }
  const goals = await listGoals(root);
  const goal = goals.find((g) => g.id === id);
  if (!goal) throw new Error(`No goal "${id}".`);
  goal.status = status as GoalStatus;
  await saveGoals(root, goals);
  return goal;
}
