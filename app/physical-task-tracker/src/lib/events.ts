// Calendar events: operator-visible log of what happened and what's due.
// Stored events live in the project's fieldops.db. Day/week/month views
// also overlay goal deadlines and spot updates derived at read time.
// No dependencies beyond node:sqlite (via lib/db).

import { withDb } from './db.js';

export type CalendarEventKind = 'scan' | 'spot' | 'goal' | 'note';

export interface CalendarEvent {
  id: string;
  title: string;
  /** Calendar day as YYYY-MM-DD. */
  date: string;
  /** Optional HH:MM. */
  time: string | null;
  kind: CalendarEventKind;
  detail: string | null;
  created_at: string;
}

export interface NewCalendarEvent {
  title: string;
  date: string;
  time?: string | null;
  kind?: CalendarEventKind;
  detail?: string | null;
}

interface EventRow {
  id: string;
  title: string;
  date: string;
  time: string | null;
  kind: CalendarEventKind;
  detail: string | null;
  created_at: string;
}

export async function listStoredEvents(root: string): Promise<CalendarEvent[]> {
  return withDb(root, (db) =>
    (db.prepare('SELECT id, title, date, time, kind, detail, created_at FROM events ORDER BY date, time').all() as unknown as EventRow[]).map(
      (r): CalendarEvent => ({
        id: r.id,
        title: r.title,
        date: r.date,
        time: r.time,
        kind: r.kind,
        detail: r.detail,
        created_at: r.created_at,
      })
    )
  );
}

export function isDay(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
}

export function isTime(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [h, m] = value.split(':').map(Number);
  return (h as number) >= 0 && (h as number) <= 23 && (m as number) >= 0 && (m as number) <= 59;
}

/** ISO instant (or null) -> calendar day. Garbage in, null out. */
export function dayOf(instant: unknown): string | null {
  if (typeof instant !== 'string' || !instant.trim()) return null;
  const t = Date.parse(instant);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

function slugify(text: string, n: number): string {
  const slug =
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'event';
  return `${slug}-${n}`;
}

export async function addEvent(
  root: string,
  { title, date, time = null, kind = 'note', detail = null }: NewCalendarEvent
): Promise<CalendarEvent> {
  if (!title?.trim()) throw new Error('Event title is required.');
  if (!isDay(date)) throw new Error(`Bad event date "${String(date)}": use YYYY-MM-DD.`);
  if (time !== null && time !== undefined && !isTime(time)) {
    throw new Error(`Bad event time "${String(time)}": use HH:MM.`);
  }
  return withDb(root, (db) => {
    const n = (db.prepare('SELECT COUNT(*) AS n FROM events').get() as unknown as { n: number }).n;
    const event: CalendarEvent = {
      id: slugify(title, n + 1),
      title: title.trim(),
      date,
      time: time ?? null,
      kind,
      detail: detail?.trim() ? (detail as string).trim() : null,
      created_at: new Date().toISOString(),
    };
    db.prepare('INSERT INTO events(id, title, date, time, kind, detail, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)').run(
      event.id,
      event.title,
      event.date,
      event.time,
      event.kind,
      event.detail,
      event.created_at
    );
    return event;
  });
}
