import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** Commit a creation and its retry receipt atomically in the canonical project database. */
export function requestOnce<T>(db: DatabaseSync, scope: string, requestId: unknown, input: unknown, create: () => T): T {
  if (requestId === undefined) return create();
  if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200) throw new Error('Invalid request ID.');
  const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const key = `ui-create:${scope}:${hash(requestId)}`, digest = hash(input);
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT body FROM docs WHERE key=?').get(key) as { body: string } | undefined;
    if (row) {
      const prior = JSON.parse(row.body) as { digest: string; result: T };
      if (prior.digest !== digest) throw new Error('Request ID already used with different input.');
      db.exec('COMMIT');
      return prior.result;
    }
    const result = create();
    db.prepare('INSERT INTO docs(key,body,updated_at) VALUES(?,?,?)').run(key, JSON.stringify({ digest, result }), new Date().toISOString());
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
