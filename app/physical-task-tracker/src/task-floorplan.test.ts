import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOiLinks } from './lib/oi-links.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'task-floorplan.js');
const CABIN_FIXTURE = join(HERE, 'samples', 'floorplan-cabin-observations.json');

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], timeoutMs = 60000): Promise<Run> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: (err as { code?: number } | null)?.code ?? 0, stdout: String(stdout), stderr: String(stderr) });
    });
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
      await writeFile(bad, JSON.stringify({ site: null, rooms: [], walls: [{ regions: ['ghost'], path: null }], openings: [], equipment: [], unresolved: [] }));
      const r = await runCli(['--observations', bad, '--mock-oi', '--root', root]);
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /OBS_UNRESOLVED_REFERENCE/);
    });
  });
});
