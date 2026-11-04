/** Headless evidence review CLI; JSON command file in, JSON result out. */
import { readFile } from 'node:fs/promises';
import { flagValue } from './lib/args.js';
import { reconciliationCommand } from './lib/reconciliation.js';
const args = process.argv.slice(2);
try {
  const root = flagValue(args, '--root', null); if (!root) throw new Error('Pass --root <project>.');
  const file = flagValue(args, '--command', null);
  console.log(JSON.stringify(await reconciliationCommand(root, file ? JSON.parse(await readFile(file, 'utf8')) : { command: args[0] ?? 'view' }), null, 2));
} catch (error) { console.error(`RECONCILIATION_FAILED: ${(error as Error).message}`); process.exitCode = 1; }

