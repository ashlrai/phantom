/**
 * routing-bandit.test.ts - RQ-OT-P1-BANDIT: contextual Thompson sampler over
 * the routing arm registry (src/core/routing/arms.ts + bandit.ts), wired into
 * run/router.ts routeTask behind cfg.router.bandit (default off).
 *
 * Mirrors m128/routing-arms conventions: vi.mock the quota/subscription/engine
 * boundaries before importing the router; HOME is already relocated by
 * test/setup/home.ts, so the default arm registry path resolves under a
 * scratch ~/.ashlr.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Route boundary mocks - must hoist before the router import (m128 pattern).
// ---------------------------------------------------------------------------

vi.mock('../src/core/run/engines.js', () => ({
  engineInstalled: vi.fn(() => true),
  engineTierOf: (engine: string) => {
    if (engine === 'claude' || engine === 'codex') return 'frontier';
    if (engine === 'local-coder' || engine === 'nim') return 'mid';
    return 'local';
  },
}));

vi.mock('../src/core/run/sandboxed-engine.js', () => ({
  engineTierOf: (engine: string) => {
    if (engine === 'claude' || engine === 'codex') return 'frontier';
    if (engine === 'local-coder' || engine === 'nim') return 'mid';
    return 'local';
  },
}));

vi.mock('../src/core/fleet/quota.js', () => ({
  withinLimit: vi.fn(() => true),
  evalQuota: vi.fn(() => 'ok'),
  recordUse: vi.fn(),
}));

vi.mock('../src/core/fleet/subscription-usage.js', () => ({
  subscriptionAllows: vi.fn(() => ({ allowed: true, reason: 'mock: within limit' })),
  isSubscriptionEngine: vi.fn((e: string) => e === 'claude' || e === 'codex'),
  subscriptionUsage: vi.fn(() => null),
}));

import type { AshlrConfig, WorkItem, WorkSource } from '../src/core/types.js';
import {
  armKey,
  armPrior,
  armRegistryPath,
  loadArmRegistry,
  saveArmRegistry,
  updateArm,
  type ArmRegistry,
} from '../src/core/routing/arms.js';
import {
  banditContextLabel,
  banditReward,
  contextualArmKey,
  createSeededRng,
  recordOutcome,
  sanitizeContextPart,
  selectArm,
  updateArmWeighted,
} from '../src/core/routing/bandit.js';
import { routeTask, type RoutingContext } from '../src/core/run/router.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ctx = { tier: 'work', repo: 'phantom', diffClass: 'medium' };
const armA = { provider: 'claude', model: 'sonnet-5', effort: 'medium' };
const armB = { provider: 'codex', model: 'gpt-6.1-terra', effort: 'medium' };
const armC = { provider: 'local-coder', model: 'qwen2.5:72b', effort: 'medium' };

function baseConfig(): AshlrConfig {
  return {
    version: 1,
    roots: [homedir()],
    editor: { name: 'vscode' },
    models: { providerChain: ['ollama'], routing: [] },
  } as unknown as AshlrConfig;
}

let _seq = 0;
function makeItem(over: Partial<WorkItem> & { source: WorkSource }): WorkItem {
  _seq++;
  return {
    id: `bandit-item-${_seq}`,
    repo: '/mock/repo',
    title: 'mock task',
    detail: 'mock detail',
    value: 3,
    effort: 3,
    score: 5,
    tags: [],
    ts: new Date(0).toISOString(),
    ...over,
  } as WorkItem;
}

const ROUTE_CTX: RoutingContext = {
  availableEngines: ['claude', 'codex', 'nim', 'local-coder', 'builtin'],
};

// ---------------------------------------------------------------------------
// Key encoding and sanitization
// ---------------------------------------------------------------------------

describe('contextualArmKey', () => {
  it('keeps the plain arm key as a prefix and stays registry-compatible', () => {
    const key = contextualArmKey(armA, ctx);
    expect(key.startsWith(`${armKey(armA)}.`)).toBe(true);
    expect(key).toBe('claude:sonnet-5:medium.work.phantom.medium');
    // loadArmRegistry validates every stored key with parseArmKey; a
    // contextual key must satisfy it, otherwise the one-store design fails.
    const registry: ArmRegistry = new Map([[key, armPrior()]]);
    const dir = mkdtempSync(join(tmpdir(), 'bandit-'));
    try {
      const file = join(dir, 'arms.json');
      saveArmRegistry(registry, file);
      expect(loadArmRegistry(file)).toEqual(registry);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sanitizes model tags and repo paths that armKey alone would reject', () => {
    // 'qwen2.5:72b' contains ':' and '/a b/My Repo' contains slashes/spaces;
    // the key is an address, so both are folded into the store alphabet.
    const key = contextualArmKey(armC, { tier: 'Work', repo: '/a b/My Repo', diffClass: 'Large' });
    expect(key).toBe('local-coder:qwen2.5-72b:medium.work.a-b-my-repo.large');
    expect(() => armKey(armC)).toThrow(); // proves the sanitizer is required
    expect(sanitizeContextPart('')).toBe('x');
    expect(sanitizeContextPart('___')).toBe('x');
  });
});

// ---------------------------------------------------------------------------
// Reward + weighted posterior update
// ---------------------------------------------------------------------------

describe('reward and updateArmWeighted', () => {
  it('computes merged x impact / allowance, zero for unmerged', () => {
    expect(banditReward({ merged: true, allowanceSpent: 2, impact: 3 })).toBeCloseTo(1.5);
    expect(banditReward({ merged: true, allowanceSpent: 2 })).toBeCloseTo(0.5); // impact absent => 1
    expect(banditReward({ merged: false, allowanceSpent: 2, impact: 9 })).toBe(0);
    expect(banditReward({ merged: true, allowanceSpent: 0, impact: 1 })).toBeGreaterThan(0);
    expect(() => banditReward({ merged: true, allowanceSpent: -1 })).toThrow();
    expect(() => banditReward({ merged: true, allowanceSpent: 1, impact: 0 })).toThrow();
  });

  it('is byte-identical to updateArm at weight 1 and scales alpha by impact', () => {
    const p = armPrior();
    expect(updateArmWeighted(p, true, 2, 1)).toEqual(updateArm(p, true, 2));
    expect(updateArmWeighted(p, false, 2, 4)).toEqual(updateArm(p, false, 2));
    const boosted = updateArmWeighted(p, true, 2, 3);
    expect(boosted.merge.alpha).toBeCloseTo(4); // 1 prior + 3 impact-weighted
    expect(boosted.merge.beta).toBeCloseTo(1);
    expect(boosted.cost).toEqual({ shape: 2, rate: 3 }); // 1 prior + observed 2
    expect(() => updateArmWeighted(p, true, 2, -1)).toThrow();
    expect(() => updateArmWeighted(p, true, -2, 1)).toThrow();
  });

  it('partitions posteriors by context and never touches a cold key', () => {
    const registry: ArmRegistry = new Map();
    recordOutcome(registry, ctx, armA, { merged: true, allowanceSpent: 1 });
    const other = { ...ctx, repo: 'other-repo' };
    expect(registry.has(contextualArmKey(armA, other))).toBe(false);
    const before = registry.get(contextualArmKey(armA, ctx))!;
    selectArm(registry, other, [armA, armB], createSeededRng('s'));
    expect(registry.get(contextualArmKey(armA, ctx))).toEqual(before); // selection is read-only
    expect(registry.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Seeded sampler determinism + convergence
// ---------------------------------------------------------------------------

describe('selectArm', () => {
  it('is deterministic for a fixed seed, registry and candidate set', () => {
    const registry: ArmRegistry = new Map();
    recordOutcome(registry, ctx, armA, { merged: true, allowanceSpent: 1 });
    recordOutcome(registry, ctx, armB, { merged: false, allowanceSpent: 3 });
    const candidates = [armA, armB, armC];
    const first = selectArm(registry, ctx, candidates, createSeededRng('seed-1'));
    for (let i = 0; i < 10; i++) {
      expect(selectArm(registry, ctx, candidates, createSeededRng('seed-1'))).toEqual(first);
    }
    // Shuffled candidate order samples the same rng stream in sorted key
    // order, so the pick is order-independent too.
    expect(selectArm(registry, ctx, [...candidates].reverse(), createSeededRng('seed-1'))).toEqual(first);
  });

  it('explores cold arms and returns null only for an empty candidate set', () => {
    const registry: ArmRegistry = new Map();
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const pick = selectArm(registry, ctx, [armA, armB, armC], createSeededRng(`explore-${i}`));
      seen.add(contextualArmKey(pick!.arm, ctx));
    }
    expect(seen.size).toBeGreaterThan(1); // not pinned to the first candidate
    expect(selectArm(registry, ctx, [], createSeededRng('x'))).toBeNull();
  });

  it('converges to the better arm on synthetic merge outcomes', () => {
    const registry: ArmRegistry = new Map();
    for (let i = 0; i < 60; i++) {
      recordOutcome(registry, ctx, armA, { merged: true, allowanceSpent: 1 });
      recordOutcome(registry, ctx, armB, { merged: false, allowanceSpent: 1 });
    }
    let wins = 0;
    const seeds = 400;
    for (let i = 0; i < seeds; i++) {
      if (selectArm(registry, ctx, [armA, armB], createSeededRng(`conv-${i}`))!.arm === armA) wins++;
    }
    expect(wins / seeds).toBeGreaterThan(0.97);
  });

  it('converges to the cheaper arm when allowance spent is the difference', () => {
    const registry: ArmRegistry = new Map();
    for (let i = 0; i < 40; i++) {
      recordOutcome(registry, ctx, armA, { merged: true, allowanceSpent: 100 });
      recordOutcome(registry, ctx, armB, { merged: true, allowanceSpent: 1 });
    }
    // Equal merge evidence; the gamma cost channel (reward / allowance) must
    // carry the pick to the arm that spent less plan-allowance per merge.
    let wins = 0;
    const seeds = 400;
    for (let i = 0; i < seeds; i++) {
      if (selectArm(registry, ctx, [armA, armB], createSeededRng(`cheap-${i}`))!.arm === armB) wins++;
    }
    expect(wins / seeds).toBeGreaterThan(0.97);
  });

  it('learns each context independently: the same arm can win here and lose there', () => {
    const registry: ArmRegistry = new Map();
    const other = { ...ctx, repo: 'other-repo' };
    for (let i = 0; i < 60; i++) {
      recordOutcome(registry, ctx, armA, { merged: true, allowanceSpent: 1 });
      recordOutcome(registry, other, armA, { merged: false, allowanceSpent: 1 });
      recordOutcome(registry, other, armB, { merged: true, allowanceSpent: 1 });
      recordOutcome(registry, ctx, armB, { merged: false, allowanceSpent: 1 });
    }
    expect(selectArm(registry, ctx, [armA, armB], createSeededRng('s'))!.arm).toEqual(armA);
    expect(selectArm(registry, other, [armA, armB], createSeededRng('s'))!.arm).toEqual(armB);
  });
});

// ---------------------------------------------------------------------------
// routeTask wiring: flag off is byte-identical, flag on samples constrained arms
// ---------------------------------------------------------------------------

describe('routeTask + router.bandit', () => {
  const trivialDoc = () => makeItem({ source: 'doc', effort: 1, score: 2, title: 'update docs' });
  const hardGoal = () => makeItem({ source: 'goal', effort: 5, score: 9, title: 'redesign the router' });
  const mediumTodo = () => makeItem({ source: 'todo', effort: 3, score: 5, title: 'implement the thing' });

  it('flag off and absent flag keep the current routes', () => {
    const base = baseConfig();
    for (const item of [trivialDoc(), hardGoal(), mediumTodo()]) {
      const off = routeTask(item, { ...base, router: { bandit: false } }, ROUTE_CTX);
      const absent = routeTask(item, base, ROUTE_CTX);
      expect(off).toEqual(absent);
      expect(off.reason).not.toContain('bandit[');
    }
    // A concrete route pins that the comparison was not vacuous.
    expect(routeTask(trivialDoc(), baseConfig(), ROUTE_CTX).engine).toBe('local-coder');
  });

  it('flag on returns a permitted, deterministic, catalog-consistent decision', () => {
    const cfg = { ...baseConfig(), router: { bandit: true } };
    const item = mediumTodo();
    const decision = routeTask(item, cfg, ROUTE_CTX);
    expect(decision.reason).toContain('bandit[');
    expect(ROUTE_CTX.availableEngines).toContain(decision.engine);
    if (decision.catalogEntry) {
      expect(decision.catalogEntry.engine).toBe(decision.engine);
      expect(decision.catalogEntry.historical ?? false).toBe(false);
      expect(decision.catalogEntry.explicitOnly ?? false).toBe(false);
    }
    expect(routeTask(item, cfg, ROUTE_CTX)).toEqual(decision); // seeded by item.id
    // A different item id may sample a different arm, but stays admitted.
    const other = routeTask({ ...item, id: 'bandit-item-other' }, cfg, ROUTE_CTX);
    expect(ROUTE_CTX.availableEngines).toContain(other.engine);
  });

  it('flag on with no admitted engines falls back to the static route', () => {
    const item = mediumTodo();
    const base = routeTask(item, baseConfig(), { availableEngines: [] });
    const on = routeTask(item, { ...baseConfig(), router: { bandit: true } }, { availableEngines: [] });
    expect(on).toEqual(base);
  });

  it('a corrupt arm registry disables the bandit instead of dispatching', () => {
    const file = armRegistryPath();
    mkdirSync(dirname(file), { recursive: true });
    // An unreadable snapshot under the relocated HOME: loadArmRegistry
    // rejects it and routeTaskBandit must degrade to the static route.
    writeFileSync(file, '{broken');
    try {
      const item = mediumTodo();
      const off = routeTask(item, baseConfig(), ROUTE_CTX);
      const on = routeTask(item, { ...baseConfig(), router: { bandit: true } }, ROUTE_CTX);
      expect(on).toEqual(off);
      expect(on.reason).not.toContain('bandit[');
    } finally {
      rmSync(file, { force: true });
    }
  });

  it('a trained registry steers the route to the better arm', () => {
    // Record merges for codex:gpt-6.1-terra under this item's context at a
    // near-zero allowance cost, so its sampled reward-per-allowance dominates
    // any cold prior. Context mirrors banditContextFor(mediumTodo()):
    // tier=work, repo='repo', diffClass='medium'.
    const registry: ArmRegistry = new Map();
    const banditCtx = { tier: 'work', repo: 'repo', diffClass: 'medium' };
    for (let i = 0; i < 120; i++) {
      recordOutcome(registry, banditCtx, armB, { merged: true, allowanceSpent: 0.001 });
    }
    const file = armRegistryPath();
    try {
      saveArmRegistry(registry); // under relocated HOME/.ashlr/routing/arms.json
      const cfg = { ...baseConfig(), router: { bandit: true } };
      const decision = routeTask(mediumTodo(), cfg, ROUTE_CTX);
      expect(decision.reason).toContain('bandit[');
      expect(decision.engine).toBe('codex');
      expect(decision.model).toBe('gpt-6.1-terra');
    } finally {
      rmSync(file, { force: true });
    }
  });
});

describe('banditContextLabel', () => {
  it('renders a stable sanitized label for decision reasons', () => {
    expect(banditContextLabel(ctx)).toBe('work/phantom/medium');
  });
});
