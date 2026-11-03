// Farmer process CLI: build an inspectable process from a scan event,
// show revisions, and record farmer corrections as new revisions.
//   node task-process.js build --root <dir> --event <scanEventId> [--id <pid>] [--title T]
//   node task-process.js show --root <dir> --id <pid> [--rev N]
//   node task-process.js list --root <dir>
//   node task-process.js correct --root <dir> --id <pid> --set '<json|@file>' --rationale "..." [--author farmer]
//
// stdout is pure JSON; notes go to stderr.
import { readFile } from 'node:fs/promises';
import { flagValue } from './lib/args.js';
import { getStoredEvent } from './lib/events.js';
import {
  applyCorrection,
  buildProcessFromScan,
  listProcesses,
  ProcessError,
  readProcess,
  saveRevision,
} from './lib/processes.js';

function fail(message: string, code = 'PROCESS_FAILED'): never {
  console.error(`ERROR [${code}]: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const [command] = args;
const root = flagValue(args, '--root', null);
if (!root) fail('Pass --root <project dir>.', 'ARGS');

async function readPatch(raw: string): Promise<unknown> {
  const text = raw.startsWith('@') ? await readFile(raw.slice(1), 'utf8') : raw;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail(`--set is not valid JSON${raw.startsWith('@') ? ` (file ${raw.slice(1)})` : ''}.`, 'ARGS');
  }
}

function emit(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

try {
  if (command === 'build') {
    const eventId = flagValue(args, '--event', null);
    if (!eventId) fail('build needs --event <scanEventId>.', 'ARGS');
    const event = await getStoredEvent(root as string, eventId as string);
    if (!event) fail(`No event "${eventId}".`, 'ARGS');
    if (!event.payload) fail(`Event "${eventId}" has no scan payload.`, 'PROC_NO_PAYLOAD');
    let analysis: Record<string, unknown>;
    try {
      analysis = JSON.parse(event.payload) as Record<string, unknown>;
    } catch {
      fail(`Event "${eventId}" payload is not JSON.`, 'PROC_NO_PAYLOAD');
    }
    const doc = buildProcessFromScan({
      id: flagValue(args, '--id', null) ?? undefined,
      title: flagValue(args, '--title', null) ?? undefined,
      analysis: analysis as { suggested_next_steps?: unknown },
      media: event.media,
      eventId: event.id,
      recordedAt: typeof analysis.recorded_at === 'string' ? analysis.recorded_at : null,
      duration_s: typeof analysis.video_duration_s === 'number' ? analysis.video_duration_s : null,
    });
    const saved = await saveRevision(root as string, doc);
    emit({ ok: true, id: saved.id, rev: saved.rev, title: saved.title, steps: saved.steps.length, gaps: saved.gaps });
  } else if (command === 'show') {
    const id = flagValue(args, '--id', null);
    if (!id) fail('show needs --id <processId>.', 'ARGS');
    const revRaw = flagValue(args, '--rev', null);
    const rev = revRaw === null ? null : Number(revRaw);
    if (rev !== null && (!Number.isInteger(rev) || rev < 1)) fail(`--rev must be a positive integer (got "${revRaw}").`, 'ARGS');
    emit({ ok: true, process: await readProcess(root as string, id as string, rev) });
  } else if (command === 'list') {
    emit({ ok: true, processes: await listProcesses(root as string) });
  } else if (command === 'correct') {
    const id = flagValue(args, '--id', null);
    const setRaw = flagValue(args, '--set', null);
    const rationale = flagValue(args, '--rationale', null);
    if (!id) fail('correct needs --id <processId>.', 'ARGS');
    if (setRaw === null) fail('correct needs --set <json|@file>.', 'ARGS');
    if (rationale === null) fail('correct needs --rationale "...".', 'ARGS');
    const author = flagValue(args, '--author', 'farmer') as string;
    const { doc, staleDocs } = await applyCorrection(root as string, id as string, (await readPatch(setRaw as string)) as never, rationale as string, author);
    emit({ ok: true, id: doc.id, rev: doc.rev, staleDocs, corrections: doc.corrections });
  } else {
    fail(`Unknown command "${command ?? ''}": want build, show, list, or correct.`, 'ARGS');
  }
} catch (e) {
  if (e instanceof ProcessError) fail(e.message, e.code);
  throw e;
}
