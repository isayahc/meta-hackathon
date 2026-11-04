/** Lifecycle JSON command adapter; no server or inference key required. */
import { readFile } from 'node:fs/promises';
import { flagValue } from './lib/args.js';
import { lifecycleCommand } from './lib/lifecycle.js';
try {
  const args=process.argv.slice(2),root=flagValue(args,'--root',null),file=flagValue(args,'--command',null);
  if(!root)throw new Error('Pass --root <project>.');
  console.log(JSON.stringify(await lifecycleCommand(root,file?JSON.parse(await readFile(file,'utf8')):{command:args[0]??'view'}),null,2));
}catch(error){console.error(`LIFECYCLE_FAILED: ${(error as Error).message}`);process.exitCode=1;}
