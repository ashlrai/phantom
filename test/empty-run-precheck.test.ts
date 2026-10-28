/**
 * Empty-run precheck (fleet/empty-run-precheck.ts + the dispatch-router seam):
 *   - a job whose declared `acceptance:` command already passes on the default
 *     branch is closed as a no-op — `noop` carries the close and `hold` still
 *     skips it for consumers that predate the field;
 *   - a failing run, an inconclusive run, an absent run and a missing
 *     `acceptance:` command all launch the job — a check that cannot prove
 *     the work is done never closes it;
 *   - extraction is deterministic: the first usable `acceptance:` tag wins,
 *     blank / overlong / control-character tags are ignored;
 *   - the runner is only asked about jobs that declare a command.
 * Pure: no I/O, fixed clock.
 */
import { describe, expect, it } from 'vitest';

import {
  ACCEPTANCE_COMMAND_MAX_CHARS,
  ACCEPTANCE_TAG_PREFIX,
  acceptanceCommandOf,
  emptyRunPrecheck,
  emptyRunPrechecker,
  type AcceptanceRunResult,
} from '../src/core/fleet/empty-run-precheck.js';
import {
  FLEET_LOCAL_SEAT_ID,
  LANE_DEFAULT_SLOTS,
  routeWorkItem,
  type DispatchRouterContext,
  type LanePlan,
  type LegacyRoute,
} from '../src/core/fleet/dispatch-router.js';
import { defaultBudgetPolicy } from '../src/core/routing/policy.js';
import type { SeatCapacity } from '../src/core/routing/headroom.js';
import type { BudgetPolicy } from '../src/core/routing/types.js';
import type { EffectivePolicy, EffectiveSeatPolicy } from '../src/core/authority/types.js';
import type { FleetEngine } from '../src/core/fleet/fleet-types.js';
import type { EngineId, WorkItem } from '../src/core/types.js';

const NOW = Date.parse('2026-10-28T12:00:00.000Z');
const NOW_ISO = new Date(NOW).toISOString();
const REPO = 'ashlrai/binshield';
const REPO_PATH = '/tmp/mirrors/ashlrai__binshield';

function grok(used = 10): SeatCapacity {
  return {
    seatId: 'grok',
    engine: 'grok',
    label: 'Grok',
    free: false,
    windows: [{ id: 'grok_billing', usedPercent: used, resetsAt: new Date(NOW + 5 * 86_400_000).toISOString(), resetDescription: null, limitReached: false }],
    signedOut: false,
    reachable: null,
    contextWindow: 256_000,
    observedAt: NOW_ISO,
    spentTodayUsd: null,
  };
}

function local(window = 65_536): SeatCapacity {
  return {
    seatId: FLEET_LOCAL_SEAT_ID,
    engine: 'local',
    label: 'Local fleet',
    free: true,
    windows: [],
    signedOut: false,
    reachable: true,
    contextWindow: window,
    observedAt: null,
    spentTodayUsd: null,
  };
}

function seat(seatId: string, roles: EffectiveSeatPolicy['roles'], enabled = true): EffectiveSeatPolicy {
  return { seatId, enabled, reserveFloorPercent: 0, maxSessionWindowPercent: null, roles };
}

function policy(over: Partial<Pick<EffectivePolicy, 'engines' | 'spend' | 'repos'>> = {}): Pick<EffectivePolicy, 'engines' | 'spend' | 'repos'> {
  return {
    engines: ['local', 'grok-cli', 'claude-cli', 'codex'],
    spend: {
      maxMode: 'balanced',
      meteredUsdPerDay: 0,
      seats: {
        grok: seat('grok', ['producer', 'judge']),
        local: seat('local', ['producer']),
      },
    },
    repos: [{
      nameWithOwner: REPO,
      stage: 'merge',
      enforcement: 'server',
      maxRisk: 'low',
      maxFiles: 4,
      maxLines: 150,
      maxMergesPerDay: 6,
      selfRepo: null,
    }],
    ...over,
  };
}

function lanes(over: Partial<Record<FleetEngine, number>> = {}): Record<FleetEngine, LanePlan> {
  const out = {} as Record<FleetEngine, LanePlan>;
  for (const lane of ['local', 'grok-cli', 'claude-cli', 'codex'] as FleetEngine[]) {
    out[lane] = { lane, slots: over[lane] ?? LANE_DEFAULT_SLOTS[lane], capReason: null };
  }
  return out;
}

function ctx(capacity: SeatCapacity[], over: Partial<DispatchRouterContext> = {}): DispatchRouterContext {
  const budget: BudgetPolicy = defaultBudgetPolicy();
  return {
    nowMs: NOW,
    policy: policy(),
    budget,
    capacity,
    lanes: lanes(),
    laneEngines: { local: 'llama-server' as EngineId, 'grok-cli': 'grok-cli' as EngineId, 'claude-cli': 'claude' as EngineId, codex: 'codex' as EngineId },
    demotions: [],
    repoOf: (path) => (path === REPO_PATH ? REPO : null),
    tierOf: (engine) => {
      const id: string = engine;
      return id === 'llama-server' || id === 'local-coder' ? 'mid' : id === 'builtin' ? 'local' : 'frontier';
    },
    ...over,
  };
}

function item(over: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'item-1',
    repo: REPO_PATH,
    source: 'todo',
    title: 'Fix the parser edge case',
    detail: 'Short detail.',
    value: 3,
    effort: 3,
    score: 1,
    tags: [],
    ts: NOW_ISO,
    ...over,
  };
}

const LEGACY_LOCAL: LegacyRoute = { backend: 'builtin' as EngineId, tier: 'local', reason: 'legacy: builtin' };

describe('acceptanceCommandOf', () => {
  it('returns the first usable acceptance: tag, trimmed', () => {
    expect(acceptanceCommandOf(item({ tags: [`${ACCEPTANCE_TAG_PREFIX} npm run typecheck `, `${ACCEPTANCE_TAG_PREFIX}npm test`] })))
      .toBe('npm run typecheck');
  });

  it('returns null when no acceptance: tag is present', () => {
    expect(acceptanceCommandOf(item())).toBeNull();
    expect(acceptanceCommandOf(item({ tags: ['difficulty:high', 'context:150000'] }))).toBeNull();
  });

  it('ignores blank, overlong and control-character tags like missing ones', () => {
    const overlong = `${ACCEPTANCE_TAG_PREFIX}${'x'.repeat(ACCEPTANCE_COMMAND_MAX_CHARS + 1)}`;
    for (const tags of [
      [ACCEPTANCE_TAG_PREFIX],
      [`${ACCEPTANCE_TAG_PREFIX}   `],
      [overlong],
      [`${ACCEPTANCE_TAG_PREFIX}npm test\nnpm run lint`],
      [`${ACCEPTANCE_TAG_PREFIX}npm test\u0000done`],
    ]) {
      expect(acceptanceCommandOf(item({ tags })), JSON.stringify(tags)).toBeNull();
    }
  });
});

describe('emptyRunPrecheck', () => {
  const command = 'npm run typecheck';

  it('closes the job as a no-op only on an exit-0 default-branch run', () => {
    const verdict = emptyRunPrecheck(command, { exitCode: 0, revision: 'a'.repeat(40) });
    expect(verdict).toMatchObject({ kind: 'close-noop', command });
    expect(verdict.reason).toMatch(/already passes on the default branch/);
  });

  it.each<[string, AcceptanceRunResult | null | undefined]>([
    ['fails', { exitCode: 1 }],
    ['fails with a signal-derived code', { exitCode: 130 }],
    ['gave no verdict', { exitCode: null, detail: 'timed out' }],
    ['was not observed', null],
    ['was not wired', undefined],
  ])('launches when the run %s', (_label, run) => {
    const verdict = emptyRunPrecheck(command, run);
    expect(verdict.kind).toBe('launch');
    expect(verdict.reason.length).toBeGreaterThan(0);
  });

  it('launches a job with no declared command even when the run passed', () => {
    expect(emptyRunPrecheck(null, { exitCode: 0 })).toMatchObject({ kind: 'launch' });
  });
});

describe('emptyRunPrechecker', () => {
  it('never asks the runner about a job with no declared command', () => {
    let asked = 0;
    const precheck = emptyRunPrechecker(() => {
      asked += 1;
      return { exitCode: 0 };
    });
    expect(precheck(item()).kind).toBe('launch');
    expect(asked).toBe(0);
    expect(precheck(item({ tags: [`${ACCEPTANCE_TAG_PREFIX}npm test`] })).kind).toBe('close-noop');
    expect(asked).toBe(1);
  });
});

describe('routeWorkItem — the empty-run precheck', () => {
  const tagged = (command = 'npm run typecheck'): WorkItem => item({ tags: [`${ACCEPTANCE_TAG_PREFIX}${command}`] });
  const passing = emptyRunPrechecker(() => ({ exitCode: 0 }));

  it('closes a passing job as a no-op instead of dispatching', () => {
    const route = routeWorkItem(tagged(), LEGACY_LOCAL, ctx([grok(), local()], { emptyRunPrecheck: passing }));
    expect(route.noop).toMatchObject({ kind: 'close-noop', command: 'npm run typecheck' });
    // The park-shaped hold keeps consumers that predate `noop` from launching it.
    expect(route.hold).toMatchObject({ kind: 'park', nextEligibleAt: null });
    expect(route.hold?.reason).toMatch(/already passes on the default branch/);
    expect(route.lane).toBeNull();
    expect(route.seatDecision).toBeNull();
    expect(route.reason).toMatch(/^empty-run precheck: /);
  });

  it('closes a satisfied job even where nothing could route it — it needs no seat', () => {
    // No capacity and no repo identity: a normal route would park either way,
    // but the close is recorded as the no-op it is.
    const noRepo = routeWorkItem(item({ repo: '/tmp/unknown', tags: tagged().tags }), LEGACY_LOCAL, ctx([], { emptyRunPrecheck: passing }));
    expect(noRepo.noop?.kind).toBe('close-noop');
    expect(noRepo.repo).toBeNull();
  });

  it('launches the job when the acceptance run still fails on the default branch', () => {
    const failing = emptyRunPrechecker(() => ({ exitCode: 2 }));
    const route = routeWorkItem(tagged(), LEGACY_LOCAL, ctx([grok()], { emptyRunPrecheck: failing }));
    expect(route.noop).toBeNull();
    expect(route.hold).toBeNull();
    expect(route.backend).toBe('grok-cli');
    expect(route.lane).toBe('grok-cli');
  });

  it('launches the job when it declares no acceptance command', () => {
    const route = routeWorkItem(item(), LEGACY_LOCAL, ctx([grok()], { emptyRunPrecheck: passing }));
    expect(route.noop).toBeNull();
    expect(route.hold).toBeNull();
    expect(route.backend).toBe('grok-cli');
  });

  it('launches the job when no run was observed or the precheck was not wired', () => {
    const unobserved = emptyRunPrechecker(() => null);
    const unrouted = routeWorkItem(tagged(), LEGACY_LOCAL, ctx([grok()], { emptyRunPrecheck: unobserved }));
    expect(unrouted.noop).toBeNull();
    expect(unrouted.backend).toBe('grok-cli');
    // No ctx.emptyRunPrecheck at all: routing is byte-for-byte the old behavior.
    const plain = routeWorkItem(tagged(), LEGACY_LOCAL, ctx([grok()]));
    expect(plain.noop).toBeNull();
    expect(plain.backend).toBe('grok-cli');
  });
});
