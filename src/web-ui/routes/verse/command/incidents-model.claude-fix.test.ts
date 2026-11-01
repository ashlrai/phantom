import { expect, it } from 'vitest';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { CLAUDE_LANE_FIX_COMMAND } from '../shell/claude-lane-needs-you.js';
import { incidents } from './incidents-model.js';

it('shows the same Claude fix command as Needs-you', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  const runs: FleetRuns = {
    v: 1, generatedAt: new Date(now).toISOString(), sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
    lastTick: null, paused: false, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: 'down token rejected', lanes: [], workers: [], leaders: [], orchestratorAgents: null,
    publishesLastHour: [], mergesLastHour: { count: 0, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
  };
  expect(incidents(runs, now).find(item => item.id === 'claude-lane')?.fix).toBe(CLAUDE_LANE_FIX_COMMAND);
});
