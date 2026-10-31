import { expect, it } from 'vitest';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { deriveFleetNeedsYou } from './fleet-needs-you.js';
import { deriveReleaseNeedsYou } from './release-needs-you.js';
import { normalizePaneId } from './dock-catalog.js';
const NOW = Date.parse('2026-10-31T12:00:00Z');

/** A healthy snapshot: dispatcher ticking, a lane working, sources green. */
function snapshot(over: Partial<FleetRuns> = {}): FleetRuns {
  return {
    v: 1,
    generatedAt: '2026-10-31T12:00:00Z',
    sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
    lastTick: '2026-10-31T11:59:00Z',
    paused: false,
    memFreePct: 50,
    diskFreeGb: 80,
    switches: [],
    claudeLane: null,
    lanes: [{ lane: 'codex-cmp', running: 1, target: 2, queued: 0, held: false, heldReason: null, tokensLastHour: 100, merged24h: 2, mergeRate24h: 50 }],
    workers: [{ job: 'job-one', repo: 'phantom', lane: 'codex-cmp', tier: 'frontier', ageSeconds: 120 }],
    leaders: [{ label: 'leader', ageSeconds: 30 }],
    orchestratorAgents: 1,
    publishesLastHour: [],
    mergesLastHour: { count: 1, items: [{ repo: 'phantom', number: 12, title: 'Fleet view' }] },
    events: [{ at: '2026-10-31T11:55:00Z', kind: 'worker-start', text: 'started job-one' }],
    codexPersonal: null,
    inbox: [],
    drop: null,
    ...over,
  };
}

it('assigns every fleet destination and keeps section fallbacks', () => {
  const variants = [
    snapshot({ claudeLane: 'down', switches: ['HOLD'], diskFreeGb: 2,
      lanes: [{ ...snapshot().lanes[0]!, lane: 'fake-lane', held: true }] }),
    snapshot({ workers: [], mergesLastHour: { count: 0, items: [] }, events: [] }),
    snapshot({ leaders: [] }),
    snapshot({ codexPersonal: { usedPct: 100, resetsAt: '2026-11-01T12:00:00Z', asOf: new Date(NOW).toISOString() } }),
    snapshot({ codexPersonal: { usedPct: 95, resetsAt: '2026-11-01T12:00:00Z', asOf: new Date(NOW).toISOString() } }),
    snapshot({ sources: { ...snapshot().sources, runsDir: 'missing' } }),
  ];
  const items = variants.flatMap(value => deriveFleetNeedsYou(value, NOW).items);
  const expected = {
    'claude-lane-down': { kind: 'terminal', command: '~/.ashlr-runs/bin/fix-claude-lane.sh' },
    'lane-held:fake-lane': { kind: 'pane', paneId: 'fleet-lanes' },
    'stall-incident': { kind: 'pane', paneId: 'leader-journal' },
    'leader-overdue': { kind: 'pane', paneId: 'leader-journal' },
    'supply-personal-out': { kind: 'pane', paneId: 'fleet-supply' },
    'supply-personal-low': { kind: 'pane', paneId: 'fleet-supply' },
    'host-pressure': { kind: 'pane', paneId: 'fleet-host' },
  };
  for (const [id, open] of Object.entries(expected)) expect(items.find(item => item.id === id)?.open).toEqual(open);
  for (const id of ['switches-on', 'runs-dir-missing']) expect(items.find(item => item.id === id)?.open).toBeUndefined();
  const known = ['fleet-lanes', 'leader-journal', 'fleet-supply', 'fleet-host'];
  for (const item of items) if (item.open?.kind === 'pane') {
    expect(known).toContain(item.open.paneId);
    expect(normalizePaneId(item.open.paneId)).toBe(item.open.paneId);
  }
});
it('opens blocked releases in Releases', () => {
  const items = deriveReleaseNeedsYou({ kind: 'available', data: {
    v: 1, generatedAt: new Date(NOW).toISOString(), sourceState: 'healthy',
    repos: [{ repo: 'fake/repo', path: '/fake', notes: [], pr: {
      number: 1, title: 'Fake release', version: null, url: 'https://github.com/fake/repo/pull/1',
      openedAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
      mergeable: null, checks: [], failing: [], pending: 1, blocked: true, summary: 'blocked',
    } }],
  } }, NOW);
  expect(items[0]?.open).toEqual({ kind: 'pane', paneId: 'fleet-releases' });
  expect(normalizePaneId('fleet-releases')).toBe('fleet-releases');
});
