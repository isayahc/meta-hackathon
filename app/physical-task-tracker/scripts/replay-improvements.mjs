/** Seed a new synthetic project and run the real optimizer's offline improvement path. */
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { dbExists } from '../dist/lib/db.js';
import { applyCorrection, buildProcessFromScan, saveRevision } from '../dist/lib/processes.js';

const target = process.argv[2];
if (!target) throw new Error('Usage: node scripts/replay-improvements.mjs <new-project-directory> (run npm run build first)');
const root = resolve(target);
if (dbExists(root)) throw new Error('Replay requires a new project directory; existing projects are not overwritten.');
const fixture = JSON.parse(await readFile(new URL('../dist/samples/workflow-improvements.json', import.meta.url), 'utf8'));
const processDoc = buildProcessFromScan(fixture.scan);
await saveRevision(root, processDoc);
await applyCorrection(root, processDoc.id, {
  steps: Object.fromEntries(processDoc.steps.map((step) => [step.id, { requires_unknown: false }])),
}, 'Synthetic farmer review: no prerequisites for these steps.');
const work = await mkdtemp(join(tmpdir(), 'workflow-replay-'));
try {
  await writeFile(join(work, 'context.json'), JSON.stringify(fixture.context));
  await writeFile(join(work, 'candidates.json'), JSON.stringify(fixture.candidates));
  const { stdout } = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('../dist/task-optimize.js', import.meta.url)), root,
    '--workflow-context', join(work, 'context.json'), '--workflow-candidates', join(work, 'candidates.json'),
  ], { cwd: root });
  process.stdout.write(stdout);
} finally {
  await rm(work, { recursive: true, force: true });
}
