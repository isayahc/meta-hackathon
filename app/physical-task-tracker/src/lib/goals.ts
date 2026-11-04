// Goals model: operator goals live in the project's fieldops.db and steer
// the optimizer. Status moves open -> at-risk -> done (or back) as
// briefings report. No dependencies beyond node:sqlite (via lib/db).
import type { RecordTransaction } from './record-model.js';
import { requestOnce } from './request-once.js';
import { withRecords } from './records.js';
import { validDay } from './planning-time.js';

export type GoalStatus = 'open' | 'at-risk' | 'done';

export interface Goal {
  id: string;
  text: string;
  deadline: string | null;
  weight: number;
  status: GoalStatus;
  created: string;
  success_criteria?: string;
}

export interface NewGoal {
  text: string;
  deadline?: string | null;
  weight?: number;
  success_criteria?: string;
}

interface GoalRow {
  id: string;
  text: string;
  deadline: string | null;
  weight: number;
  status: GoalStatus;
  created: string;
  success_criteria?: string;
}

function toGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    text: row.text,
    deadline: row.deadline,
    weight: row.weight,
    status: row.status,
    created: row.created,
    success_criteria: row.success_criteria ?? '',
  };
}

export async function listGoals(root: string): Promise<Goal[]> {
  return await withRecords(root, (db) =>
    db.select('goals')
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

export async function addGoal(root: string, input: NewGoal, requestId?: unknown): Promise<Goal> {
  return await withRecords(root, db => requestOnce(db, 'goal', requestId, input, () => addGoalInDb(db, input)));
}
/** Create an ordinary goal within a workflow transaction. */
export function addGoalInDb(db: RecordTransaction, { text, deadline = null, weight = 3, success_criteria = '' }: NewGoal): Goal {
  if (!text?.trim()) throw new Error('Goal text is required.');
  if (deadline !== null) validDay(deadline);
  if (typeof success_criteria !== 'string' || success_criteria.length > 2000) throw new Error('Invalid success criteria.');
  const w = Math.min(5, Math.max(1, Number(weight) || 3));
  const n = (({ n: db.select('goals').length }) as unknown as { n: number }).n;
  const goal: Goal = {
    id: slugify(text, n + 1),
    text: text.trim(),
    deadline,
    weight: w,
    status: 'open',
    created: new Date().toISOString(),
    success_criteria,
  };
  db.insert('goals', { id: goal.id, text: goal.text, deadline: goal.deadline, weight: goal.weight, status: goal.status, created: goal.created, success_criteria: success_criteria });
  return goal;
}

const ALLOWED: ReadonlySet<string> = new Set(['open', 'at-risk', 'done']);

export async function setGoalStatus(root: string, id: string, status: string): Promise<Goal> {
  if (!ALLOWED.has(status)) {
    throw new Error(`Bad status "${status}": want open, at-risk, or done.`);
  }
  return await withRecords(root, (db) => {
    const row = db.first('goals', { where: { id: id } }) as
      | GoalRow
      | undefined;
    if (!row) throw new Error(`No goal "${id}".`);
    db.update('goals', { id: id }, { status: status });
    return toGoal({ ...row, status: status as GoalStatus });
  });
}

