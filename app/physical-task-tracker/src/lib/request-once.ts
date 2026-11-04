import { createHash } from 'node:crypto';
import type { RecordTransaction } from './record-model.js';

/** Commit a creation and its retry receipt atomically in the canonical project database. */
export function requestOnce<T>(db: RecordTransaction, scope: string, requestId: unknown, input: unknown, create: () => T): T {
  if (requestId === undefined) return create();
  if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200) throw new Error('Invalid request ID.');
  const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const key = `ui-create:${scope}:${hash(requestId)}`, digest = hash(input);
  
  try {
    const row = db.first('docs', { where: { key: key }, fields: ["body"] }) as { body: string } | undefined;
    if (row) {
      const prior = JSON.parse(row.body) as { digest: string; result: T };
      if (prior.digest !== digest) throw new Error('Request ID already used with different input.');
      
      return prior.result;
    }
    const result = create();
    db.insert('docs', { key: key, body: JSON.stringify({ digest, result }), updated_at: new Date().toISOString() });
    
    return result;
  } catch (error) {
    
    throw error;
  }
}

