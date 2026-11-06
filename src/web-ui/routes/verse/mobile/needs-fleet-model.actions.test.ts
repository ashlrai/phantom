import { describe, expect, it } from 'vitest';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { attentionAction, fleetAttention } from './needs-fleet-model.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const snapshot: FleetRuns = {
  v: 1, generatedAt: new Date(now).toISOString(),
  sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: new Date(now).toISOString(), paused: false, memFreePct: 50, diskFreeGb: 80,
  claudeLane: 'down token rejected', switches: [],
  lanes: [{ lane: 'example', running: 0, target: 1, queued: 2, held: true, heldReason: 'operator hold', tokensLastHour: null, merged24h: null, mergeRate24h: null }],
  workers: [], leaders: [{ label: 'leader', ageSeconds: 30 }], orchestratorAgents: 1,
  publishesLastHour: [], mergesLastHour: { count: 1, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};

describe('attentionAction', () => {
  it.each([
    ['fleet-lanes', 'runs', 'Open runs'],
    ['fleet-supply', 'fleet', 'Open fleet'],
    ['fleet-host', 'fleet', 'Open fleet'],
    ['leader-journal', 'leader', 'Open leader'],
  ])('maps %s to its mobile screen', (paneId, screen, label) => {
    expect(attentionAction({ kind: 'pane', paneId })).toEqual({ kind: 'screen', screen, label });
  });
  it('maps a terminal command and ignores unknown or malformed targets', () => {
    expect(attentionAction({ kind: 'terminal', command: 'example-command' })).toEqual({ kind: 'copy', command: 'example-command', label: 'Copy command' });
    expect(attentionAction({ kind: 'pane', paneId: 'unknown' })).toBeUndefined();
    expect(attentionAction({ kind: 'terminal', command: null })).toBeUndefined();
    expect(attentionAction(null)).toBeUndefined();
  });
  it('keeps actions on fleet cards', () => {
    const cards = fleetAttention(snapshot, now);
    expect(cards.find((card) => card.id === 'claude-lane-down')?.action).toEqual({
      kind: 'copy', command: '~/.ashlr-runs/bin/fix-claude-lane.sh', label: 'Copy command',
    });
    expect(cards.find((card) => card.id === 'lane-held:example')?.action).toEqual({ kind: 'screen', screen: 'runs', label: 'Open runs' });
  });
});
