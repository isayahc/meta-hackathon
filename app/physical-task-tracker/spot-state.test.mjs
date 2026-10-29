import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  spotDir,
  initSpot,
  readState,
  listSessions,
  appendSession,
} from './lib/spot-state.mjs';

async function freshRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), 'spot-test-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

const DIFF = {
  stage: 'mid-harvest',
  suggested_state_update: 'Row half-crated, crew moving east.',
  new_issues: ['soft ground near gate'],
  progress_delta: 'advanced',
};

describe('spot-state', () => {
  it('inits a spot with unobserved state', async (t) => {
    const root = await freshRoot(t);
    const { dir, meta, state } = await initSpot(root, 'north-fence', 'North fence');
    assert.equal(dir, spotDir(root, 'north-fence'));
    assert.equal(meta.id, 'north-fence');
    assert.equal(state.stage, 'unobserved');
    assert.deepEqual(state.session_ids, []);
    assert.deepEqual(await listSessions(root, 'north-fence'), []);
  });

  it('appends a session and folds it into state', async (t) => {
    const root = await freshRoot(t);
    await initSpot(root, 'bed-1');
    const { sessionId, state } = await appendSession(root, 'bed-1', DIFF, 's1');
    assert.equal(sessionId, 's1');
    assert.equal(state.stage, 'mid-harvest');
    assert.equal(state.summary, 'Row half-crated, crew moving east.');
    assert.deepEqual(state.open_issues, ['soft ground near gate']);
    assert.deepEqual(state.session_ids, ['s1']);
    const saved = JSON.parse(
      await readFile(join(spotDir(root, 'bed-1'), 'sessions', 's1', 'analysis.json'), 'utf8')
    );
    assert.equal(saved.progress_delta, 'advanced');
    assert.deepEqual(await readState(root, 'bed-1'), state);
  });

  it('auto-inits a missing spot on append', async (t) => {
    const root = await freshRoot(t);
    const { state } = await appendSession(root, 'new-spot', DIFF);
    assert.equal(state.session_ids.length, 1);
    assert.equal((await listSessions(root, 'new-spot')).length, 1);
  });

  it('keeps prior summary when the analysis lacks one', async (t) => {
    const root = await freshRoot(t);
    await initSpot(root, 'bed-2');
    await appendSession(root, 'bed-2', DIFF, 's1');
    const { state } = await appendSession(root, 'bed-2', { stage: 'done' }, 's2');
    assert.equal(state.stage, 'done');
    assert.equal(state.summary, 'Row half-crated, crew moving east.');
    assert.deepEqual(state.session_ids, ['s1', 's2']);
  });
});
