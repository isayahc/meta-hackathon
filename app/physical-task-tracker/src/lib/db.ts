// SQLite project store. A project root owns one fieldops.db holding every
// object the app tracks: goals, spots (+sessions), calendar events, and
// single docs (latest plan, latest eco fusion). The API key is NOT here —
// it stays in %APPDATA%/meta-hackathon/demo-key.json, outside the repo.
//
// node:sqlite is built into Node 22+: zero new dependencies. Connections
// are short-lived (open -> migrate -> use -> close) so CLI children and
// the server never share handles; WAL mode keeps concurrent readers safe.
//
// First open on an old project imports the legacy JSON files once
// (goals.json, spots/*, events.json, plan.json, eco.json). The JSON files
// are left in place, unread afterwards.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, type Stats } from 'node:fs';
import { join } from 'node:path';

export function dbPath(root: string): string {
  return join(root, 'fieldops.db');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS goals(
  id TEXT PRIMARY KEY, text TEXT NOT NULL, deadline TEXT,
  weight INTEGER NOT NULL DEFAULT 3, status TEXT NOT NULL DEFAULT 'open',
  created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS spots(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'unobserved',
  summary TEXT NOT NULL DEFAULT '', open_issues TEXT NOT NULL DEFAULT '[]',
  session_ids TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL, created TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions(
  sid TEXT NOT NULL, spot_id TEXT NOT NULL REFERENCES spots(id),
  analysis TEXT NOT NULL, created TEXT NOT NULL,
  UNIQUE(spot_id, sid)
);
CREATE TABLE IF NOT EXISTS events(
  id TEXT PRIMARY KEY, title TEXT NOT NULL, date TEXT NOT NULL,
  time TEXT, kind TEXT NOT NULL DEFAULT 'note', detail TEXT, created_at TEXT NOT NULL,
  payload TEXT, media TEXT
);
CREATE TABLE IF NOT EXISTS docs(
  key TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS actions(
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(id),
  idx INTEGER NOT NULL, text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(event_id, idx)
);
CREATE TABLE IF NOT EXISTS oi_links(
  entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL,
  scene_id TEXT NOT NULL, revision INTEGER NOT NULL,
  oi_entity_id TEXT NOT NULL, oi_revision TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'space', updated_at TEXT NOT NULL,
  PRIMARY KEY(entity_kind, entity_id, oi_entity_id)
);
CREATE TABLE IF NOT EXISTS processes(
  id TEXT NOT NULL, rev INTEGER NOT NULL,
  body TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'model',
  created TEXT NOT NULL,
  PRIMARY KEY(id, rev)
);
`;

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// One-time import of legacy JSON files into empty tables.
function migrateLegacyJson(db: DatabaseSync, root: string): void {
  const empty = (table: string): boolean => {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return row.n === 0;
  };
  if (empty('goals')) {
    const prior = readJsonFile(join(root, 'goals.json'));
    if (Array.isArray(prior)) {
      const ins = db.prepare(
        'INSERT OR IGNORE INTO goals(id, text, deadline, weight, status, created) VALUES(?, ?, ?, ?, ?, ?)'
      );
      for (const g of prior) {
        if (!isRecord(g) || typeof g.id !== 'string') continue;
        ins.run(
          g.id,
          typeof g.text === 'string' ? g.text : '',
          typeof g.deadline === 'string' ? g.deadline : null,
          typeof g.weight === 'number' ? g.weight : 3,
          typeof g.status === 'string' ? g.status : 'open',
          typeof g.created === 'string' ? g.created : new Date().toISOString()
        );
      }
    }
  }
  if (empty('spots')) {
    let ids: string[] = [];
    try {
      ids = readdirSync(join(root, 'spots')).sort();
    } catch { /* no legacy spots */ }
    const spotIns = db.prepare(
      'INSERT OR IGNORE INTO spots(id, name, stage, summary, open_issues, session_ids, updated_at, created) VALUES(?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const sessIns = db.prepare(
      'INSERT OR IGNORE INTO sessions(sid, spot_id, analysis, created) VALUES(?, ?, ?, ?)'
    );
    for (const id of ids) {
      const dir = join(root, 'spots', id);
      let st: Stats | null = null;
      try {
        st = statSync(dir);
      } catch { /* not a dir */ }
      if (!st?.isDirectory()) continue;
      const meta = readJsonFile(join(dir, 'spot.json'));
      const state = readJsonFile(join(dir, 'state.json'));
      if (!isRecord(state)) continue;
      const metaRec = isRecord(meta) ? meta : {};
      const sessionIds = Array.isArray(state.session_ids)
        ? (state.session_ids as unknown[]).filter((s): s is string => typeof s === 'string')
        : [];
      spotIns.run(
        id,
        typeof metaRec.name === 'string' ? metaRec.name : id,
        typeof state.stage === 'string' ? state.stage : 'unobserved',
        typeof state.summary === 'string' ? state.summary : '',
        JSON.stringify(Array.isArray(state.open_issues) ? state.open_issues : []),
        JSON.stringify(sessionIds),
        typeof state.updated_at === 'string'
          ? state.updated_at
          : new Date().toISOString(),
        typeof metaRec.created === 'string' ? metaRec.created : new Date().toISOString()
      );
      let files: string[] = [];
      try {
        files = readdirSync(join(dir, 'sessions')).sort();
      } catch { /* no sessions */ }
      for (const sid of files) {
        const analysis = readJsonFile(join(dir, 'sessions', sid, 'analysis.json'));
        if (analysis === null) continue;
        sessIns.run(sid, id, JSON.stringify(analysis), new Date().toISOString());
      }
    }
  }
  if (empty('events')) {
    const prior = readJsonFile(join(root, 'events.json'));
    if (Array.isArray(prior)) {
      const ins = db.prepare(
        'INSERT OR IGNORE INTO events(id, title, date, time, kind, detail, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)'
      );
      for (const e of prior) {
        if (!isRecord(e) || typeof e.id !== 'string' || typeof e.title !== 'string' || typeof e.date !== 'string') continue;
        ins.run(
          e.id, e.title, e.date,
          typeof e.time === 'string' ? e.time : null,
          typeof e.kind === 'string' ? e.kind : 'note',
          typeof e.detail === 'string' ? e.detail : null,
          typeof e.created_at === 'string' ? e.created_at : new Date().toISOString()
        );
      }
    }
  }
  if (empty('docs')) {
    const ins = db.prepare('INSERT OR IGNORE INTO docs(key, body, updated_at) VALUES(?, ?, ?)');
    for (const key of ['plan', 'eco']) {
      const prior = readJsonFile(join(root, `${key}.json`));
      if (prior !== null) ins.run(key, JSON.stringify(prior), new Date().toISOString());
    }
  }
}

export const DATABASE_VERSION = 1;

/** Upgrade legacy stores atomically; refuse stores from a newer application. */
export function openDb(root: string): DatabaseSync {
  mkdirSync(root, { recursive: true });
  const db = new DatabaseSync(dbPath(root));
  try {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (version > DATABASE_VERSION) throw new Error(`Database version ${version} is newer than supported version ${DATABASE_VERSION}. Use a compatible image; restore a backup for rollback.`);
  db.exec('PRAGMA busy_timeout = 5000');
  if (version === DATABASE_VERSION) { db.exec('PRAGMA journal_mode = WAL'); return db; }
  db.exec('BEGIN IMMEDIATE');
  db.exec(SCHEMA);
  // Column upgrades for DBs created before the column existed.
  for (const [table, column, decl] of [
    ['events', 'payload', 'TEXT'], ['events', 'media', 'TEXT'], ['events', 'timing_json', 'TEXT'],
    ['actions', 'task_json', 'TEXT'], ['actions', 'task_rev', 'INTEGER NOT NULL DEFAULT 1'],
    ['goals', 'success_criteria', "TEXT NOT NULL DEFAULT ''"],
  ] as const) {
    const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
  const required: Record<string, string[]> = {
    goals: ['id','text','deadline','weight','status','created','success_criteria'],
    spots: ['id','name','stage','summary','open_issues','session_ids','updated_at','created'],
    sessions: ['sid','spot_id','analysis','created'],
    events: ['id','title','date','time','kind','detail','created_at','payload','media','timing_json'],
    docs: ['key','body','updated_at'],
    actions: ['id','event_id','idx','text','status','created_at','updated_at','task_json','task_rev'],
    oi_links: ['entity_kind','entity_id','scene_id','revision','oi_entity_id','oi_revision','role','updated_at'],
    processes: ['id','rev','body','author','created'],
  };
  for (const [table, requiredColumns] of Object.entries(required)) {
    const actual = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name:string}>).map(c => c.name));
    if (requiredColumns.some(column => !actual.has(column))) throw new Error(`Incompatible legacy table ${table}; migration rolled back.`);
  }
  migrateLegacyJson(db, root);
  db.exec(`PRAGMA user_version = ${DATABASE_VERSION}`);
  db.exec('COMMIT');
  db.exec('PRAGMA journal_mode = WAL');
  return db;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* no active migration */ }
    db.close();
    throw error;
  }
}

// Short-lived use: open, migrate, run, close. Never throws on close.
export function withDb<T>(root: string, fn: (db: DatabaseSync) => T): T {
  const db = openDb(root);
  try {
    return fn(db);
  } finally {
    try {
      db.close();
    } catch { /* already closed */ }
  }
}

export function getDoc(root: string, key: string): unknown {
  return withDb(root, (db) => {
    const row = db.prepare('SELECT body FROM docs WHERE key = ?').get(key) as { body: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.body);
    } catch {
      return null;
    }
  });
}

export function setDoc(root: string, key: string, value: unknown): void {
  withDb(root, (db) => {
    db.prepare('INSERT INTO docs(key, body, updated_at) VALUES(?, ?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at').run(
      key,
      JSON.stringify(value),
      new Date().toISOString()
    );
  });
}

// Touch-only probe for tests: opens (creating + migrating) and closes.
export function initDb(root: string): string {
  withDb(root, () => {});
  return dbPath(root);
}

export function dbExists(root: string): boolean {
  return existsSync(dbPath(root));
}

