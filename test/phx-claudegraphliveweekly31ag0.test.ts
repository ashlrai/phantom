import { describe, expect, it } from 'vitest';
import { buildRegistryGraph } from '../src/core/graph/registry.js';
import { readGraphLive, type GraphLiveSources } from '../src/core/fleet/graph-live.js';
import type { CapacityWindow, SeatCapacity } from '../src/core/routing/headroom.js';
import type { AshlrConfig } from '../src/core/types.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const SHORT_RESET = '2026-10-31T13:00:00.000Z';
const WEEK_RESET = '2026-11-04T12:00:00.000Z';

function window(id: string, usedPercent: number | null, resetsAt: string | null, limitReached = false): CapacityWindow {
  return { id, usedPercent, resetsAt, resetDescription: null, limitReached };
}

const oldSession = window('five_hour', 100, SHORT_RESET, true);
const weekly = window('seven_day', 35, WEEK_RESET);

function project(engine: 'claude' | 'codex' | 'claude-api', windows: CapacityWindow[],
  extra: Partial<SeatCapacity> = {}, sources: Partial<GraphLiveSources> = {}) {
  const seat: SeatCapacity = {
    seatId: 'fake-seat', engine, label: 'Fake seat', free: false, windows,
    signedOut: false, reachable: true, contextWindow: null,
    observedAt: new Date(NOW - 1_000).toISOString(), spentTodayUsd: null, ...extra,
  };
  const graph = buildRegistryGraph({
    schema: 'fleet.v1', agents: [{ id: 'fake-agent', seatId: 'fake-seat', modelId: 'fake-model' }],
    mcp: [], edges: [],
  }, [{ id: 'fake-seat', engine, accountId: 'fake-account', models: [{ id: 'fake-model' }] }]);
  return readGraphLive(graph, {
    nowMs: NOW, seats: [seat], usage: {}, verdicts: {}, quota: { events: [] }, ...sources,
  });
}

describe('Claude graph seat window projection', () => {
  it('projects weekly capacity and reset through the account, model, and agent', () => {
    const result = project('claude', [oldSession, weekly]);
    for (const node of result.nodes) {
      expect(node.live).toMatchObject({ state: 'ready', usedPercent: 35,
        resetsAtMs: Date.parse(WEEK_RESET), readingAgeMs: 1_000, stale: false });
      expect(node.live.reasons.join(' ')).not.toMatch(/exhausted|limit reached/);
    }
  });

  it.each(['five_hour', 'session'])('leaves an obsolete %s-only reading unknown', (id) => {
    const result = project('claude', [{ ...oldSession, id }]);
    for (const node of result.nodes) {
      expect(node.live).toMatchObject({ state: 'unknown', usedPercent: null, resetsAtMs: null,
        readingAgeMs: 1_000, stale: false });
    }
  });

  it.each([{ signedOut: true }, { reachable: false }])('retains account reachability refusal %o', (extra) => {
    const account = project('claude', [oldSession, weekly], extra).nodes.find((node) => node.kind === 'engine-account')!;
    expect(account.live).toMatchObject({ state: 'held', usedPercent: null, resetsAtMs: null });
    expect(account.live.reasons).toContain('seat fake-seat reports signed out or unreachable');
  });

  it('retains an independent gate refusal', () => {
    const result = project('claude', [oldSession, weekly], {}, {
      verdicts: { claude: { allowed: false, reason: 'fake independent policy refusal' } },
    });
    expect(result.nodes[0]!.live).toMatchObject({ state: 'held', usedPercent: 35, resetsAtMs: Date.parse(WEEK_RESET) });
    expect(result.nodes[0]!.live.reasons).toContain('gate: fake independent policy refusal');
  });

  it('retains independent dispatch quota exhaustion', () => {
    const result = project('claude', [oldSession, weekly], {}, {
      cfg: { foundry: { limits: { claude: { window: '5h', max: 1 } } } } as AshlrConfig,
      quota: { events: [{ backend: 'claude', ts: new Date(NOW - 1_000).toISOString() }] },
    });
    expect(result.nodes[0]!.live).toMatchObject({ state: 'exhausted', usedPercent: 35,
      resetsAtMs: Date.parse(WEEK_RESET), quota: { standing: 'over', used: 1 } });
  });

  it('keeps Codex and Claude API session windows intact', () => {
    for (const engine of ['codex', 'claude-api'] as const) {
      expect(project(engine, [oldSession]).nodes[0]!.live).toMatchObject({ state: 'exhausted',
        usedPercent: 100, resetsAtMs: Date.parse(SHORT_RESET) });
    }
  });

  it('preserves weekly saturation and reset, including a short-distance weekly reset', () => {
    const result = project('claude', [window('seven_day', 100, SHORT_RESET, true)]);
    expect(result.nodes[0]!.live).toMatchObject({ state: 'exhausted', usedPercent: 100,
      resetsAtMs: Date.parse(SHORT_RESET) });
  });

  it('retains other identified and unclassified windows even with a short reset', () => {
    const result = project('claude', [oldSession, window('unclassified', null, SHORT_RESET, true)]);
    expect(result.nodes[0]!.live).toMatchObject({ state: 'exhausted', usedPercent: 100,
      resetsAtMs: Date.parse(SHORT_RESET) });
  });

  it('keeps stale weekly observations stale', () => {
    const result = project('claude', [oldSession, weekly], { observedAt: new Date(NOW - 3_600_000).toISOString() });
    expect(result.nodes[0]!.live).toMatchObject({ state: 'stale', usedPercent: null,
      resetsAtMs: Date.parse(WEEK_RESET), readingAgeMs: 3_600_000, stale: true });
  });
});
