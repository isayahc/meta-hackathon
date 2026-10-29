// task-scan-video stdout contract: the server JSON.parses the script's
// stdout, so stdout must be pure analysis JSON (notes go to stderr).
// Runs the built CLI against a stubbed fetch: no network, no ffmpeg
// (frames directory input), no API key (explicit dummy env wins over .env).
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  assert.deepEqual(JSON.parse(stdout), ANALYSIS);
  assert.match(stderr, /\(via frames:/);
});
