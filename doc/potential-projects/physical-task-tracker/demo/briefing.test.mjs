import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildBriefingPrompt } from './analyze-response.mjs';

const SPOTS = [
  {
    id: 'north-fence',
    name: 'North fence',
    stage: 'mid-harvest',
    summary: 'Row half-crated, crew moving east.',
    open_issues: ['soft ground near gate'],
    session_count: 2,
    updated_at: '2026-10-27T20:00:00Z',
  },
  {
    id: 'barn',
    name: 'Barn',
    stage: 'unobserved',
    summary: '',
    open_issues: [],
    session_count: 0,
    updated_at: '2026-10-20T09:00:00Z',
  },
];

describe('buildBriefingPrompt', () => {
  it('renders every spot with stage, state, and issues', () => {
    const p = buildBriefingPrompt(SPOTS);
    assert.ok(p.includes('Spot "north-fence" (North fence)'));
    assert.ok(p.includes('stage: mid-harvest'));
    assert.ok(p.includes('Row half-crated, crew moving east.'));
    assert.ok(p.includes('soft ground near gate'));
    assert.ok(p.includes('sessions: 2'));
    assert.ok(p.includes('Spot "barn" (Barn)'));
    assert.ok(p.includes('none recorded'));
    assert.ok(!p.includes('goal_status'));
  });

  it('adds goal tracking only when goals are given', () => {
    const p = buildBriefingPrompt(SPOTS, ['clean September harvest']);
    assert.ok(p.includes('- clean September harvest'));
    assert.ok(p.includes('goal_status'));
    assert.ok(p.includes('on-track|at-risk|unknown'));
  });
});
