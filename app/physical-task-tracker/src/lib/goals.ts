// Goals model: operator goals live in the project's fieldops.db and steer
// the optimizer. Status moves open -> at-risk -> done (or back) as
// briefings report. No dependencies beyond node:sqlite (via lib/db).
import { withDb } from './db.js';

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

interface GoalRow {
  id: string;
  text: string;
  deadline: string | null;
  weight: number;
  status: GoalStatus;
  created: string;
}

function toGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    text: row.text,
    deadline: row.deadline,
    weight: row.weight,
    status: row.status,
    created: row.created,
  };
}

export async function listGoals(root: string): Promise<Goal[]> {
  return withDb(root, (db) =>
    db
      .prepare('SELECT id, text, deadline, weight, status, created FROM goals ORDER BY rowid')
      .all()
      .map((r) => toGoal(r as unknown as GoalRow))
  );
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
  return withDb(root, (db) => {
    const n = (db.prepare('SELECT COUNT(*) AS n FROM goals').get() as unknown as { n: number }).n;
    const goal: Goal = {
      id: slugify(text, n + 1),
      text: text.trim(),
      deadline,
      weight: w,
      status: 'open',
      created: new Date().toISOString(),
    };
    db.prepare('INSERT INTO goals(id, text, deadline, weight, status, created) VALUES(?, ?, ?, ?, ?, ?)').run(
      goal.id,
      goal.text,
      goal.deadline,
      goal.weight,
      goal.status,
      goal.created
    );
    return goal;
  });
}

const ALLOWED: ReadonlySet<string> = new Set(['open', 'at-risk', 'done']);

export async function setGoalStatus(root: string, id: string, status: string): Promise<Goal> {
  if (!ALLOWED.has(status)) {
    throw new Error(`Bad status "${status}": want open, at-risk, or done.`);
  }
  return withDb(root, (db) => {
    const row = db.prepare('SELECT id, text, deadline, weight, status, created FROM goals WHERE id = ?').get(id) as
      | GoalRow
      | undefined;
    if (!row) throw new Error(`No goal "${id}".`);
    db.prepare('UPDATE goals SET status = ? WHERE id = ?').run(status, id);
    return toGoal({ ...row, status: status as GoalStatus });
  });
}
