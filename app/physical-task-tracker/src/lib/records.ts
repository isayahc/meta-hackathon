/** Live project storage. MongoDB is canonical when the project has an explicit Mongo marker. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MongoClient, type Db, type Document, type ClientSession } from 'mongodb';
import { withDb } from './db.js';
import { COLUMNS, DEFAULTS, NUMERIC_FIELDS, JSON_FIELDS, KEYS, TABLES, RecordTransaction, emptyRows, recordKey, validateRow, type Rows, type Row, type Table } from './record-model.js';
export { RecordTransaction } from './record-model.js';
export const RECORD_SCHEMA = 1;
export const RECORD_MARKER = 'record-store.json';
export const MAX_RECORDS = 20_000;
export const MAX_RECORD_BYTES = 32 * 1024 * 1024;
export interface StoreMarker { backend: 'mongodb'; project_id: string; state: 'pending' | 'active' }
interface StoredRecord extends Document { _id: string; project_id: string; schema_version: number; position: number; data: Document }
export interface ProjectRecord extends Document { _id: string; schema_version: number; revision: number; source_digest: string }
/** Require a portable project identity, never a filesystem-derived or client-supplied query scope. */
export function projectId(value: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(value)) throw new Error('Project ID must contain 1–80 letters, digits, hyphens or underscores.');
  return value;
}
/** Read the durable authority marker; environment settings cannot silently switch a project back. */
export function storageMarker(root: string, allowPending = false): StoreMarker | null {
  const backend = process.env.FIELDOPS_RECORD_BACKEND;
  if (backend && backend !== 'sqlite' && backend !== 'mongodb') throw new Error('Unknown FIELDOPS_RECORD_BACKEND.');
  const file = join(root, RECORD_MARKER);
  if (!existsSync(file)) {
    if (backend === 'mongodb') throw new Error('MongoDB project is not initialized. Run task-records init or import first.');
    return null;
  }
  const marker = JSON.parse(readFileSync(file, 'utf8')) as StoreMarker;
  if (marker.backend !== 'mongodb' || !['pending','active'].includes(marker.state)) throw new Error('Invalid record-store.json');
  projectId(marker.project_id);
  if (backend === 'sqlite') throw new Error('This project is owned by MongoDB; refusing SQLite fallback.');
  if (process.env.FIELDOPS_PROJECT_ID && process.env.FIELDOPS_PROJECT_ID !== marker.project_id) throw new Error('Project identity does not match the durable marker.');
  if (!allowPending && marker.state !== 'active') throw new Error('MongoDB activation is incomplete. Resume task-records init/import with writers stopped.');
  return marker;
}
/** Open a short-lived client so CLIs exit and failed requests never retain a stale fallback connection. */
export async function withMongo<T>(fn: (client: MongoClient, db: Db) => Promise<T>): Promise<T> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required for this MongoDB project.');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, maxPoolSize: 2 });
  try { await client.connect(); return await fn(client, client.db(process.env.MONGODB_DATABASE || 'fieldops')); }
  finally { await client.close(); }
}
/** Bound the transaction working set and reject malformed rows before any commit. */
export function validateRows(rows: Rows): void {
  let count = 0, bytes = 0;
  for (const table of TABLES) {
    const keys = new Set<string>(), actions = new Set<string>();
    for (const row of rows[table]) {
      validateRow(table, row);
      for (const field of JSON_FIELDS[table] ?? []) if (row[field] !== null) JSON.parse(String(row[field]));
      const key = recordKey(table,row);
      if (keys.has(key)) throw new Error(`Duplicate ${table} record`); keys.add(key);
      if (table === 'actions') { const k = JSON.stringify([row.event_id,row.idx]); if (actions.has(k)) throw new Error('Duplicate event action'); actions.add(k); }
      const size = Buffer.byteLength(JSON.stringify(row)); if (size > 8 * 1024 * 1024) throw new Error('Record exceeds 8 MiB limit');
      count++; bytes += size;
      if (count > MAX_RECORDS || bytes > MAX_RECORD_BYTES) throw new Error('Project exceeds record working-set limit (20,000 records / 32 MiB).');
    }
  }
}
/** Convert JSON-bearing columns into native BSON fields while retaining the existing domain format. */
function encode(table: Table, row: Row): Document {
  const data: Document = { ...row };
  for (const field of JSON_FIELDS[table] ?? []) if (data[field] !== null) data[field] = JSON.parse(data[field]);
  return data;
}
/** Decode native BSON records for the domain transaction. */
function decode(table: Table, data: Document): Row {
  const row = { ...data } as Row;
  for (const field of JSON_FIELDS[table] ?? []) {
    const nullable = field in DEFAULTS[table] && DEFAULTS[table][field] === null;
    if (data[field] !== null || !nullable) row[field] = JSON.stringify(data[field]);
  }
  validateRow(table,row); return row;
}
/** Stable Mongo identity includes both project and record primary key. */
function mongoId(project: string, table: Table, row: Row): string { return createHash('sha256').update(JSON.stringify([project,table,recordKey(table,row)])).digest('hex'); }
/** Install scoped indexes and collection validators; only initialization requires schema privileges. */
export async function provisionRecords(db: Db): Promise<void> {
  const hello = await db.command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') throw new Error('MongoDB records require a replica set or transaction-capable sharded cluster.');
  for (const table of TABLES) {
    const name = `records_${table}`;
    const validator = { $jsonSchema: { bsonType: 'object', required: ['_id','project_id','schema_version','position','data'], additionalProperties: false,
      properties: { _id: { bsonType: 'string' }, project_id: { bsonType: 'string' }, schema_version: { enum: [RECORD_SCHEMA] }, position: { bsonType: ['int','long','double'] },
        data: { bsonType: 'object', required: COLUMNS[table], additionalProperties: false, properties: Object.fromEntries(COLUMNS[table].map(k => [k, { bsonType: (JSON_FIELDS[table] ?? []).includes(k) ? ['object','array','string','bool','int','long','double','null'] : [...(NUMERIC_FIELDS.has(k) ? ['int','long','double'] : ['string']), ...(DEFAULTS[table][k] === null ? ['null'] : [])] }])) } } } };
    if (!(await db.listCollections({ name }).hasNext())) {
      try { await db.createCollection(name, { validator }); } catch (error) { if ((error as {code?:number}).code !== 48) throw error; }
    }
    await db.collection(name).createIndex({ project_id: 1, position: 1 });
    await db.collection(name).createIndex(Object.fromEntries([['project_id',1], ...KEYS[table].map(k => [`data.${k}`,1])]) as Record<string,1>, { unique: true });
    if (table === 'actions') await db.collection(name).createIndex({ project_id: 1, 'data.event_id': 1, 'data.idx': 1 }, { unique: true });
  }
}
/** Read one consistent, bounded project snapshot inside the caller's transaction. */
async function loadRows(db: Db, project: string, session: ClientSession): Promise<Rows> {
  const rows = emptyRows(); let count = 0, bytes = 0;
  for (const table of TABLES) {
    const cursor = db.collection<StoredRecord>(`records_${table}`).find({ project_id: project }, { session }).sort({ position: 1, _id: 1 });
    try { for await (const record of cursor) {
      if (record.schema_version !== RECORD_SCHEMA) throw new Error('Incompatible record schema.');
      const row = decode(table, record.data); count++; bytes += Buffer.byteLength(JSON.stringify(row));
      if (count > MAX_RECORDS || bytes > MAX_RECORD_BYTES) throw new Error('Project exceeds record working-set limit.');
      rows[table].push(row);
    } } finally { await cursor.close(); }
  }
  validateRows(rows); return rows;
}
/** Persist only changed records, in the same transaction as the project revision fence. */
export async function writeMongoDiff(db: Db, project: string, before: Rows, after: Rows, session: ClientSession): Promise<void> {
  validateRows(after);
  for (const table of TABLES) {
    const old = new Map(before[table].map(r => [recordKey(table,r), r]));
    const positions = new Map(before[table].map((r,i) => [recordKey(table,r), i]));
    const operations = [];
    for (const [position,row] of after[table].entries()) {
      const key = recordKey(table,row), prior = old.get(key); old.delete(key);
      if (JSON.stringify(prior) === JSON.stringify(row) && positions.get(key) === position) continue;
      const record: StoredRecord = { _id: mongoId(project,table,row), project_id: project, schema_version: RECORD_SCHEMA, position, data: encode(table,row) };
      operations.push({ replaceOne: { filter: { _id: record._id, project_id: project }, replacement: record, upsert: true } });
    }
    for (const row of old.values()) operations.push({ deleteOne: { filter: { _id: mongoId(project,table,row), project_id: project } } });
    if (operations.length) await db.collection<StoredRecord>(`records_${table}`).bulkWrite(operations, { session });
  }
}
/** Run a domain operation on the selected backend; every Mongo write is majority-committed and atomic. */
export async function withRecords<T>(root: string, fn: (db: RecordTransaction) => T): Promise<T> {
  const marker = storageMarker(root);
  const execute = (rows: Rows): { result: T; after: Rows } => {
    const after = structuredClone(rows), result = fn(new RecordTransaction(after));
    if (result && typeof (result as {then?:unknown}).then === 'function') throw new Error('Record transaction callbacks must be synchronous and side-effect-free.');
    validateRows(after); return { result, after };
  };
  if (!marker) return withDb(root, db => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const before = emptyRows(); for (const table of TABLES) before[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Row[];
      const {result,after} = execute(before);
      for (const table of TABLES) {
        const old = new Map(before[table].map(r => [recordKey(table,r),r]));
        for (const row of after[table]) {
          const key = recordKey(table,row), prior = old.get(key); old.delete(key);
          if (JSON.stringify(prior) === JSON.stringify(row)) continue;
          const cols = COLUMNS[table];
          if (prior) {
            const updates = cols.filter(c => !KEYS[table].includes(c));
            db.prepare(`UPDATE ${table} SET ${updates.map(c=>`${c}=?`).join(',')} WHERE ${KEYS[table].map(c=>`${c}=?`).join(' AND ')}`).run(...updates.map(c=>row[c]), ...KEYS[table].map(c=>row[c]));
          } else db.prepare(`INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')})`).run(...cols.map(c=>row[c]));
        }
        for (const row of old.values()) db.prepare(`DELETE FROM ${table} WHERE ${KEYS[table].map(c=>`${c}=?`).join(' AND ')}`).run(...KEYS[table].map(c=>row[c]));
      }
      db.exec('COMMIT'); return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  });
  return withMongo(async (client,db) => {
    const session = client.startSession();
    try { return await session.withTransaction(async () => {
      const projects = db.collection<ProjectRecord>('record_projects');
      const project = await projects.findOne({ _id: marker.project_id }, { session });
      if (!project || project.schema_version !== RECORD_SCHEMA || !Number.isSafeInteger(project.revision) || project.revision < 0) throw new Error('Mongo project is missing or has an incompatible schema; refusing fallback.');
      const before = await loadRows(db, marker.project_id, session), {result,after} = execute(before);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        // Updating the shared fence turns write skew (including new receipts) into a retried transaction.
        const changed = await projects.updateOne({ _id: project._id, revision: project.revision }, { $inc: { revision: 1 } }, { session });
        if (changed.matchedCount !== 1) throw new Error('Concurrent project revision changed. Retry the operation.');
        await writeMongoDiff(db, project._id, before, after, session);
      }
      return result;
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, maxCommitTimeMS: 10000 }); }
    finally { await session.endSession(); }
  });
}
/** Check backend readiness without creating a competing store. */
export async function initRecords(root: string): Promise<void> { await withRecords(root, () => undefined); }
/** Read a project document from the selected authority. */
export async function getDoc(root: string, key: string): Promise<unknown> {
  return withRecords(root, db => { const row = db.first('docs', { where: { key } }); return row ? JSON.parse(String(row.body)) : null; });
}
/** Upsert a project document in one atomic operation. */
export async function setDoc(root: string, key: string, value: unknown): Promise<void> {
  await withRecords(root, db => { db.insert('docs', { key, body: JSON.stringify(value), updated_at: new Date().toISOString() }, { update: ['body','updated_at'] }); });
}
