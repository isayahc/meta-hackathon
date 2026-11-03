import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readOiLinks } from './lib/oi-links.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'task-floorplan.js');
const CABIN_FIXTURE = join(HERE, 'samples', 'floorplan-cabin-observations.json');
const UNSCALED_FIXTURE = join(HERE, 'samples', 'floorplan-unscaled-observations.json');

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], timeoutMs = 60000, extra: { nodeArgs?: string[]; env?: Record<string, string> } = {}): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [...(extra.nodeArgs ?? []), CLI, ...args],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...(extra.env ?? {}) } },
      (err, stdout, stderr) => {
        resolve({ code: (err as { code?: number } | null)?.code ?? 0, stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });
}

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'floorplan-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('task-floorplan CLI', () => {
  it('prints the model prompt offline', async () => {
    const r = await runCli(['--print-prompt']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /"site"/);
    assert.match(r.stdout, /normalized \[0,1\]/);
  });

  it('requires --root', async () => {
    const r = await runCli(['x.png']);
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /--root/);
  });

  it('benchmarks fixtures against mock OI with split metrics', async () => {
    await withRoot(async (root) => {
      const r = await runCli(['--benchmark', '--mock-oi', '--root', root]);
      assert.equal(r.code, 0, r.stderr);
      const report = JSON.parse(r.stdout) as {
        ok: boolean; mock: boolean; fixtures: Array<{ fixture: string; understanding: Record<string, unknown>; integration: Record<string, { valid?: boolean }>; evidence: string }>;
      };
      assert.equal(report.ok, true);
      assert.equal(report.mock, true);
      assert.equal(report.fixtures.length, 2);
      const cabin = report.fixtures.find((f) => f.fixture.includes('cabin'));
      assert.ok(cabin);
      assert.deepEqual(cabin.understanding, { rooms: 2, walls: 5, openings: 1, equipment: 1, unresolved: 1, nullGeometry: 0, scaled: true });
      assert.equal(cabin.integration.validate?.valid, true);
      assert.ok(cabin.integration.compile);
      assert.ok(cabin.integration.commit);
      const unscaled = report.fixtures.find((f) => f.fixture.includes('unscaled'));
      assert.ok(unscaled);
      assert.equal((unscaled.understanding as { scaled: boolean }).scaled, false);
      for (const f of report.fixtures) {
        const st = await stat(join(f.evidence, 'space-ir.json'));
        assert.ok(st.isFile());
      }
    });
  });

  it('replays observations without a model call and links the spot', async () => {
    await withRoot(async (root) => {
      const r = await runCli(['--observations', CABIN_FIXTURE, '--mock-oi', '--root', root, '--spot', 'cabin', '--scene-name', 'cabin-test']);
      assert.equal(r.code, 0, r.stderr);
      const out = JSON.parse(r.stdout) as { ok: boolean; mock: boolean; scene_id: string; revision: number; name: string; revision_url: string; evidence: string; linked: unknown };
      assert.equal(out.ok, true);
      assert.equal(out.mock, true);
      assert.equal(out.revision, 1);
      assert.equal(out.name, 'cabin-test');
      assert.match(out.revision_url, new RegExp(`sceneId=${out.scene_id}`));
      const st = await stat(join(out.evidence, 'space-ir.json'));
      assert.ok(st.isFile());
      const obsRaw = await readFile(join(out.evidence, 'observations.json'), 'utf8');
      const obs = JSON.parse(obsRaw) as { rooms: unknown[]; site: unknown };
      assert.ok(Array.isArray(obs.rooms) && obs.rooms.length > 0);
      const links = await readOiLinks(root, 'spot', 'cabin');
      const roles = links.map((l) => l.role).sort();
      assert.ok(roles.includes('space'));
      assert.ok(roles.includes('region'));
      assert.ok(roles.includes('boundary'));
      assert.ok(roles.includes('occupancy'));
      assert.ok(links.every((l) => l.scene_id === out.scene_id && l.revision === 1));
    });
  });

  it('replays deterministically: same observations, same SpaceIR', async () => {
    await withRoot(async (root) => {
      const a = await runCli(['--observations', CABIN_FIXTURE, '--mock-oi', '--root', root]);
      const b = await runCli(['--observations', CABIN_FIXTURE, '--mock-oi', '--root', root]);
      assert.equal(a.code, 0, a.stderr);
      assert.equal(b.code, 0, b.stderr);
      const norm = (raw: string): string => {
        const doc = JSON.parse(raw) as { evidence: Array<{ captured_at?: string }> };
        for (const ev of doc.evidence) {
          assert.ok(ev.captured_at);
          ev.captured_at = '<ts>';
        }
        return JSON.stringify(doc);
      };
      const docA = await readFile(join((JSON.parse(a.stdout) as { evidence: string }).evidence, 'space-ir.json'), 'utf8');
      const docB = await readFile(join((JSON.parse(b.stdout) as { evidence: string }).evidence, 'space-ir.json'), 'utf8');
      assert.equal(norm(docA), norm(docB));
    });
  });

  it('fails actionable on malformed observations', async () => {
    await withRoot(async (root) => {
      const bad = join(root, 'bad.json');
      await writeFile(bad, JSON.stringify({ site: { width_m: 8, depth_m: 6, height_m: 2.7 }, rooms: [], walls: [{ regions: ['ghost'], path: null }], openings: [], equipment: [], unresolved: [] }));
      const r = await runCli(['--observations', bad, '--mock-oi', '--root', root]);
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /OBS_UNRESOLVED_REFERENCE/);
    });
  });

  it('completes the model flow against a stubbed fetch', async () => {
    await withRoot(async (root) => {
      const obs = await readFile(CABIN_FIXTURE, 'utf8');
      const stub = join(root, 'stub-fetch.mjs');
      await writeFile(
        stub,
        `globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: ${JSON.stringify(obs)} }, finish_reason: 'stop' }], usage: { completion_tokens: 10 } }) });`
      );
      const img = join(root, 'plan.jpg');
      await writeFile(img, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      const r = await runCli([img, '--root', root, '--mock-oi', '--scene-name', 'stubbed'], 60000, {
        nodeArgs: ['--import', pathToFileURL(stub).href],
        env: { META_API_KEY: 'test-key-floorplan-flow' },
      });
      assert.equal(r.code, 0, r.stderr);
      const out = JSON.parse(r.stdout) as { ok: boolean; mock: boolean; scene_id: string; revision: number; name: string };
      assert.equal(out.ok, true);
      assert.equal(out.mock, true);
      assert.equal(out.revision, 1);
      assert.equal(out.name, 'stubbed');
      assert.match(out.scene_id, /^[0-9a-f-]{36}$/);
    });
  });

  it('reports network cause chains from the model request', async () => {
    await withRoot(async (root) => {
      const stub = join(root, 'stub-fetch.mjs');
      await writeFile(
        stub,
        `globalThis.fetch = async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:9' }; throw e; };`
      );
      const img = join(root, 'plan.jpg');
      await writeFile(img, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      const r = await runCli([img, '--root', root, '--mock-oi'], 60000, {
        nodeArgs: ['--import', pathToFileURL(stub).href],
        env: { META_API_KEY: 'test-key-floorplan-offline' },
      });
      assert.equal(r.code, 1);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /API unreachable: fetch failed/);
      assert.match(r.stderr, /ECONNREFUSED/);
      assert.match(r.stderr, /127\.0\.0\.1:9/);
    });
  });

  it('keeps HTTP failures distinct from transport failures', async () => {
    await withRoot(async (root) => {
      const stub = join(root, 'stub-fetch.mjs');
      await writeFile(stub, `globalThis.fetch = async () => ({ ok: false, status: 503, text: async () => 'overloaded' });`);
      const img = join(root, 'plan.jpg');
      await writeFile(img, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      const r = await runCli([img, '--root', root, '--mock-oi'], 60000, {
        nodeArgs: ['--import', pathToFileURL(stub).href],
        env: { META_API_KEY: 'test-key-floorplan-http' },
      });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /API error 503: overloaded/);
      assert.doesNotMatch(r.stderr, /API unreachable/);
    });
  });

  it('reports unknown height as missing info and saves failure evidence', async () => {
    await withRoot(async (root) => {
      const obsPath = join(root, 'no-height.json');
      const obs = JSON.parse(await readFile(CABIN_FIXTURE, 'utf8')) as { site: Record<string, unknown> };
      obs.site.height_m = null;
      await writeFile(obsPath, JSON.stringify(obs));
      const r = await runCli(['--observations', obsPath, '--mock-oi', '--root', root]);
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /OBS_MISSING_HEIGHT/);
      assert.match(r.stderr, /assume-height/);
      assert.match(r.stderr, /\(model output shape; evidence: .*failed-/);
      const failed = (await readdir(join(root, 'oi-evidence'))).find((d) => d.startsWith('failed-'));
      assert.ok(failed, 'expected a failed-* evidence dir');
      const saved = JSON.parse(await readFile(join(root, 'oi-evidence', failed, 'observations.json'), 'utf8')) as { site: { height_m: unknown } };
      assert.equal(saved.site.height_m, null);
      const errDoc = JSON.parse(await readFile(join(root, 'oi-evidence', failed, 'error.json'), 'utf8')) as { code: string };
      assert.equal(errDoc.code, 'OBS_MISSING_HEIGHT');
    });
  });

  it('rejects string heights as malformed and saves failure evidence', async () => {
    await withRoot(async (root) => {
      const obsPath = join(root, 'str-height.json');
      const obs = JSON.parse(await readFile(CABIN_FIXTURE, 'utf8')) as { site: Record<string, unknown> };
      obs.site.height_m = 'tall';
      await writeFile(obsPath, JSON.stringify(obs));
      const r = await runCli(['--observations', obsPath, '--mock-oi', '--root', root]);
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /OBS_BAD_SHAPE/);
      assert.match(r.stderr, /string "tall"/);
      const failed = (await readdir(join(root, 'oi-evidence'))).find((d) => d.startsWith('failed-'));
      assert.ok(failed, 'expected a failed-* evidence dir');
      const errDoc = JSON.parse(await readFile(join(root, 'oi-evidence', failed, 'error.json'), 'utf8')) as { code: string; message: string };
      assert.equal(errDoc.code, 'OBS_BAD_SHAPE');
      assert.match(errDoc.message, /string "tall"/);
    });
  });

  it('builds with an explicit height assumption and records it', async () => {
    await withRoot(async (root) => {
      const obsPath = join(root, 'no-height.json');
      const obs = JSON.parse(await readFile(CABIN_FIXTURE, 'utf8')) as { site: Record<string, unknown> };
      obs.site.height_m = null;
      await writeFile(obsPath, JSON.stringify(obs));
      const r = await runCli(['--observations', obsPath, '--mock-oi', '--assume-height', '2.7', '--root', root, '--scene-name', 'assumed']);
      assert.equal(r.code, 0, r.stderr);
      const out = JSON.parse(r.stdout) as { ok: boolean; evidence: string; scene_id: string };
      assert.equal(out.ok, true);
      assert.match(r.stderr, /Assuming site height 2.7 m/);
      const runFile = (await readdir(out.evidence)).find((f) => f.startsWith('run-'));
      assert.ok(runFile, 'expected a run-*.json evidence file');
      const run = JSON.parse(await readFile(join(out.evidence, runFile), 'utf8')) as { heightAssumptionM: unknown };
      assert.equal(run.heightAssumptionM, 2.7);
    });
  });

  it('rejects a non-numeric assumed height at the CLI', async () => {
    await withRoot(async (root) => {
      const r = await runCli(['--observations', CABIN_FIXTURE, '--mock-oi', '--assume-height', 'banana', '--root', root]);
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /ARGS/);
      assert.match(r.stderr, /assume-height/);
    });
  });

  it('preserves model bytes through parse and evidence', async () => {
    await withRoot(async (root) => {
      const nested = JSON.parse(await readFile(CABIN_FIXTURE, 'utf8')) as { walls: Array<Record<string, unknown>> };
      nested.walls[0].path = [[[0, 0], [1, 1]]];
      const stub = join(root, 'stub-fetch.mjs');
      await writeFile(
        stub,
        `globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: ${JSON.stringify(JSON.stringify(nested))} }, finish_reason: 'stop' }], usage: {} }) });`
      );
      const img = join(root, 'plan.jpg');
      await writeFile(img, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      const r = await runCli([img, '--root', root, '--mock-oi'], 60000, {
        nodeArgs: ['--import', pathToFileURL(stub).href],
        env: { META_API_KEY: 'test-key-bytes' },
      });
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /OBS_BAD_SHAPE/);
      const failed = (await readdir(join(root, 'oi-evidence'))).find((d) => d.startsWith('failed-'));
      assert.ok(failed, 'expected a failed-* evidence dir');
      const saved = JSON.parse(await readFile(join(root, 'oi-evidence', failed, 'observations.json'), 'utf8'));
      assert.deepEqual(saved, nested);
    });
  });

  it('fails fast with guidance when scale is unknown', async () => {
    await withRoot(async (root) => {
      const r = await runCli(['--observations', UNSCALED_FIXTURE, '--mock-oi', '--root', root]);
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /OBS_MISSING_SIZE/);
      assert.match(r.stderr, /assume-size/);
    });
  });

  it('still requires height after a footprint assumption', async () => {
    await withRoot(async (root) => {
      const r = await runCli(['--observations', UNSCALED_FIXTURE, '--mock-oi', '--assume-size', '12x9', '--root', root]);
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /OBS_MISSING_HEIGHT/);
    });
  });

  it('builds an unscaled plan with size and height assumptions', async () => {
    await withRoot(async (root) => {
      const r = await runCli(
        ['--observations', UNSCALED_FIXTURE, '--mock-oi', '--assume-size', '12x9', '--assume-height', '2.7', '--root', root, '--scene-name', 'assumed-size'],
        60000
      );
      assert.equal(r.code, 0, r.stderr);
      const out = JSON.parse(r.stdout) as { ok: boolean; evidence: string };
      assert.equal(out.ok, true);
      assert.match(r.stderr, /Assuming site footprint 12x9 m/);
      const spaceIr = JSON.parse(await readFile(join(out.evidence, 'space-ir.json'), 'utf8')) as { site: unknown; unresolved: string[] };
      assert.deepEqual(spaceIr.site, { frame_id: 'world', width_m: 12, depth_m: 9, height_m: 2.7 });
      assert.ok(spaceIr.unresolved.some((u) => /User-assumed footprint 12x9 m/.test(u)));
      const runFile = (await readdir(out.evidence)).find((f) => f.startsWith('run-'));
      assert.ok(runFile, 'expected a run-*.json evidence file');
      const run = JSON.parse(await readFile(join(out.evidence, runFile), 'utf8')) as { sizeAssumptionM: unknown; heightAssumptionM: unknown };
      assert.deepEqual(run.sizeAssumptionM, { width_m: 12, depth_m: 9 });
      assert.equal(run.heightAssumptionM, 2.7);
    });
  });

  it('rejects a malformed footprint assumption at the CLI', async () => {
    await withRoot(async (root) => {
      const r = await runCli(['--observations', UNSCALED_FIXTURE, '--mock-oi', '--assume-size', 'big', '--root', root]);
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /ARGS/);
      assert.match(r.stderr, /assume-size/);
    });
  });
});
