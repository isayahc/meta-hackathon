import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linkOiEntities, readOiLinks, unlinkOiEntity } from './oi-links.js';

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'oi-links-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const LINK = { scene_id: '11111111-1111-4111-8111-111111111111', revision: 1, oi_entity_id: 'room-living', oi_revision: 'r1', role: 'region' };

describe('oi-links', () => {
  it('links a spot to OI entities and recovers them on reopen', async () => {
    await withRoot(async (root) => {
      const saved = await linkOiEntities(root, 'spot', 'north-fence', [
        LINK,
        { scene_id: LINK.scene_id, revision: 1, oi_entity_id: 'scene', oi_revision: 'r1', role: 'space' },
      ]);
      assert.equal(saved.length, 2);
      const read = await readOiLinks(root, 'spot', 'north-fence');
      assert.deepEqual(
        read.map((l) => [l.entity_kind, l.entity_id, l.oi_entity_id, l.role]),
        [
          ['spot', 'north-fence', 'room-living', 'region'],
          ['spot', 'north-fence', 'scene', 'space'],
        ]
      );
      assert.equal(read[0]?.scene_id, LINK.scene_id);
    });
  });

  it('upserts a link when the scene revision advances', async () => {
    await withRoot(async (root) => {
      await linkOiEntities(root, 'goal', 'g1', [LINK]);
      await linkOiEntities(root, 'goal', 'g1', [{ ...LINK, revision: 3 }]);
      const read = await readOiLinks(root, 'goal', 'g1');
      assert.equal(read.length, 1);
      assert.equal(read[0]?.revision, 3);
    });
  });

  it('keeps spot and goal links separate', async () => {
    await withRoot(async (root) => {
      await linkOiEntities(root, 'spot', 's1', [LINK]);
      assert.deepEqual(await readOiLinks(root, 'goal', 's1'), []);
    });
  });

  it('unlinks one entity without touching the rest', async () => {
    await withRoot(async (root) => {
      await linkOiEntities(root, 'spot', 's1', [LINK, { ...LINK, oi_entity_id: 'scene' }]);
      assert.equal(await unlinkOiEntity(root, 'spot', 's1', 'scene'), true);
      assert.equal(await unlinkOiEntity(root, 'spot', 's1', 'scene'), false);
      const read = await readOiLinks(root, 'spot', 's1');
      assert.deepEqual(read.map((l) => l.oi_entity_id), ['room-living']);
    });
  });

  it('rejects bad kinds and empty references', async () => {
    await withRoot(async (root) => {
      await assert.rejects(async () => (await linkOiEntities(root, 'event' as never, 'e1', [LINK])), /Bad OI link kind/);
      await assert.rejects(async () => (await linkOiEntities(root, 'spot', 's1', [{ ...LINK, scene_id: '' }])), /scene_id/);
      await assert.rejects(async () => (await linkOiEntities(root, 'spot', 's1', [{ ...LINK, revision: 0 }])), /revision/);
    });
  });
});

