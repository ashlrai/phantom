/**
 * graph-live.test.ts — RQ-GRAPH-2A: the graph.v1 live-state joiner.
 *
 * src/core/fleet/graph-live.ts joins the fleet's live evidence (capacity
 * snapshot seats, subscription-usage readings + gate verdicts, the dispatch
 * quota ledger, and the daily-budget view) onto graph.v1 registry nodes as a
 * pure, observation-only projection: capacity, cost, reset time, staleness.
 *
 * Everything is exercised through joinGraphLive() with explicit inputs and a
 * fixed clock — no disk access. readGraphLive() is covered last against the
 * suite's isolated HOME (test/setup/home.ts), where the live stores are
 * absent by construction.
 */

import { describe, expect, it } from 'vitest';
import { buildRegistryGraph } from '../src/core/graph/registry.js';
import type { RegistryGraph } from '../src/core/graph/types.js';
import {
  GRAPH_LIVE_SCHEMA,
  joinGraphLive,
  readGraphLive,
  type GraphLiveProjection,
  type GraphLiveSources,
} from '../src/core/fleet/graph-live.js';
import type { FleetBudget } from '../src/core/fleet/budget-view.js';
import type { SeatCapacity, CapacityWindow } from '../src/core/routing/headroom.js';
import type { AshlrConfig } from '../src/core/types.js';

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const HOUR = 3_600_000;
const MIN = 60_000;

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function window(partial: Partial<CapacityWindow>): CapacityWindow {
  return { id: 'primary', usedPercent: null, resetsAt: null, resetDescription: null,
    limitReached: false, ...partial };
}

function seat(partial: Partial<SeatCapacity> & { seatId: string; engine: string }): SeatCapacity {
  return { label: partial.seatId, free: false, windows: [], signedOut: false,
    reachable: true, contextWindow: null, observedAt: null, spentTodayUsd: null,
    ...partial };
}

const FLEET = {
  schema: 'fleet.v1' as const,
  agents: [
    { id: 'producer', seatId: 'codex-work', modelId: 'gpt-x', mcpIds: ['locus'] },
    { id: 'reviewer', seatId: 'claude-work' },
    { id: 'idle' },
  ],
  mcp: [{ id: 'locus' }],
  edges: [{ kind: 'reviews' as const, from: 'reviewer', to: 'producer' }],
};

const SEATS = [
  { id: 'codex-work', engine: 'codex', accountId: 'work', models: [{ id: 'gpt-x' }] },
  { id: 'codex-alt', engine: 'codex', accountId: 'alt', models: [{ id: 'gpt-x' }] },
  { id: 'claude-work', engine: 'claude', accountId: 'work', models: [{ id: 'sonnet' }] },
  { id: 'kimi-work', engine: 'kimi', accountId: 'work', models: [{ id: 'k2' }] },
  { id: 'local-rt', engine: 'builtin', accountId: 'local', models: [] },
];

function graph(): RegistryGraph {
  return buildRegistryGraph(FLEET, SEATS);
}

function live(graph_: RegistryGraph, sources: GraphLiveSources, nowMs = NOW): GraphLiveProjection {
  return joinGraphLive(graph_, sources, { nowMs });
}

function node(projection: GraphLiveProjection, id: string) {
  const found = projection.nodes.find((n) => n.id === id);
  expect(found, `node ${id}`).toBeDefined();
  return found!;
}

const ACCOUNT = (engine: string, account: string) => `engine-account:${engine}/${account}`;

// ---------------------------------------------------------------------------
// Pure projection shape
// ---------------------------------------------------------------------------

describe('graph-live projection shape', () => {
  it('returns a graph-live.v1 observation-only projection with every node joined', () => {
    const projection = live(graph(), { seats: [] });
    expect(projection.schema).toBe(GRAPH_LIVE_SCHEMA);
    expect(projection.readOnly).toBe(true);
    expect(projection.authority).toBe('observation-only');
    expect(projection.sampledAtMs).toBe(NOW);
    expect(projection.nodes).toHaveLength(graph().nodes.length);
    for (const n of projection.nodes) {
      expect(n.live).toBeDefined();
      expect(n.live.state).toBeTruthy();
      expect(Array.isArray(n.live.reasons)).toBe(true);
    }
    expect(projection.counts.nodes).toBe(projection.nodes.length);
    const byState = Object.values(projection.counts.byState).reduce((a, b) => a + b, 0);
    expect(byState).toBe(projection.nodes.length);
  });

  it('is deterministic and does not mutate its inputs', () => {
    const g = graph();
    const sources: GraphLiveSources = {
      seats: [seat({ seatId: 'codex-work', engine: 'codex',
        observedAt: new Date(NOW - 60_000).toISOString(),
        windows: [window({ usedPercent: 42, resetsAt: new Date(NOW + HOUR).toISOString() })] })],
      usage: { codex: { usedPercent: 30, windowLabel: '5h', resetsAt: (NOW + 2 * HOUR) / 1000 } },
      quota: { events: [{ backend: 'codex', ts: new Date(NOW - 10 * MIN).toISOString() }] },
      cfg: { foundry: { limits: { codex: { window: '5h', max: 8 } } } } as AshlrConfig,
    };
    const beforeGraph = JSON.stringify(g);
    const beforeSources = JSON.stringify(sources);
    const a = live(g, sources);
    const b = live(g, sources);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(g)).toBe(beforeGraph);
    expect(JSON.stringify(sources)).toBe(beforeSources);
  });
});

// ---------------------------------------------------------------------------
// Capacity / cost / reset / staleness on engine-account nodes
// ---------------------------------------------------------------------------

describe('engine-account live state', () => {
  it('joins fresh seat windows: capacity, cost, reset time', () => {
    const resetIso = new Date(NOW + 5 * HOUR).toISOString();
    const projection = live(graph(), {
      seats: [seat({ seatId: 'codex-work', engine: 'codex',
        observedAt: new Date(NOW - 30_000).toISOString(), spentTodayUsd: 0.42,
        windows: [window({ usedPercent: 42, resetsAt: resetIso })] })],
    });
    const n = node(projection, ACCOUNT('codex', 'work'));
    expect(n.live.state).toBe('ready');
    expect(n.live.usedPercent).toBe(42);
    expect(n.live.resetsAtMs).toBe(Date.parse(resetIso));
    expect(n.live.spentTodayUsd).toBe(0.42);
    expect(n.live.readingAgeMs).toBe(30_000);
    expect(n.live.stale).toBe(false);
  });

  it('sums spend across seats of the same account (cost)', () => {
    const g = buildRegistryGraph(FLEET, [
      ...SEATS,
      { id: 'codex-work-2', engine: 'codex', accountId: 'work', models: [{ id: 'gpt-x' }] },
    ]);
    const projection = live(g, {
      seats: [
        seat({ seatId: 'codex-work', engine: 'codex',
          observedAt: new Date(NOW - 10_000).toISOString(), spentTodayUsd: 0.4,
          windows: [window({ usedPercent: 10 })] }),
        seat({ seatId: 'codex-work-2', engine: 'codex',
          observedAt: new Date(NOW - 20_000).toISOString(), spentTodayUsd: 0.3,
          windows: [window({ usedPercent: 12 })] }),
      ],
    });
    const n = node(projection, ACCOUNT('codex', 'work'));
    expect(n.live.state).toBe('ready');
    expect(n.live.spentTodayUsd).toBeCloseTo(0.7, 10);
    expect(n.live.usedPercent).toBe(12); // max across the account's seats
    expect(n.live.readingAgeMs).toBe(10_000); // freshest
  });

  it('marks warn-band windows limited and reports the binding reset', () => {
    const resetIso = new Date(NOW + 90 * MIN).toISOString();
    const projection = live(graph(), {
      seats: [seat({ seatId: 'codex-work', engine: 'codex',
        observedAt: new Date(NOW - 5_000).toISOString(),
        windows: [
          window({ id: 'weekly', usedPercent: 85, resetsAt: new Date(NOW + 30 * HOUR).toISOString() }),
          window({ id: 'session', usedPercent: 20, resetsAt: resetIso }),
        ] })],
    });
    const n = node(projection, ACCOUNT('codex', 'work'));
    expect(n.live.state).toBe('limited');
    expect(n.live.usedPercent).toBe(85);
    // The binding (most-utilized) window supplies the reset time.
    expect(n.live.resetsAtMs).toBe(Date.parse(new Date(NOW + 30 * HOUR).toISOString()));
    expect(n.live.reasons.some((r) => r.includes('85%'))).toBe(true);
  });

  it('marks provider limit flags and 100% windows exhausted', () => {
    const flagged = live(graph(), {
      seats: [seat({ seatId: 'codex-work', engine: 'codex',
        observedAt: new Date(NOW - 5_000).toISOString(),
        windows: [window({ usedPercent: null, limitReached: true,
          resetsAt: new Date(NOW + HOUR).toISOString() })] })],
    });
    expect(node(flagged, ACCOUNT('codex', 'work')).live.state).toBe('exhausted');
    expect(node(flagged, ACCOUNT('codex', 'work')).live.resetsAtMs).toBe(NOW + HOUR);

    const full = live(graph(), {
      seats: [seat({ seatId: 'codex-work', engine: 'codex',
        observedAt: new Date(NOW - 5_000).toISOString(),
        windows: [window({ usedPercent: 100 })] })],
    });
    expect(node(full, ACCOUNT('codex', 'work')).live.state).toBe('exhausted');
    expect(node(full, ACCOUNT('codex', 'work')).live.usedPercent).toBe(100);
  });

  it('marks all-stale readings stale and undated/unread seats unknown', () => {
    const stale = live(graph(), {
      seats: [seat({ seatId: 'codex-work', engine: 'codex',
        observedAt: new Date(NOW - 2 * HOUR).toISOString(),
        windows: [window({ usedPercent: 50 })] })],
    });
    const n = node(stale, ACCOUNT('codex', 'work'));
    expect(n.live.state).toBe('stale');
    expect(n.live.stale).toBe(true);
    expect(n.live.readingAgeMs).toBe(2 * HOUR);

    const undated = live(graph(), {
      seats: [seat({ seatId: 'codex-work', engine: 'codex',
        windows: [window({ usedPercent: 50 })] })],
    });
    expect(node(undated, ACCOUNT('codex', 'work')).live.state).toBe('unknown');
  });

  it('subscription engines without any reading are unknown, never ready', () => {
    const projection = live(graph(), { seats: [] });
    expect(node(projection, ACCOUNT('codex', 'work')).live.state).toBe('unknown');
    expect(node(projection, ACCOUNT('claude', 'work')).live.state).toBe('unknown');
    // No seats-missing issue: a roster WAS supplied, it is just empty.
    expect(projection.issues.some((i) => i.code === 'seats-missing')).toBe(false);
  });

  it('free local seats are ready; non-subscription engines without signals are untracked', () => {
    const projection = live(graph(), {
      seats: [seat({ seatId: 'local-rt', engine: 'builtin', free: true })],
    });
    expect(node(projection, ACCOUNT('builtin', 'local')).live.state).toBe('ready');
    expect(node(projection, ACCOUNT('kimi', 'work')).live.state).toBe('untracked');
  });

  it('signed-out and unreachable seats hold their account', () => {
    const signedOut = live(graph(), {
      seats: [seat({ seatId: 'claude-work', engine: 'claude', signedOut: true,
        observedAt: new Date(NOW - 60_000).toISOString() })],
    });
    const n = node(signedOut, ACCOUNT('claude', 'work'));
    expect(n.live.state).toBe('held');
    expect(n.live.reasons.some((r) => r.includes('signed out'))).toBe(true);

    const unreachable = live(graph(), {
      seats: [seat({ seatId: 'claude-work', engine: 'claude', reachable: false,
        observedAt: new Date(NOW - 60_000).toISOString() })],
    });
    expect(node(unreachable, ACCOUNT('claude', 'work')).live.state).toBe('held');
  });

  it('fresh seat windows join on non-subscription engines too', () => {
    const projection = live(graph(), {
      seats: [seat({ seatId: 'kimi-work', engine: 'kimi',
        observedAt: new Date(NOW - 10_000).toISOString(),
        windows: [window({ usedPercent: 55 })] })],
    });
    const n = node(projection, ACCOUNT('kimi', 'work'));
    expect(n.live.state).toBe('ready');
    expect(n.live.usedPercent).toBe(55);
  });
});

// ---------------------------------------------------------------------------
// Subscription-window readings (subscription-usage.ts)
// ---------------------------------------------------------------------------

describe('subscription usage readings', () => {
  it('joins a fresh local subscription reading', () => {
    const projection = live(graph(), {
      seats: [],
      usage: { codex: { usage: { usedPercent: 61, windowLabel: '5h', resetsAt: (NOW + HOUR) / 1000 },
        observedAtMs: NOW - 5_000 } },
    });
    const n = node(projection, ACCOUNT('codex', 'work'));
    expect(n.live.state).toBe('ready');
    expect(n.live.usedPercent).toBe(61);
    expect(n.live.resetsAtMs).toBe(NOW + HOUR);
    expect(n.live.stale).toBe(false);
  });

  it('accepts a bare SubscriptionUsage as just-read (fresh)', () => {
    const projection = live(graph(), {
      seats: [],
      usage: { codex: { usedPercent: 90, windowLabel: '5h' } },
    });
    expect(node(projection, ACCOUNT('codex', 'work')).live.state).toBe('limited');
  });

  it('a stale usage reading is stale, not headroom', () => {
    const projection = live(graph(), {
      seats: [],
      usage: { codex: { usage: { usedPercent: 40, windowLabel: '5h' },
        observedAtMs: NOW - HOUR } },
    });
    const n = node(projection, ACCOUNT('codex', 'work'));
    expect(n.live.state).toBe('stale');
    expect(n.live.stale).toBe(true);
  });

  it('an explicit null reading contributes no evidence (unknown)', () => {
    const projection = live(graph(), { seats: [], usage: { codex: null } });
    expect(node(projection, ACCOUNT('codex', 'work')).live.state).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Dispatch quota (quota.ts)
// ---------------------------------------------------------------------------

describe('dispatch quota standing', () => {
  const cfg = (max: number, windowLabel = '5h') =>
    ({ foundry: { limits: { codex: { window: windowLabel, max } } } }) as AshlrConfig;
  const event = (ageMs: number) => ({ backend: 'codex' as const, ts: new Date(NOW - ageMs).toISOString() });

  it('counts only in-window dispatches and marks over-limit exhausted', () => {
    const projection = live(graph(), {
      seats: [],
      cfg: cfg(3),
      quota: { events: [event(10 * MIN), event(20 * MIN), event(30 * MIN), event(10 * HOUR)] },
    });
    const n = node(projection, ACCOUNT('codex', 'work'));
    expect(n.live.quota).toMatchObject({ used: 3, limit: 3, standing: 'over', windowLabel: '5h' });
    expect(n.live.state).toBe('exhausted');
  });

  it('marks the 80% band warn/limited and under ok/ready', () => {
    const warn = live(graph(), { seats: [], cfg: cfg(5), quota: { events: [event(MIN), event(2 * MIN), event(3 * MIN), event(4 * MIN)] } });
    expect(node(warn, ACCOUNT('codex', 'work')).live.state).toBe('limited');
    expect(node(warn, ACCOUNT('codex', 'work')).live.quota?.standing).toBe('warn');

    const ok = live(graph(), { seats: [], cfg: cfg(5), quota: { events: [event(MIN)] } });
    const n = node(ok, ACCOUNT('codex', 'work'));
    expect(n.live.quota?.standing).toBe('ok');
    // A subscription engine's quota alone does not prove window headroom —
    // but quota evidence outranks a bare "nothing read": the state stays
    // ready because the gate's own quota verdict is fresh evidence.
    expect(n.live.state).toBe('ready');
  });

  it('an unconfigured engine has no quota signal', () => {
    const projection = live(graph(), { seats: [], quota: { events: [] } });
    expect(node(projection, ACCOUNT('codex', 'work')).live.quota).toBeNull();
  });

  it('a malformed limit is held + invalid issue', () => {
    const projection = live(graph(), {
      seats: [],
      cfg: { foundry: { limits: { codex: { window: 'nope', max: 3 } } } } as AshlrConfig,
      quota: { events: [] },
    });
    const n = node(projection, ACCOUNT('codex', 'work'));
    expect(n.live.state).toBe('held');
    // A configured quota is engine-wide: every codex node is flagged.
    expect(projection.issues).toContainEqual({
      code: 'quota-limit-invalid',
      nodeIds: [ACCOUNT('codex', 'alt'), ACCOUNT('codex', 'work'), 'model:codex/gpt-x'],
    });
    expect(projection.complete).toBe(false);
  });

  it('a configured cap without a ledger is unknown + missing-ledger issue', () => {
    const projection = live(graph(), {
      seats: [],
      cfg: cfg(5),
      // quota intentionally absent
    });
    const n = node(projection, ACCOUNT('codex', 'work'));
    expect(n.live.quota?.standing).toBe('unknown');
    expect(n.live.state).toBe('unknown');
    expect(projection.issues).toContainEqual({
      code: 'quota-ledger-missing',
      nodeIds: [ACCOUNT('codex', 'alt'), ACCOUNT('codex', 'work'), 'model:codex/gpt-x'],
    });
  });
});

// ---------------------------------------------------------------------------
// Gate verdicts (subscriptionAllows) and the daily budget
// ---------------------------------------------------------------------------

describe('gate verdicts and budget cost', () => {
  it('a denied dispatch-gate verdict holds the account with its reason', () => {
    const projection = live(graph(), {
      seats: [],
      verdicts: { codex: { allowed: false, reason: 'codex subscription usage unknown (no reading)' } },
    });
    const n = node(projection, ACCOUNT('codex', 'work'));
    expect(n.live.state).toBe('held');
    expect(n.live.reasons).toContain('gate: codex subscription usage unknown (no reading)');
  });

  it('an allowed verdict outranks stale readings', () => {
    const projection = live(graph(), {
      seats: [seat({ seatId: 'codex-work', engine: 'codex',
        observedAt: new Date(NOW - 2 * HOUR).toISOString(),
        windows: [window({ usedPercent: 50 })] })],
      verdicts: { codex: { allowed: true, reason: 'codex within the balanced budget' } },
    });
    const n = node(projection, ACCOUNT('codex', 'work'));
    expect(n.live.state).not.toBe('stale');
    expect(n.live.stale).toBe(false);
    expect(n.live.reasons.some((r) => r.includes('stale'))).toBe(true);
  });

  const cappedBudget: FleetBudget = {
    day: '2026-10-26', dailyBudgetUsd: 1, budgetSource: 'config',
    spentTodayUsd: 1.5, remainingUsd: 0, capReached: true, reasons: [],
  };

  it('the daily cap holds metered engines but not subscription or local tiers', () => {
    const projection = live(graph(), {
      seats: [
        seat({ seatId: 'kimi-work', engine: 'kimi',
          observedAt: new Date(NOW - 5_000).toISOString(),
          windows: [window({ usedPercent: 10 })] }),
        seat({ seatId: 'codex-work', engine: 'codex',
          observedAt: new Date(NOW - 5_000).toISOString(),
          windows: [window({ usedPercent: 10 })] }),
        seat({ seatId: 'local-rt', engine: 'builtin', free: true }),
      ],
      budget: cappedBudget,
    });
    expect(node(projection, ACCOUNT('kimi', 'work')).live.state).toBe('held');
    expect(node(projection, ACCOUNT('kimi', 'work')).live.reasons).toContain('daily budget cap reached');
    // Subscription seats are flat-fee and local tiers spend nothing.
    expect(node(projection, ACCOUNT('codex', 'work')).live.state).toBe('ready');
    expect(node(projection, ACCOUNT('builtin', 'local')).live.state).toBe('ready');
    expect(projection.budget).toMatchObject({ spentTodayUsd: 1.5, dailyBudgetUsd: 1, capReached: true });
  });
});

// ---------------------------------------------------------------------------
// Join topology: models best-of accounts, agents worst-of bindings, mcp idle
// ---------------------------------------------------------------------------

describe('join topology', () => {
  it('a model takes the best state across its serving accounts', () => {
    const projection = live(graph(), {
      seats: [
        seat({ seatId: 'codex-work', engine: 'codex',
          observedAt: new Date(NOW - 5_000).toISOString(),
          windows: [window({ usedPercent: 100 })] }),
        seat({ seatId: 'codex-alt', engine: 'codex',
          observedAt: new Date(NOW - 5_000).toISOString(),
          windows: [window({ usedPercent: 5 })] }),
      ],
    });
    expect(node(projection, ACCOUNT('codex', 'work')).live.state).toBe('exhausted');
    expect(node(projection, ACCOUNT('codex', 'alt')).live.state).toBe('ready');
    // codex/gpt-x is served by both accounts — one healthy account suffices.
    expect(node(projection, 'model:codex/gpt-x').live.state).toBe('ready');
  });

  it('an agent takes the worst state across its bound resources', () => {
    const projection = live(graph(), {
      seats: [
        seat({ seatId: 'codex-work', engine: 'codex',
          observedAt: new Date(NOW - 5_000).toISOString(),
          windows: [window({ usedPercent: 97 })] }),
        seat({ seatId: 'claude-work', engine: 'claude',
          observedAt: new Date(NOW - 5_000).toISOString(),
          windows: [window({ usedPercent: 3 })] }),
      ],
    });
    // producer routes to codex/work + model codex/gpt-x (+ mcp, which carries no signal).
    const producer = node(projection, 'agent:producer');
    expect(producer.live.state).toBe('limited');
    expect(producer.live.usedPercent).toBe(97);
    // reviewer routes only to claude/work.
    expect(node(projection, 'agent:reviewer').live.state).toBe('ready');
    // idle binds nothing; mcp nodes never carry live state.
    expect(node(projection, 'agent:idle').live.state).toBe('untracked');
    expect(node(projection, 'mcp:locus').live.state).toBe('untracked');
  });

  it('engine-level readings apply to every account of that engine', () => {
    const projection = live(graph(), {
      seats: [],
      usage: { codex: { usedPercent: 95, windowLabel: '5h' } },
    });
    expect(node(projection, ACCOUNT('codex', 'work')).live.state).toBe('limited');
    expect(node(projection, ACCOUNT('codex', 'alt')).live.state).toBe('limited');
    expect(node(projection, 'model:codex/gpt-x').live.state).toBe('limited');
  });
});

// ---------------------------------------------------------------------------
// Issues and completeness
// ---------------------------------------------------------------------------

describe('issues and completeness', () => {
  it('a missing seat roster is seats-missing on subscription accounts', () => {
    const projection = live(graph(), { quota: { events: [] } });
    const issue = projection.issues.find((i) => i.code === 'seats-missing');
    expect(issue).toBeDefined();
    expect(issue!.nodeIds).toEqual([
      ACCOUNT('claude', 'work'), ACCOUNT('codex', 'alt'), ACCOUNT('codex', 'work'),
    ]);
    // Non-subscription engines are not listed: they expect no roster rows.
    expect(projection.complete).toBe(false);
  });

  it('a registry seat without a live row is seat-unread (subscription only)', () => {
    const projection = live(graph(), {
      seats: [seat({ seatId: 'claude-work', engine: 'claude', free: false,
        observedAt: new Date(NOW - 5_000).toISOString(),
        windows: [window({ usedPercent: 5 })] })],
    });
    const issue = projection.issues.find((i) => i.code === 'seat-unread');
    expect(issue).toBeDefined();
    expect(issue!.nodeIds).toEqual([ACCOUNT('codex', 'alt'), ACCOUNT('codex', 'work')]);
    expect(node(projection, ACCOUNT('codex', 'work')).live.reasons)
      .toContain('seat codex-work has no live reading');
  });

  it('an incomplete registry projection propagates', () => {
    const g = buildRegistryGraph(
      { ...FLEET, agents: [{ id: 'ghost', seatId: 'no-such-seat' }] },
      SEATS,
    );
    expect(g.complete).toBe(false);
    const projection = live(g, { seats: [] });
    expect(projection.complete).toBe(false);
    expect(projection.issues).toContainEqual({ code: 'graph-incomplete', nodeIds: [] });
  });

  it('degraded inputs degrade instead of throwing', () => {
    expect(() => joinGraphLive(null as unknown as RegistryGraph, {}, { nowMs: NOW })).not.toThrow();
    const broken = joinGraphLive(null as unknown as RegistryGraph, {}, { nowMs: NOW });
    expect(broken.complete).toBe(false);
    expect(broken.issues).toContainEqual({ code: 'graph-unavailable', nodeIds: [] });

    const garbage = live(graph(), {
      seats: 'nope' as unknown as SeatCapacity[],
      usage: { codex: 'junk' } as unknown as GraphLiveSources['usage'],
      quota: { events: 'x' } as unknown as GraphLiveSources['quota'],
      cfg: { foundry: { limits: { codex: { window: 1, max: 'x' } } } } as unknown as AshlrConfig,
      budget: {} as FleetBudget,
    });
    expect(garbage.nodes.length).toBe(graph().nodes.length);
  });
});

// ---------------------------------------------------------------------------
// readGraphLive — the never-throw live wrapper (isolated HOME: stores absent)
// ---------------------------------------------------------------------------

describe('readGraphLive', () => {
  it('returns a projection from the live stores without throwing', () => {
    const projection = readGraphLive(graph(), { nowMs: NOW });
    expect(projection.schema).toBe(GRAPH_LIVE_SCHEMA);
    expect(projection.nodes.length).toBe(graph().nodes.length);
    // No capacity snapshot on the isolated HOME: subscription engines cannot
    // show ready (fail-closed doctrine — unknown usage is not headroom).
    const codexAccount = node(projection, ACCOUNT('codex', 'work'));
    expect(['held', 'unknown', 'stale', 'limited', 'ready']).toContain(codexAccount.live.state);
  });

  it('honors source overrides without touching the stores', () => {
    const projection = readGraphLive(graph(), {
      nowMs: NOW,
      seats: [seat({ seatId: 'codex-work', engine: 'codex',
        observedAt: new Date(NOW - 5_000).toISOString(),
        windows: [window({ usedPercent: 12 })] })],
      usage: { codex: { usedPercent: 8, windowLabel: '5h' } },
      verdicts: { codex: { allowed: true, reason: 'within limit' } },
      quota: { events: [] },
    });
    const n = node(projection, ACCOUNT('codex', 'work'));
    expect(n.live.state).toBe('ready');
    expect(n.live.usedPercent).toBe(12);
  });
});
