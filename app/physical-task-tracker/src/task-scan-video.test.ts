// task-scan-video stdout contract: the server JSON.parses the script's
// stdout, so stdout must be pure analysis JSON (notes go to stderr).
// Runs the built CLI against a stubbed fetch: no network, no ffmpeg
// (frames directory input), no API key (explicit dummy env wins over .env).
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('./task-scan-video.js', import.meta.url));

const ANALYSIS = {
  same_location: true,
  observed_task: 'handling and reassembling a small spray bottle',
  progression: 'open bottle sitting on floor -> spray dip tube inserted',
  per_frame: ['open bottle on floor', 'hands insert dip tube'],
  stage: 'reassembly',
  suggested_next_steps: ['Screw the cap back on', 'Test the sprayer'],
  confidence: 'high',
  unknowns: [],
};

const STUB = `globalThis.fetch = async () => ({ ok: true, json: async () => ({
  choices: [{ message: { content: ${JSON.stringify(JSON.stringify(ANALYSIS))} }, finish_reason: 'stop' }],
  usage: { completion_tokens: 10 },
}) });`;

test('video scan prints pure JSON to stdout, notes to stderr', async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), 'scan-video-stdout-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'frame-a.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  await writeFile(join(dir, 'frame-b.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const stub = join(dir, 'stub-fetch.mjs');
  await writeFile(stub, STUB);
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ['--import', pathToFileURL(stub).href, SCRIPT, dir, '--frames', '2'],
    { cwd: dir, env: { ...process.env, META_API_KEY: 'test-key-for-stdout-contract' } }
  );
  // Must survive a strict JSON.parse, exactly like serve-dashboard does.
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  assert.equal(parsed.observed_task, ANALYSIS.observed_task);
  assert.deepEqual(parsed.suggested_next_steps, ANALYSIS.suggested_next_steps);
  // Frames dir has no container tag: date falls back to file mtime.
  assert.equal(parsed.recorded_source, 'mtime');
  assert.equal(parsed.recorded_estimate, true);
  assert.ok(parsed.recorded_at && !Number.isNaN(Date.parse(String(parsed.recorded_at))));
  assert.match(stderr, /\(via frames:/);
  assert.match(stderr, /Estimated .* \(file date only; treat as an estimate\)\./);
});

function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('video file slices one gif per frame interval, stdout stays JSON', { skip: !hasFfmpeg() }, async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), 'scan-video-gifs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const clip = join(dir, 'clip.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=160x120:rate=10', '-pix_fmt', 'yuv420p', clip]);
  const stub = join(dir, 'stub-fetch.mjs');
  await writeFile(stub, STUB);
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    ['--import', pathToFileURL(stub).href, SCRIPT, clip, '--frames', '2', '--gifs', dir, '--gif-prefix', 't'],
    { cwd: dir, env: { ...process.env, META_API_KEY: 'test-key-for-gifs' } }
  );
  const gifs = (await readdir(dir)).filter((f) => f.endsWith('.gif')).sort();
  assert.deepEqual(gifs, ['t-0.gif', 't-1.gif']);
  // GIF chatter stays on stderr; stdout is still pure analysis JSON.
  assert.match(stderr, /Sliced 2 gifs/);
  assert.equal((JSON.parse(stdout) as Record<string, unknown>).observed_task, ANALYSIS.observed_task);
});
