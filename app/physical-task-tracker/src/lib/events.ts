// Calendar events: operator-visible log of what happened and what's due.
// Stored events live in the project's fieldops.db. Day/week/month views
// also overlay goal deadlines and spot updates derived at read time.
// No dependencies beyond node:sqlite (via lib/db).

import { requestOnce } from './request-once.js';
import { withRecords } from './records.js';

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
  /** Stored analysis JSON (video task list) for scan entries. */
  payload: string | null;
  /** Stored clip file name under <project>/media for scan entries. */
  media: string | null;
  created_at: string;
}

export interface NewCalendarEvent {
  title: string;
  date: string;
  time?: string | null;
  kind?: CalendarEventKind;
  detail?: string | null;
  payload?: unknown;
  media?: string | null;
}

interface EventRow {
  id: string;
  title: string;
  date: string;
  time: string | null;
  kind: CalendarEventKind;
  detail: string | null;
  payload: string | null;
  media: string | null;
  created_at: string;
}

export async function listStoredEvents(root: string): Promise<CalendarEvent[]> {
  return await withRecords(root, (db) =>
    (db.select('events', { order: ["date","time"], fields: ["id","title","date","time","kind","detail","payload","media","created_at"] }) as unknown as EventRow[]).map(
      (r): CalendarEvent => ({
        id: r.id,
        title: r.title,
        date: r.date,
        time: r.time,
        kind: r.kind,
        detail: r.detail,
        payload: r.payload ?? null,
        media: r.media ?? null,
        created_at: r.created_at,
      })
    )
  );
}

export async function getStoredEvent(root: string, id: string): Promise<CalendarEvent | null> {
  const all = await listStoredEvents(root);
  return all.find((e) => e.id === id) ?? null;
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
  { title, date, time = null, kind = 'note', detail = null, payload = null, media = null }: NewCalendarEvent,
  requestId?: unknown
): Promise<CalendarEvent> {
  if (!title?.trim()) throw new Error('Event title is required.');
  if (!isDay(date)) throw new Error(`Bad event date "${String(date)}": use YYYY-MM-DD.`);
  if (time !== null && time !== undefined && !isTime(time)) {
    throw new Error(`Bad event time "${String(time)}": use HH:MM.`);
  }
  const payloadText = payload === null || payload === undefined ? null : typeof payload === 'string' ? payload : JSON.stringify(payload);
  const mediaName = typeof media === 'string' && media && !media.includes('/') && !media.includes('\\') ? media : null;
  return await withRecords(root, (db) => requestOnce(db, 'event', requestId, { title, date, time, kind, detail, payload, media }, () => {
    const n = (({ n: db.select('events').length }) as unknown as { n: number }).n;
    const event: CalendarEvent = {
      id: slugify(title, n + 1),
      title: title.trim(),
      date,
      time: time ?? null,
      kind,
      detail: detail?.trim() ? (detail as string).trim() : null,
      payload: payloadText,
      media: mediaName,
      created_at: new Date().toISOString(),
    };
    db.insert('events', { id: event.id, title: event.title, date: event.date, time: event.time, kind: event.kind, detail: event.detail, payload: event.payload, media: event.media, created_at: event.created_at });
    return event;
  }));
}

