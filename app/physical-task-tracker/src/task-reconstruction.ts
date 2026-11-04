/** Headless reviewed reconstruction: explicit prepare → preview → commit, pure JSON stdout. */
import { readFile } from 'node:fs/promises';
import { flagValue } from './lib/args.js';
import { reconstructionCommand, prepareWalkthroughReconstruction } from './lib/reconstruction.js';
const args = process.argv.slice(2), action = args[0];
try {
  const input = flagValue(args, '--input', null);
  const payload = input ? JSON.parse(await readFile(input, 'utf8')) as Record<string, unknown> : {};
  let result: unknown;
  if (action === 'prepare-walkthrough') {
    const root = flagValue(args, '--root', null), id = flagValue(args, '--id', null);
    if (!root || !id || !input) throw new Error('Pass --root, --id, --revision and --input <plan.json>.');
    result = await prepareWalkthroughReconstruction(root, id, Number(flagValue(args, '--revision', '0')),
      payload as unknown as Parameters<typeof prepareWalkthroughReconstruction>[3]);
  } else if (action === 'capabilities' || action === 'preview' || action === 'commit' || action === 'inspect') {
    result = await reconstructionCommand(action, payload);
  } else throw new Error('Use capabilities, prepare-walkthrough, preview, commit or inspect. See doc/reconstruction-import.md.');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const e = error as Error & { code?: string; details?: unknown };
  console.log(JSON.stringify({ error: e.message, code: e.code ?? 'RECONSTRUCTION_FAILED', details: e.details ?? null })); process.exitCode = 1;
}
