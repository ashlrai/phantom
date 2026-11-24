/**
 * CAP-REMOVAL-1: seat reserve and session window, size vs risk, the local
 * bound, and the four added repos. Reserve 0 never authorizes paid overage.
 */
import { describe, expect, it } from 'vitest';

import { CAP_POLICY, configuredGrantLifetimeMs, configuredLocalEnforcementRisk, reserveEnablesPaidOverage } from '../src/core/authority/cap-policy.js';
import { applyGrantScopeEdit } from '../src/core/authority/grant-scope.js';
import { isSpendCeilingPath } from '../src/core/authority/spend-ceiling.js';
import { buildDefaultGrantPayload } from '../src/core/authority/standing-grant.js';
import { STANDING_GRANT_CEILINGS } from '../src/core/authority/types.js';
import { evaluateG1, evaluateG2 } from '../src/core/fleet/merge-gates.js';
import { classifyRisk } from '../src/core/inbox/merge.js';
import { assessSeat, type SeatCapacity } from '../src/core/routing/headroom.js';
import type { Proposal } from '../src/core/types.js';
import { makeGrant, TEST_HOST, TEST_KEY_ID, TEST_SURFACE } from './helpers/authority-310b.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');

function fileDiff(path: string, lines: number): string {
  const body = Array.from({ length: lines }, (_, i) => `+line ${i}`).join('\n');
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${lines} @@`,
    body,
    '',
  ].join('\n');
}

function draft(repos: { nameWithOwner: string; hasVerify?: boolean }[]) {
  return buildDefaultGrantPayload({
    nowMs: NOW,
    grantId: 'f'.repeat(32),
    grantSeq: 7,
    keyId: TEST_KEY_ID,
    hostBinding: TEST_HOST,
    authoritySurfaceDigest: TEST_SURFACE,
    repos: repos.map((repo) => ({
      nameWithOwner: repo.nameWithOwner,
      visibility: 'public' as const,
      hasVerify: repo.hasVerify ?? true,
      serverEnforcement: 'enforced' as const,
    })),
    seats: [{ seatId: 'claude', engine: 'claude' as const }],
  });
}

describe('CAP-REMOVAL-1', () => {
  it('defaults reserve to 0 and the session window to 100, with no paid overage', () => {
    const grant = draft([{ nameWithOwner: 'ashlrai/ashlrcode' }]);
    expect(grant.spend.meteredUsdPerDay).toBe(0);
    expect(grant.spend.seats['claude']).toMatchObject({ reserveFloorPercent: 0, maxSessionWindowPercent: 100 });
    expect(reserveEnablesPaidOverage(0)).toBe(false);
    expect(reserveEnablesPaidOverage(40)).toBe(false);
    const raised = applyGrantScopeEdit(grant, { reserveFloorPercent: 0, meteredUsdPerDay: 5 });
    expect(raised.ok).toBe(false);
    if (!raised.ok) expect(raised.reason).toMatch(/paid overage/);
    const kept = applyGrantScopeEdit(grant, { reserveFloorPercent: 0, maxSessionWindowPercent: 100 });
    expect(kept.ok).toBe(true);
    if (kept.ok) expect(kept.payload.spend.meteredUsdPerDay).toBe(0);
  });

  it('keeps the 30-day lifetime and the low local-enforcement risk as config', () => {
    expect(configuredGrantLifetimeMs()).toBe(STANDING_GRANT_CEILINGS.maxTtlMs);
    expect(configuredGrantLifetimeMs()).toBe(30 * 24 * 60 * 60 * 1000);
    expect(configuredLocalEnforcementRisk()).toBe('low');
    expect(CAP_POLICY.localAuthoredMaxFiles).toBe(4);
    expect(CAP_POLICY.localAuthoredMaxLines).toBe(150);
    expect(STANDING_GRANT_CEILINGS.localAuthored).toMatchObject({ maxFiles: 4, maxLines: 150, maxRisk: 'low' });
  });

  it('takes size out of classifyRisk and keeps path rules high', () => {
    const wide = Array.from({ length: 12 }, (_, i) => fileDiff(`src/part-${i}.ts`, 40)).join('');
    expect(classifyRisk({ diff: wide } as Proposal)).toBe('medium');
    expect(classifyRisk({ diff: fileDiff('src/auth/session.ts', 1) } as Proposal)).toBe('high');
    expect(classifyRisk({ diff: fileDiff('.github/workflows/ci.yml', 1) } as Proposal)).toBe('high');
    expect(classifyRisk({ diff: fileDiff('scripts/deploy.sh', 1) } as Proposal)).toBe('high');
    const caps = evaluateG2({
      partial: false,
      provenance: { ok: true },
      risk: 'medium',
      scope: { files: 12, changedLines: 480 },
      repoPolicy: {
        nameWithOwner: 'ashlrai/ashlrcode',
        stage: 'merge',
        enforcement: 'server',
        maxRisk: 'medium',
        maxFiles: 10,
        maxLines: 300,
        maxMergesPerDay: 12,
        selfRepo: null,
      },
      mergePolicy: { maxFiles: 10, maxLines: 300, selfRepo: 'merge-non-authority', localAuthored: { maxRisk: 'low', maxFiles: 4, maxLines: 150 } },
      config: {},
      producerLocal: false,
    });
    expect(caps.verdict).toBe('refuse');
    expect(caps.code).toBe('files-over-cap');
  });

  it('adds the four repos and refuses ashlr-cost spend-ceiling edits', () => {
    const grant = draft([
      { nameWithOwner: 'ashlrai/ashlr-auth' },
      { nameWithOwner: 'ashlrai/ashlr-config' },
      { nameWithOwner: 'ashlrai/ashlr-cost' },
      { nameWithOwner: 'ashlrai/ashlr-core-efficiency', hasVerify: false },
    ]);
    const byName = new Map(grant.repos.map((repo) => [repo.nameWithOwner, repo]));
    expect(byName.get('ashlrai/ashlr-auth')).toMatchObject({ maxRisk: 'low', stage: 'merge' });
    expect(byName.get('ashlrai/ashlr-config')).toMatchObject({ maxRisk: 'medium', stage: 'merge' });
    expect(byName.get('ashlrai/ashlr-cost')).toMatchObject({ maxRisk: 'medium', stage: 'merge' });
    expect(byName.get('ashlrai/ashlr-core-efficiency')).toMatchObject({ stage: 'propose' });
    expect(isSpendCeilingPath('ashlrai/ashlr-cost', 'src/spend-ceiling.ts')).toBe(true);
    expect(isSpendCeilingPath('ashlrai/ashlr-cost', 'src/format.ts')).toBe(false);
    expect(isSpendCeilingPath('ashlrai/ashlr-auth', 'src/spend-ceiling.ts')).toBe(false);
    const gate = evaluateG1({ paths: ['src/format.ts', 'src/spend-ceiling.ts'], selfRepo: false, repo: 'ashlrai/ashlr-cost' });
    expect(gate.verdict).toBe('owner-lane');
    expect(gate.code).toBe('protected-spend-ceiling');
    expect(evaluateG1({ paths: ['src/spend-ceiling.ts'], selfRepo: false, repo: 'ashlrai/ashlr-config' }).verdict).toBe('pass');
  });

  it('blocks on-demand billing when the reserve is 0', () => {
    const capacity: SeatCapacity = {
      seatId: 'claude',
      engine: 'claude',
      label: 'Claude',
      free: false,
      windows: [
        { id: 'five_hour', usedPercent: 10, resetsAt: null, resetDescription: null, limitReached: false },
        { id: 'seven_day', usedPercent: 10, resetsAt: null, resetDescription: null, limitReached: false },
      ],
      signedOut: false,
      reachable: true,
      contextWindow: 200_000,
      observedAt: new Date(NOW).toISOString(),
      spentTodayUsd: 0,
      onDemandEnabled: true,
    };
    const assessed = assessSeat(capacity, { seatId: 'claude', enabled: true, reservePercent: 0, maxSessionWindowPercent: 100 }, { nowMs: NOW });
    expect(assessed.headroom.eligibleForAutonomy).toBe(false);
    expect(assessed.headroom.reasons.join(' ')).toMatch(/paid overage/);
    const included = assessSeat({ ...capacity, onDemandEnabled: false }, { seatId: 'claude', enabled: true, reservePercent: 0, maxSessionWindowPercent: 100 }, { nowMs: NOW });
    expect(included.headroom.eligibleForAutonomy).toBe(true);
  });

  it('a fixture grant can still lower one seat to reserve 0 without raising metered spend', () => {
    const current = makeGrant();
    const result = applyGrantScopeEdit(current, { seatPolicies: { claude: { reserveFloorPercent: 0 } }, meteredUsdPerDay: 1 });
    expect(result.ok).toBe(false);
  });
});
