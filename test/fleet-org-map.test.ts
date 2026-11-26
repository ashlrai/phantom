import { describe, expect, it } from 'vitest';
import { fleetOrgMap, mapWindowMinutes } from '../src/core/fleet/org-map.js';
import type { FleetLiveSnapshotV1, FleetLiveRun } from '../src/core/fleet/fleet-types.js';
import type { FleetSessionsV1 } from '../src/core/fleet/runs-sessions.js';
import { projectFleetEdges } from '../src/core/fleet/fleet-edges.js';

function run(id: string, lane: FleetLiveRun['lane'], overrides: Partial<FleetLiveRun> = {}): FleetLiveRun {
  return { id, taskId: null, repo: 'phantom', title: id, lane, seatId: null, engine: null, model: null,
    phase: 'producing', startedAt: null, phaseStartedAt: null, endedAt: null, outcome: null, prNumber: null, hold: null, seatDecision: null, ...overrides };
}

describe('fleet map', () => {
  it('groups five active jobs under three lanes and excludes past and waiting work', () => {
    const snapshot = { generatedAt: '2026-11-09T00:00:00Z', state: 'running',
      lanes: ['codex', 'claude-cli', 'local'].map(lane => ({ lane, slots: 2, busy: 1, capReason: null })),
      runs: [run('one', 'codex'), run('two', 'codex'), run('three', 'claude-cli'), run('four', 'local'), run('five', 'local'),
        run('waiting', 'codex', { phase: 'queued' }), run('finished', 'codex', { outcome: 'merged' })] } as FleetLiveSnapshotV1;
    const map = fleetOrgMap(snapshot);
    expect(map.nodes.find(node => node.kind === 'leader')).toMatchObject({ label: 'Leader (CEO)', status: 'unknown' });
    expect(map.nodes.filter(node => node.kind === 'job').map(node => [node.lane, node.jobId])).toEqual([
      ['codex', 'one'], ['codex', 'two'], ['claude-cli', 'three'], ['local', 'four'], ['local', 'five'],
    ]);
    expect(map.edges).toContainEqual({ id: 'reports:job:three:lane:claude-cli', kind: 'reports-to', from: 'job:three', to: 'lane:claude-cli', provider: 'Anthropic' });
  });
  it('preserves unknown state and unmatched lanes', () => {
    expect(fleetOrgMap(null).sources).toEqual({ fleet: 'unknown', sessions: 'unknown', messages: 'unknown' });
    expect(fleetOrgMap(null).nodes.some(node => node.kind === 'lane')).toBe(false);
    const snapshot = { generatedAt: 'now', state: 'dark', lanes: [], runs: [run('unknown', null)] } as unknown as FleetLiveSnapshotV1;
    expect(fleetOrgMap(snapshot).nodes.find(node => node.kind === 'job')).toMatchObject({ jobId: 'unknown', lane: 'unknown', provider: 'unknown', model: 'unknown', ageSeconds: null });
  });
  it('adds ready profile lanes and uses catalog identity without guessing unready lanes', () => {
    const profile = { id: 'studio', label: 'Engineering studio', resource: 'custom:studio', provider: 'OpenAI', state: 'ready' as const };
    const map = fleetOrgMap(null, { profileLanes: [profile, { ...profile, id: 'not-ready', state: 'executor-unavailable' }] });
    expect(map.nodes.filter(node => node.kind === 'lane')).toEqual([
      { id: 'lane:studio', kind: 'lane', lane: 'studio', label: 'Engineering studio', provider: 'OpenAI', status: 'ready' },
    ]);
  });
  it('joins two session lanes, three jobs and a recent leader message without reviving a stale claim', () => {
    const now = Date.parse('2026-11-16T12:00:00Z');
    const sessions = { generatedAt: new Date(now).toISOString(), sourceState: 'healthy', truncated: false, recent: [], sessions: [
      { job: 'one', lane: 'codex-cmp', model: 'fixture-model', repo: 'phantom', elapsedSeconds: 90, status: 'running' },
      { job: 'two', lane: 'claude', model: null, repo: 'phantom', elapsedSeconds: 60, status: 'running' },
      { job: 'stale', lane: 'claude', model: null, repo: null, elapsedSeconds: 7200, status: 'stale' },
    ] } as FleetSessionsV1;
    const snapshot = { generatedAt: sessions.generatedAt, state: 'running', lanes: [], runs: [run('stale', 'codex')] } as unknown as FleetLiveSnapshotV1;
    const receipt = (receivedAt: number, from = 'leader', to = 'claude', external = false) => ({ cursor: 1, receivedAt,
      envelope: { id: 'fixture', from, to, priority: 'P2' as const, ttl: 3600000, body: { text: 'private fixture body' }, external } });
    const messages = { schema: 'fleet.edges.v1' as const, source: 'available' as const, edges: projectFleetEdges([
      receipt(now), receipt(now - 60_000), receipt(now - 300_000), receipt(now + 1), receipt(now, 'stranger'), receipt(now, 'leader', 'claude', true),
    ], now, 5) };
    const map = fleetOrgMap(snapshot, { sessions, messages, now, minutes: 5 });
    expect(map.schema).toBe('fleet.map.v2'); expect(map.messageWindowMinutes).toBe(5);
    expect(map.nodes.filter(node => node.kind === 'job')).toHaveLength(3);
    expect(map.nodes.find(node => node.jobId === 'one')).toMatchObject({ model: 'fixture-model', provider: 'OpenAI', ageSeconds: 90 });
    expect(map.nodes.find(node => node.jobId === 'stale')).toMatchObject({ lane: 'claude', status: 'stale', repo: 'unknown', model: 'unknown' });
    expect(map.nodes.filter(node => node.kind === 'lane').map(node => node.label)).toEqual(['codex-cmp', 'claude']);
    expect(map.nodes.filter(node => node.kind === 'channel')).toHaveLength(5);
    expect(map.nodes.find(node => node.kind === 'guardian')?.status).toBe('unknown');
    expect(map.edges.filter(edge => edge.kind === 'message')).toEqual([{ id: 'message:leader:lane:claude', kind: 'message', from: 'leader', to: 'lane:claude', provider: 'unknown', count: 2, lastAt: new Date(now).toISOString() }]);
    expect(map.unmappedMessages).toBe(1); expect(JSON.stringify(map)).not.toContain('private fixture body');
    const nodeProvider = new Map(map.nodes.map(node => [node.id, node.provider]));
    expect(map.edges.every(edge => edge.provider === nodeProvider.get(edge.from))).toBe(true);
    expect(map.edges.find(edge => edge.id === 'reports:job:one:lane:codex-cmp')?.provider).toBe('OpenAI');
    expect(map.nodes.find(node => node.id === 'lane:codex-local')).toBeUndefined();
    const ids = new Set(map.nodes.map(node => node.id));
    expect(map.edges.every(edge => ids.has(edge.from) && ids.has(edge.to))).toBe(true);
  });
  it('keeps unavailable bus counts and invalid/future job ages unknown', () => {
    const snapshot = { generatedAt: 'now', lanes: [], runs: [run('future', null, { startedAt: '2099-01-01' }), run('invalid', null, { startedAt: 'invalid' })] } as unknown as FleetLiveSnapshotV1;
    const map = fleetOrgMap(snapshot, { messages: { schema: 'fleet.edges.v1', source: 'unavailable', edges: null }, now: 1 });
    expect(map.unmappedMessages).toBeNull(); expect(map.edges.some(edge => edge.kind === 'message')).toBe(false);
    expect(map.nodes.filter(node => node.kind === 'job').every(node => node.ageSeconds === null)).toBe(true);
  });
  it('bounds message windows without accepting ambiguous input', () => {
    expect(mapWindowMinutes(undefined)).toBe(60); expect(mapWindowMinutes('1440')).toBe(1440);
    for (const value of ['', '0', '-1', '1.5', 'Infinity', '1441']) expect(() => mapWindowMinutes(value)).toThrow();
    expect(() => projectFleetEdges([], 1, 0)).toThrow();
  });
  it('does not inherit provider properties or guess an ambiguous bus address', () => {
    const snapshot = { generatedAt: 'now', lanes: [], runs: [run('leader', 'constructor' as FleetLiveRun['lane'])] } as unknown as FleetLiveSnapshotV1;
    const map = fleetOrgMap(snapshot, { messages: { schema: 'fleet.edges.v1', source: 'available', edges: [
      { from: { address: 'leader', provider: null }, to: { address: 'claude', provider: null }, messages: 1, messagesLastHour: 1, lastAt: 1 },
    ] } });
    expect(map.nodes.find(node => node.jobId === 'leader')?.provider).toBe('unknown');
    expect(map.unmappedMessages).toBe(1); expect(map.edges.some(edge => edge.kind === 'message')).toBe(false);
  });
});
