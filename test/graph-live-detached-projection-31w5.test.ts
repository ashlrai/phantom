import { describe, expect, it } from 'vitest';
import { joinGraphLive } from '../src/core/fleet/graph-live.js';
import type { RegistryGraph } from '../src/core/graph/types.js';
import type { SeatCapacity } from '../src/core/routing/headroom.js';
import type { AshlrConfig } from '../src/core/types.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');

function fixture() {
  const seatIds = ['seat'];
  const graph: RegistryGraph = {
    schema: 'graph.v1', readOnly: true, complete: true,
    sources: { fleet: 'loaded', seats: 'loaded' }, issues: [],
    nodes: [
      { id: 'account-a', kind: 'engine-account', engine: 'codex', accountId: 'a', seatIds },
      { id: 'account-b', kind: 'engine-account', engine: 'codex', accountId: 'b', seatIds },
      { id: 'model-a', kind: 'model', engine: 'codex', modelId: 'a' },
      { id: 'model-b', kind: 'model', engine: 'codex', modelId: 'b' },
      { id: 'model-unserved', kind: 'model', engine: 'codex', modelId: 'unserved' },
      { id: 'agent-a', kind: 'agent', agentId: 'a' },
      { id: 'agent-b', kind: 'agent', agentId: 'b' },
      { id: 'mcp', kind: 'mcp', serverId: 'mcp' },
    ],
    edges: [
      { id: '1', kind: 'routes-to', from: 'account-a', to: 'model-a', source: 'seats' },
      { id: '2', kind: 'routes-to', from: 'account-b', to: 'model-a', source: 'seats' },
      { id: '3', kind: 'routes-to', from: 'account-a', to: 'model-b', source: 'seats' },
      { id: '4', kind: 'routes-to', from: 'agent-a', to: 'model-a', source: 'fleet' },
      { id: '5', kind: 'routes-to', from: 'agent-b', to: 'model-a', source: 'fleet' },
    ],
  };
  const seat: SeatCapacity = {
    seatId: 'seat', engine: 'codex', label: 'seat', free: false, signedOut: false,
    reachable: true, contextWindow: null, observedAt: new Date(NOW - 1000).toISOString(),
    spentTodayUsd: 0.5,
    windows: [{ id: 'window', usedPercent: 85, resetsAt: null, resetDescription: null, limitReached: false }],
  };
  const usage = { usedPercent: 30, windowLabel: '5h' };
  const events = [{ backend: 'codex', ts: new Date(NOW - 1000).toISOString() }];
  const cfg = { foundry: { limits: { codex: { window: '5h', max: 8 } } } } as AshlrConfig;
  const sources = { seats: [seat], usage: { codex: usage }, quota: { events }, cfg };
  return { graph, sources, seatIds, seat, usage, events, cfg };
}

function freezeDeep(value: unknown): void {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
}

describe('detached graph live projection', () => {
  it('preserves state, counts, and reasons across shared resources', () => {
    const { graph, sources } = fixture();
    const result = joinGraphLive(graph, sources, { nowMs: NOW });
    expect(result.counts).toEqual({
      nodes: 8, byState: { ready: 1, limited: 6, exhausted: 0, held: 0, stale: 0, unknown: 0, untracked: 1 },
    });
    expect(result.nodes.map(({ id, live }) => [id, live.state, live.reasons])).toEqual([
      ['account-a', 'limited', ['window 85% used']],
      ['account-b', 'limited', ['window 85% used']],
      ['model-a', 'limited', ['served by 2 engine accounts', 'window 85% used']],
      ['model-b', 'limited', ['served by 1 engine account', 'window 85% used']],
      ['model-unserved', 'ready', ['no enrolled account lists this model']],
      ['agent-a', 'limited', ['served by 2 engine accounts', 'window 85% used']],
      ['agent-b', 'limited', ['served by 2 engine accounts', 'window 85% used']],
      ['mcp', 'untracked', ['no live signal applies']],
    ]);
    expect(result.nodes[0]!.live.quota).toEqual({ used: 1, limit: 8, windowLabel: '5h', standing: 'ok' });
  });

  it('isolates mutations to each returned node from inputs and every sibling', () => {
    const { graph, sources } = fixture();
    const beforeInputs = structuredClone({ graph, sources });
    const result = joinGraphLive(graph, sources, { nowMs: NOW });
    const beforeNodes = structuredClone(result.nodes);
    for (let i = 0; i < result.nodes.length; i++) {
      const node = result.nodes[i]!;
      if (node.kind === 'engine-account') node.seatIds.push('injected');
      node.live.reasons.push('injected');
      if (node.live.quota) node.live.quota.used = 999;
      expect({ graph, sources }).toEqual(beforeInputs);
      expect(result.nodes.slice(i + 1)).toEqual(beforeNodes.slice(i + 1));
    }
  });

  it('keeps the observation unchanged when nested inputs are mutated later', () => {
    const { graph, sources, seatIds, seat, usage, events, cfg } = fixture();
    const result = joinGraphLive(graph, sources, { nowMs: NOW });
    const before = structuredClone(result);
    seatIds.push('new-seat');
    seat.windows[0]!.usedPercent = 100;
    usage.usedPercent = 100;
    events[0]!.backend = 'other';
    cfg.foundry!.limits!.codex!.max = 1;
    graph.nodes.splice(0, 1);
    graph.edges.splice(0, 1);
    expect(result).toEqual(before);
  });

  it('accepts deeply frozen inputs and still returns mutable detached values', () => {
    const { graph, sources } = fixture();
    const expected = joinGraphLive(graph, sources, { nowMs: NOW });
    freezeDeep(graph);
    freezeDeep(sources);
    const result = joinGraphLive(graph, sources, { nowMs: NOW });
    expect(result).toEqual(expected);
    const account = result.nodes[0]!;
    if (account.kind !== 'engine-account' || !account.live.quota) throw new Error('fixture account missing');
    account.seatIds.push('new-seat');
    account.live.reasons.push('new reason');
    account.live.quota.used = 99;
    expect(result.nodes[1]).toEqual(expected.nodes[1]);
  });
});
