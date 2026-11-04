/** Explicit, offline activation of MongoDB as the project's sole record authority. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATABASE_VERSION } from './db.js';
import { emptyRows, TABLES, type Rows, type Row } from './record-model.js';
import { projectId, provisionRecords, RECORD_MARKER, RECORD_SCHEMA, storageMarker, validateRows, withMongo, writeMongoDiff, type ProjectRecord, type StoreMarker } from './records.js';

/** Inventory existing SQLite records without migrations or source writes. */
export function inspectRecordImport(root: string): Rows {
  const db = new DatabaseSync(join(root,'fieldops.db'), { readOnly: true } as never);
  try {
    if ((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version !== DATABASE_VERSION) throw new Error('Source schema is incompatible; upgrade and back up the SQLite project before importing.');
    if ((db.prepare('PRAGMA integrity_check').get() as {integrity_check:string})?.integrity_check !== 'ok') throw new Error('Source integrity check failed.');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as {name:string}[];
    if (tables.some(t => !(TABLES as readonly string[]).includes(t.name))) throw new Error('Source contains unknown tables.');
    const rows = emptyRows(); for (const table of TABLES) rows[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Row[];
    validateRows(rows); return rows;
  } finally { db.close(); }
}
/** Create or resume an offline activation. A pending marker blocks writes after partial failure. */
export async function activateMongo(root: string, id: string, mode: 'init' | 'import'): Promise<{ project_id: string; records: number; source_digest: string }> {
  projectId(id); mkdirSync(root, { recursive: true });
  const file = join(root,RECORD_MARKER);
  const existing = existsSync(file) ? storageMarker(root,true) : null;
  if (existing && existing.project_id !== id) throw new Error('Project marker already belongs to a different identity.');
  if (existing?.state === 'active') throw new Error('Project is already active in MongoDB; refusing reinitialization.');
  if (mode === 'init' && existsSync(join(root,'fieldops.db'))) throw new Error('SQLite project exists. Use import to preserve its records.');
  const rows = mode === 'import' ? inspectRecordImport(root) : emptyRows();
  const digest = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  // Reserve authority before any remote write. On failure the operator resumes this same command.
  if (!existing) writeFileSync(file, JSON.stringify({backend:'mongodb',project_id:id,state:'pending'} satisfies StoreMarker)+'\n', { flag:'wx', mode:0o600 });
  await withMongo(async (client,db) => {
    await provisionRecords(db);
    const session = client.startSession();
    try { await session.withTransaction(async () => {
      const projects = db.collection<ProjectRecord>('record_projects');
      const prior = await projects.findOne({ _id:id }, { session });
      if (prior) {
        if (prior.schema_version !== RECORD_SCHEMA || prior.source_digest !== digest || prior.revision !== 0) throw new Error('Mongo project already has different or newer records; refusing overwrite.');
        return;
      }
      for (const table of TABLES) if (await db.collection(`records_${table}`).findOne({ project_id:id }, { session })) throw new Error('Orphaned project records exist; investigate before activation.');
      await projects.insertOne({_id:id,schema_version:RECORD_SCHEMA,revision:0,source_digest:digest}, { session });
      await writeMongoDiff(db,id,emptyRows(),rows,session);
    }, {readConcern:{level:'snapshot'},writeConcern:{w:'majority'}}); }
    finally { await session.endSession(); }
  });
  const current = JSON.parse(readFileSync(file,'utf8')) as StoreMarker;
  if (current.project_id !== id || current.state !== 'pending') throw new Error('Authority marker changed during activation.');
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary,JSON.stringify({backend:'mongodb',project_id:id,state:'active'} satisfies StoreMarker)+'\n',{flag:'wx',mode:0o600});
  renameSync(temporary,file);
  return {project_id:id,records:TABLES.reduce((n,t)=>n+rows[t].length,0),source_digest:digest};
}
