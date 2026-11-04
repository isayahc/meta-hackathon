/** Human planning command CLI. Use a JSON file to avoid shell quoting of patches. */
import { readFile } from 'node:fs/promises';
import { flagValue } from './lib/args.js';
import { planningCommand } from './lib/task-planning.js';
const args = process.argv.slice(2);
try {
  const root = flagValue(args, '--root', null); if (!root) throw new Error('Pass --root <project>.');
  const file = flagValue(args, '--command', null);
  const command = file ? JSON.parse(await readFile(file, 'utf8')) : { command: args[0] ?? 'view' };
  console.log(JSON.stringify(await planningCommand(root, command), null, 2));
} catch (e) { console.error(`PLANNING_FAILED: ${(e as Error).message}`); process.exitCode = 1; }

