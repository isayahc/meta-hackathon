/** Zoned wall-clock conversion without guessing through DST gaps or folds. */
export function validZone(zone: string): void {
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(); }
  catch { throw new Error('Invalid project timezone. Use an IANA zone such as America/New_York.'); }
}
/** Require a real calendar date, retaining date-only semantics. */
export function validDay(day: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day) throw new Error('Invalid calendar date.');
}
/** Normalize an offset-bearing timestamp; local times must use the zoned converter. */
export function instant(value: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Timestamp requires an explicit UTC offset.');
  validDay(value.slice(0, 10)); return new Date(value).toISOString();
}
/** Render an instant using the project's timezone, independently of host timezone. */
export function localParts(value: string, zone: string): { day: string; time: string } {
  validZone(zone);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value));
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
/** Reject nonexistent local time and require explicit choice for repeated local time. */
export function zonedInstant(local: string, zone: string, fold?: 'earlier' | 'later'): string {
  if (fold !== undefined && fold !== 'earlier' && fold !== 'later') throw new Error('Choose earlier or later for repeated local time.');
  validZone(zone);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local) || Number(local.slice(11, 13)) > 23 || Number(local.slice(14)) > 59) throw new Error('Use local YYYY-MM-DDTHH:MM.');
  validDay(local.slice(0, 10));
  const naive = Date.parse(local + ':00Z'), offsets = new Set<number>();
  for (let h = -36; h <= 36; h += 6) {
    const ms = naive + h * 3600000, p = localParts(new Date(ms).toISOString(), zone);
    offsets.add(Date.parse(`${p.day}T${p.time}:00Z`) - ms);
  }
  const matches = [...offsets].map(o => new Date(naive - o).toISOString()).filter(t => {
    const p = localParts(t, zone); return `${p.day}T${p.time}` === local;
  }).sort();
  if (!matches.length) throw new Error('This local time does not exist because of a timezone transition.');
  if (matches.length > 1 && !fold) throw new Error('This local time occurs twice; choose earlier or later.');
  return fold === 'later' ? matches[matches.length - 1] : matches[0];
}
