import { hashAsset, putAsset } from './lib/assets.js';
/** Workflow commands/capture: JSON stdout, diagnostics stderr, no dashboard required. */
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { flagValue } from './lib/args.js';
import { captureJourney, journeyCommand } from './lib/journey.js';
const args = process.argv.slice(2), execute = promisify(execFile);
try {
  const directory = flagValue(args, '--root', null); if (!directory) throw new Error('Pass --root <project>.');
  const root = resolve(directory), file = flagValue(args,'--command',null);
  const command = file ? JSON.parse(await readFile(file,'utf8')) : { command:args[0] ?? 'view' };
  let result: unknown;
  if (command.command === 'capture') {
    let media: string | undefined;
    if (command.path) {
      const path = resolve(command.path), extension = extname(path).toLowerCase();
      if (!['.mp4','.webm','.mov'].includes(extension)) throw new Error('Use mp4, webm or mov footage.');
      media = `work-${(await hashAsset(path)).sha256}${extension}`;
      await putAsset(root,path,media);
    }
    result = await captureJourney(root,{...command,media},async(name,argv)=> {
      const { stdout } = await execute(process.execPath,[fileURLToPath(new URL(name,import.meta.url)),...argv],{maxBuffer:16*1024*1024}); return JSON.parse(stdout);
    });
  } else result = (await journeyCommand(root,command));
  console.log(JSON.stringify(result,null,2));
} catch(error) { console.error(`JOURNEY_FAILED: ${(error as Error).message}`); process.exitCode=1; }

