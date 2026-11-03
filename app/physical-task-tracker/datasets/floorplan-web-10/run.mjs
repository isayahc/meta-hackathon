// Dataset runner: every manifest image through the live floorplan flow.
// Usage: node run.mjs [--limit N]
// Env: META_API_KEY (model), OI_ROOT (live OI), MAX_TOKENS, REASONING_EFFORT.
// Layout per id: runs/<id>/attempt-<n>.{stdout,stderr}, oi-evidence/, oi-scenes/.
import { spawn } from 'node:child_process';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, '../../dist/task-floorplan.js');
const manifest = JSON.parse(await readFile(join(HERE, 'manifest.json'), 'utf8'));
const SIZE = `${manifest.assumedSizeM.width_m}x${manifest.assumedSizeM.depth_m}`;
const HEIGHT = String(manifest.assumedHeightM);
const MAX_ATTEMPTS = 2;
const ATTEMPT_TIMEOUT_MS = 600_000;

const limitArg = process.argv.indexOf('--limit');
const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : Infinity;

function runOnce(image, rootDir, scene) {
  return new Promise((result) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [CLI, image, '--root', rootDir, '--scene-name', scene, '--assume-size', SIZE, '--assume-height', HEIGHT], { cwd: resolve(HERE, '../..') });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, ATTEMPT_TIMEOUT_MS);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      result({ code: timedOut ? 'TIMEOUT' : code, stdout, stderr, ms: Date.now() - t0 });
    });
  });
}

function parseUsage(stderr) {
  const m = stderr.match(/(?:model )?usage: (\{.*\})/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function errorCode(stdout, stderr) {
  const m = stderr.match(/ERROR \[([A-Z0-9_]+)\]/) || stdout.match(/ERROR \[([A-Z0-9_]+)\]/);
  return m ? m[1] : 'UNKNOWN';
}

async function evidenceMeta(rootDir) {
  // Best-effort: model + prompt version + observations path from the run dir.
  try {
    const ev = join(rootDir, 'oi-evidence');
    for (const d of await readdir(ev)) {
      const runFiles = (await readdir(join(ev, d))).filter((f) => f.startsWith('run-'));
      if (runFiles.length) {
        const run = JSON.parse(await readFile(join(ev, d, runFiles[0]), 'utf8'));
        return { model: run.model ?? null, promptVersion: run.promptVersion ?? null, observations: `oi-evidence/${d}/observations.json` };
      }
      return { model: null, promptVersion: null, observations: `oi-evidence/${d}/observations.json` };
    }
  } catch { /* no evidence dir */ }
  return { model: null, promptVersion: null, observations: null };
}

const results = [];
let n = 0;
for (const entry of manifest.entries) {
  if (++n > limit) break;
  const rootDir = join(HERE, 'runs', entry.id);
  await mkdir(rootDir, { recursive: true });
  const image = join(HERE, entry.file);
  const scene = `ds10-${entry.id}`;
  let attempt = 0;
  let final = null;
  let usage = null;
  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;
    console.log(`[${entry.id}] attempt ${attempt}/${MAX_ATTEMPTS} ...`);
    const r = await runOnce(image, rootDir, scene);
    await writeFile(join(rootDir, `attempt-${attempt}.stdout`), r.stdout || '(empty)\n');
    await writeFile(join(rootDir, `attempt-${attempt}.stderr`), r.stderr || '(empty)\n');
    usage = parseUsage(r.stderr) ?? usage;
    if (r.code === 0) { final = { ok: true, ...r }; break; }
    final = { ok: false, ...r };
    if (/truncat/i.test(r.stderr)) { console.log(`[${entry.id}] truncated output; not retrying.`); break; }
  }
  let parsed = null;
  try { parsed = JSON.parse(final.stdout); } catch { /* non-JSON stdout on failure */ }
  const meta = await evidenceMeta(rootDir);
  results.push({
    id: entry.id,
    ok: final.ok,
    attempts: attempt,
    ms: final.ms,
    ...(final.ok
      ? { scene_id: parsed.scene_id, revision: parsed.revision, understanding: parsed.understanding, findings: (parsed.findings ?? []).length, diagnostics: (parsed.diagnostics ?? []).length }
      : { error: errorCode(final.stdout, final.stderr) }),
    usage,
    ...meta,
  });
  console.log(`[${entry.id}] ${final.ok ? 'OK' : `FAIL ${errorCode(final.stdout, final.stderr)}`} (${Math.round(final.ms / 1000)}s)`);
}

const totals = { ok: 0, failed: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
for (const r of results) {
  totals[r.ok ? 'ok' : 'failed'] += 1;
  for (const k of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    if (r.usage && Number.isFinite(r.usage[k])) totals[k] += r.usage[k];
  }
}
await writeFile(join(HERE, 'summary.json'), JSON.stringify({
  generated_at: new Date().toISOString(),
  assume_size: SIZE,
  assume_height_m: Number(HEIGHT),
  totals,
  results,
}, null, 2));
console.log(`Done: ${totals.ok} ok / ${totals.failed} failed. Tokens: ${totals.prompt_tokens} in / ${totals.completion_tokens} out.`);
