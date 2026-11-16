import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { AppUpdateStatus } from '../src/core/app-update-status.js';
import { readUpdatePhase, updatePhaseFromStatus } from '../src/core/world/update-phase.js';
import { clearWorldCacheForTests, readWorldModel } from '../src/core/world/read.js';

/**
 * RQ-PHX-REDTESTFIXN1S131 — regression cover for the failure that blocked
 * PR #4987: the recovered update-phase reader entered the world read path
 * through a new module, which grew the Tier-1 authority import closure
 * without a reviewed snapshot update (authority-tier1-closure-310b).
 * These cases exercise the same path through the real exported functions
 * and pin the closure coverage that gate expects.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const installed: AppUpdateStatus = {
  current: '3.30.8', available: null, deferredReason: null,
  runningJobs: null, runningJobCount: null, unknownJobs: null,
};

const base = {
  nowMs: Date.parse('2026-11-11T00:00:00.000Z'),
  humanStepsFile: '/nonexistent/redtest-s131-steps', bottlenecksFile: '/nonexistent/redtest-s131-blocks',
  pulls: [], loadRoster: async () => undefined, loadSensors: async () => undefined,
  readClaims: () => ({ source: 'missing' as const, claims: [] }),
} as const;

describe('redtest-s131: update phase recovery reaches the world model through real exports', () => {
  it('maps installed status to ok and missing status to unknown', () => {
    expect(updatePhaseFromStatus(installed)).toBe('ok');
    expect(updatePhaseFromStatus({ ...installed, current: null })).toBe('unknown');
  });

  it('degrades to unknown when the status read throws', () => {
    expect(readUpdatePhase(() => { throw new Error('no desktop bridge'); })).toBe('unknown');
  });

  it('threads an injected reader through readWorldModel into the updateCheck field', async () => {
    clearWorldCacheForTests();
    const readPhase = vi.fn(() => 'ok' as const);
    const model = await readWorldModel({ ...base, readUpdatePhase: readPhase });
    expect(readPhase).toHaveBeenCalledOnce();
    expect(model.releases.updateCheck).toMatchObject({ value: 'ok', freshness: 'fresh' });
  });

  it('keeps the feature\'s gate-reachable modules inside the Tier-1 closure snapshot', () => {
    const snapshot = JSON.parse(readFileSync(join(ROOT, 'test/fixtures/authority/tier1-closure.json'), 'utf8')) as {
      closure: string[];
    };
    // Every runtime file this feature adds to the authority-reachable import
    // graph must be snapshot-tracked; the tier1-closure test enforces no
    // unreviewed growth on top of these members.
    for (const file of ['src/core/world/read.ts', 'src/core/app-update-status.ts']) {
      expect(snapshot.closure, `${file} left the Tier-1 closure`).toContain(file);
    }
  });
});
