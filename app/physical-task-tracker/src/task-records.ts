/** Initialize/import live MongoDB project records; all stdout is JSON. */
import { resolve } from 'node:path';
import { activateMongo, inspectRecordImport } from './lib/record-activation.js';
import { TABLES } from './lib/record-model.js';

/** Execute the explicit offline storage command. */
async function main(): Promise<void> {
  const [command,rootArg,id,...flags] = process.argv.slice(2);
  if (!['inspect','init','import'].includes(command) || !rootArg || !id || flags.length !== 1 || flags[0] !== '--offline') throw new Error('Usage: task-records inspect|init|import PROJECT_ROOT PROJECT_ID --offline (stop all writers first)');
  const root = resolve(rootArg);
  if (command === 'inspect') {
    const rows = inspectRecordImport(root);
    console.log(JSON.stringify({project_id:id,counts:Object.fromEntries(TABLES.map(t=>[t,rows[t].length])),source_modified:false}));
  } else console.log(JSON.stringify({backend:'mongodb',...await activateMongo(root,id,command as 'init'|'import'),media_backend:'local'}));
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
