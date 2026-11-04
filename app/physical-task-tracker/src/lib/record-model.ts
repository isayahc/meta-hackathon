/** Backend-independent records used by synchronous, side-effect-free domain transactions. */
export type Cell = string | number | null;
export type Row = Record<string, Cell>;
export const TABLES = ['goals', 'spots', 'sessions', 'events', 'docs', 'actions', 'oi_links', 'processes'] as const;
export type Table = typeof TABLES[number];
export type Rows = Record<Table, Row[]>;
export const KEYS: Record<Table, string[]> = {
  goals: ['id'], spots: ['id'], sessions: ['spot_id', 'sid'], events: ['id'], docs: ['key'],
  actions: ['id'], oi_links: ['entity_kind', 'entity_id', 'oi_entity_id'], processes: ['id', 'rev'],
};
export const DEFAULTS: Record<Table, Row> = {
  goals: { deadline: null, weight: 3, status: 'open', success_criteria: '' },
  spots: { stage: 'unobserved', summary: '', open_issues: '[]', session_ids: '[]' },
  sessions: {}, events: { time: null, kind: 'note', detail: null, payload: null, media: null, timing_json: null },
  docs: {}, actions: { status: 'open', task_json: null, task_rev: 1 }, oi_links: { oi_revision: '', role: 'space' }, processes: { author: 'model' },
};
export const COLUMNS: Record<Table, string[]> = {
  goals: ['id','text','deadline','weight','status','created','success_criteria'],
  spots: ['id','name','stage','summary','open_issues','session_ids','updated_at','created'],
  sessions: ['sid','spot_id','analysis','created'],
  events: ['id','title','date','time','kind','detail','created_at','payload','media','timing_json'],
  docs: ['key','body','updated_at'],
  actions: ['id','event_id','idx','text','status','created_at','updated_at','task_json','task_rev'],
  oi_links: ['entity_kind','entity_id','scene_id','revision','oi_entity_id','oi_revision','role','updated_at'],
  processes: ['id','rev','body','author','created'],
};
/** JSON-valued fields are stored as BSON values in MongoDB, not escaped JSON strings. */
export const JSON_FIELDS: Partial<Record<Table, string[]>> = {
  spots: ['open_issues','session_ids'], sessions: ['analysis'], events: ['timing_json'],
  docs: ['body'], actions: ['task_json'], processes: ['body'],
};
export interface Query { where?: Row; prefix?: Row; notNull?: string[]; order?: string[]; fields?: string[] }
export interface InsertOptions { conflict?: string[]; ignore?: boolean; update?: string[] }

/** Construct an empty project snapshot. */
export function emptyRows(): Rows { return Object.fromEntries(TABLES.map(t => [t, []])) as unknown as Rows; }
/** Stable identity shared by the SQLite and MongoDB adapters. */
export function recordKey(table: Table, row: Row): string { return JSON.stringify(KEYS[table].map(k => row[k])); }
/** Validate a complete row before it becomes canonical. */
export function validateRow(table: Table, row: Row): void {
  for (const key of Object.keys(row)) if (!COLUMNS[table].includes(key)) throw new Error(`Unknown ${table} field: ${key}`);
  for (const key of COLUMNS[table]) {
    const v = row[key];
    if (v === undefined || v !== null && typeof v !== 'string' && (typeof v !== 'number' || !Number.isFinite(v))) throw new Error(`Invalid ${table}.${key}`);
    if (v === null && !(key in DEFAULTS[table] && DEFAULTS[table][key] === null)) throw new Error(`Required ${table}.${key}`);
  }
}
/** Compare scalar values with SQLite's null-first ordering and binary string collation. */
function compare(a: Cell, b: Cell): number { return a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1; }

/** A bounded transaction working set. No filesystem or database access occurs in domain callbacks. */
export class RecordTransaction {
  constructor(public readonly rows: Rows) {}
  /** Query rows, returning copies so mutation always goes through insert/update/remove. */
  select(table: Table, query: Query = {}): Row[] {
    let rows = this.rows[table].filter(r => Object.entries(query.where ?? {}).every(([k,v]) => r[k] === v)
      && Object.entries(query.prefix ?? {}).every(([k,v]) => String(r[k]).startsWith(String(v)))
      && (query.notNull ?? []).every(k => r[k] !== null));
    if (query.order?.length) rows = [...rows].sort((a,b) => {
      for (const key of query.order!) { const desc = key.startsWith('-'), k = desc ? key.slice(1) : key; const n = compare(a[k], b[k]); if (n) return desc ? -n : n; } return 0;
    });
    return rows.map(r => query.fields ? Object.fromEntries(query.fields.map(k => [k, r[k]])) : { ...r });
  }
  /** Read the first matching record, respecting explicit ordering. */
  first(table: Table, query: Query = {}): Row | undefined { return this.select(table, query)[0]; }
  /** Insert or explicitly handle one unique-key conflict. */
  insert(table: Table, input: Row, options: InsertOptions = {}): { changes: number } {
    const row = { ...DEFAULTS[table], ...input }; validateRow(table, row);
    const constraints = [KEYS[table], ...(table === 'actions' ? [['event_id','idx']] : [])];
    const conflicts = constraints.flatMap(keys => this.rows[table].filter(r => keys.every(k => r[k] === row[k])).map(r => ({ keys, row: r })));
    if (conflicts.length) {
      const allowed = options.conflict ?? KEYS[table];
      const conflict = conflicts.find(c => c.keys.join() === allowed.join());
      if (!conflict || conflicts.some(c => c.row !== conflict.row)) throw new Error(`Duplicate ${table} identity`);
      if (options.ignore) return { changes: 0 };
      if (options.update) { for (const k of options.update) conflict.row[k] = row[k]; return { changes: 1 }; }
      throw new Error(`Duplicate ${table} identity`);
    }
    this.rows[table].push(row); return { changes: 1 };
  }
  /** Update matching records. Record identities are immutable. */
  update(table: Table, where: Row, patch: Row): { changes: number } {
    if (KEYS[table].some(k => k in patch) || table === 'actions' && ('event_id' in patch || 'idx' in patch)) throw new Error('Record identity is immutable');
    let changes = 0;
    for (const row of this.rows[table]) if (Object.entries(where).every(([k,v]) => row[k] === v)) {
      validateRow(table, { ...row, ...patch }); Object.assign(row, patch); changes++;
    }
    return { changes };
  }
  /** Remove matching records in the enclosing transaction. */
  remove(table: Table, where: Row): { changes: number } {
    const before = this.rows[table].length;
    this.rows[table] = this.rows[table].filter(r => !Object.entries(where).every(([k,v]) => r[k] === v));
    return { changes: before - this.rows[table].length };
  }
  /** Return the latest revision per process, ordered by ID. */
  latestProcesses(): Row[] {
    const latest = new Map<Cell, Row>();
    for (const r of this.select('processes', { order: ['id','-rev'] })) if (!latest.has(r.id)) latest.set(r.id, r);
    return [...latest.values()];
  }
  /** Return counts grouped by a field. */
  counts(table: Table, field: string): Row[] {
    const counts = new Map<Cell, number>(); for (const r of this.rows[table]) counts.set(r[field], (counts.get(r[field]) ?? 0) + 1);
    return [...counts].map(([value,n]) => ({ [field]: value, n }));
  }
}
