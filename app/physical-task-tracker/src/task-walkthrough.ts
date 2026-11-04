/** Walkthrough capture, explicit replay, review, and evidence handoff CLI. */
import { readFile } from 'node:fs/promises';
import { flagValue, flagAll } from './lib/args.js';
import { captureWalkthrough, replayWalkthrough, readWalkthrough, reviewWalkthrough, listWalkthroughs, walkthroughHandoff } from './lib/walkthrough.js';
const args = process.argv.slice(2);
try {
  const root = flagValue(args, '--root', null); if (!root) throw new Error('Pass --root.');
  const id = flagValue(args, '--id', null);
  let result: unknown;
  if (args[0] === 'capture') result = await captureWalkthrough(root, { mode: args.includes('--live') ? 'live' : 'capture',
    images: flagAll(args, '--image'), video: flagValue(args, '--video', null) ?? undefined, max_frames: Number(flagValue(args, '--frames', '6')),
    prompts: flagAll(args, '--prompt').length ? flagAll(args, '--prompt') : undefined });
  else if (args[0] === 'replay') { const file = flagValue(args, '--manifest', null); if (!file) throw new Error('Pass --manifest.'); result = await replayWalkthrough(root, file); }
  else if (args[0] === 'list') result = listWalkthroughs(root);
  else if (id && args[0] === 'show') result = readWalkthrough(root, id);
  else if (id && args[0] === 'handoff') result = walkthroughHandoff(root, id);
  else if (id && args[0] === 'review') {
    const file = flagValue(args, '--patch', null); if (!file) throw new Error('Pass --patch <JSON file>.');
    result = reviewWalkthrough(root, id, Number(flagValue(args, '--revision', '0')), JSON.parse(await readFile(file, 'utf8')));
  } else throw new Error('Use capture, replay, list, show, review, or handoff.');
  console.log(JSON.stringify(result, null, 2));
} catch (error) { console.error(`WALKTHROUGH_FAILED: ${(error as Error).message}`); process.exitCode = 1; }
