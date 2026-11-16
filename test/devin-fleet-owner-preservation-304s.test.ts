/**
 * devin-fleet-owner-preservation-304s.test.ts — RQ-PHX-DEVINFACTSOWNER304S.
 *
 * Owner-preservation audit of PR #5177 (head 058bf23dc79e) against fresh
 * origin/master. Master consolidated the PR's helpers: `devinCliFleetModelPromo`
 * became `devinCliFleetModelPricing` and the 'free' claim was dropped per the
 * Nov 5 honest-usage order (a model id alone never proves a free route);
 * `devinCliFleetModelSource`, `devinCliLaneModelEntries` and the overview's
 * `fleetModel` row survive under the same names. test/devin-fleet-facts-
 * exact-205s.test.ts and test/devin-fleet-facts-recut-214s.test.ts already
 * cover configured-vs-default source, malformed ids, the -lightning redirect,
 * boundary-adjacent pricing and models.json lane keys. This file adds only
 * the overview-level invariants those suites do not assert:
 *
 *  - a rejecting lane-models read keeps the CONFIGURED model, source and
 *    pricing (existing coverage checks only the default-config case) and the
 *    read is attempted exactly once — reporting never escalates to a launch
 *    or a CLI catalog probe;
 *  - lane keys are deterministic through devinOverview: sorted by key with
 *    first-`via`-wins dedup across unordered injected devin lanes;
 *  - the evidence boundary is exact: AT the boundary pricing is 'not-free',
 *    one millisecond before it is 'unknown'.
 *
 * Hermetic: injected deps and fixed clocks only; no Devin process, API or
 * billing probe. HOME is isolated by test/setup/home.ts.
 */
import { describe, expect, it, vi } from 'vitest';

import { DEVIN_CLI_FLEET_DEFAULT_MODEL, DEVIN_CLI_PROMOTION_EVIDENCE_BOUNDARY } from '../src/core/devin/cli-engine.js';
import { devinOverview, type DevinServiceDeps } from '../src/core/devin/service.js';
import type { LaneModelSnapshot } from '../src/core/fleet/lane-models.js';

const AFTER = new Date(DEVIN_CLI_PROMOTION_EVIDENCE_BOUNDARY + 3_600_000);

type InjectedLanes = Pick<LaneModelSnapshot, 'lanes'>;

function deps(extra: Partial<DevinServiceDeps> = {}): DevinServiceDeps {
  return {
    config: () => ({ enabled: true }),
    cliProbe: async () => ({ state: 'missing' }),
    laneModels: async () => ({ lanes: [] }),
    now: () => AFTER,
    ...extra,
  };
}

describe('devinOverview fleetModel — owner preservation invariants (PR #5177)', () => {
  it('a rejecting lane-models read keeps the configured model, source and pricing; the read runs once and nothing launches', async () => {
    const laneModels = vi.fn(async (): Promise<InjectedLanes> => { throw new Error('unreadable'); });
    // A catalog probe would only run for a non-missing CLI; counting it proves
    // the reporting row never escalates into a CLI/API path.
    const modelCatalog = vi.fn(async () => { throw new Error('must not be called'); });

    const overview = await devinOverview(deps({
      config: () => ({ enabled: true, fleet: true, fleetModel: 'swe-2-max' }),
      laneModels,
      modelCatalog,
    }));

    expect(laneModels).toHaveBeenCalledTimes(1);
    expect(modelCatalog).not.toHaveBeenCalled();
    expect(overview.fleetModel).toEqual({
      configured: 'swe-2-max',
      source: 'config',
      pricing: 'not-free',
      laneModels: [],
    });
    // The rest of the overview is unaffected: no fabricated evidence, CLI state intact.
    expect(overview.cli).toEqual({ state: 'missing', usage: 'not-reported' });
    expect(overview.models).toBeUndefined();
  });

  it('lane keys are sorted with first-via-wins dedup across unordered devin lanes', async () => {
    const laneModels = async (): Promise<InjectedLanes> => ({
      lanes: [
        {
          lane: 'devin-zeta', family: 'devin-zeta', lastLaunch: null, mismatch: false,
          tiers: [
            { tier: 'frontier', model: 'swe-2-high', via: 'devin.z' },
            { tier: 'work', model: 'swe-2-medium', via: 'devin' },
          ],
        },
        {
          lane: 'devin', family: 'devin', lastLaunch: null, mismatch: false,
          tiers: [
            { tier: 'frontier', model: 'swe-2-max', via: 'devin' },
            { tier: 'work', model: 'swe-2-medium', via: 'devin.work' },
          ],
        },
        {
          lane: 'claude', family: 'claude', lastLaunch: null, mismatch: false,
          tiers: [{ tier: 'frontier', model: 'claude-opus-4-8', via: 'claude' }],
        },
      ],
    });

    const overview = await devinOverview(deps({ laneModels }));

    // 'devin' was first resolved by devin-zeta's work tier (swe-2-medium) and is
    // not overwritten by devin's own frontier row; keys come out sorted.
    expect(overview.fleetModel?.laneModels).toEqual([
      { key: 'devin', model: 'swe-2-medium', paid: false },
      { key: 'devin.work', model: 'swe-2-medium', paid: false },
      { key: 'devin.z', model: 'swe-2-high', paid: false },
    ]);
    // The fleet model row is independent of lane metadata: still the default.
    expect(overview.fleetModel?.configured).toBe(DEVIN_CLI_FLEET_DEFAULT_MODEL);
    expect(overview.fleetModel?.source).toBe('default');
  });

  it('the evidence boundary is exact: at it pricing is not-free, one ms before it is unknown', async () => {
    const config = () => ({ enabled: true, fleet: true, fleetModel: 'swe-2-medium' });
    const at = await devinOverview(deps({ config, now: () => new Date(DEVIN_CLI_PROMOTION_EVIDENCE_BOUNDARY) }));
    expect(at.fleetModel?.pricing).toBe('not-free');
    const before = await devinOverview(deps({ config, now: () => new Date(DEVIN_CLI_PROMOTION_EVIDENCE_BOUNDARY - 1) }));
    expect(before.fleetModel?.pricing).toBe('unknown');
  });
});
