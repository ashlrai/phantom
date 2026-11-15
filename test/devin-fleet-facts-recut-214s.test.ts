/**
 * devin-fleet-facts-recut-214s.test.ts — RQ-PHX-DEVINFACTSRECUT214S.
 *
 * Recovers PR #5259's (source head e597b2379948a2e25b15f9171e66559aa8918e1a,
 * which itself preserved PR #5177's 058bf23d fleet-model reporting, adapted to
 * native pricing rules): the overview's `fleetModel` names the resolved model,
 * its origin (config/default) and honest pricing evidence ('not-free' |
 * 'unknown', never 'free'; reporting only, never authorizes execution). Fake
 * deps and fixed clocks; models.json is read from a temp dir. No assertion
 * treats a promotional date as proof of eligibility.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEVIN_CLI_FLEET_DEFAULT_MODEL,
  DEVIN_CLI_PROMOTION_EVIDENCE_BOUNDARY,
  devinCliFleetModelPricing,
  devinCliFleetModelSource,
  devinCliLaneModelEntries,
} from '../src/core/devin/cli-engine.js';
import { devinOverview, type DevinServiceDeps } from '../src/core/devin/service.js';
import { getLaneModelSnapshot } from '../src/core/fleet/lane-models.js';

const BEFORE = new Date(DEVIN_CLI_PROMOTION_EVIDENCE_BOUNDARY - 3_600_000);
const AFTER = new Date(DEVIN_CLI_PROMOTION_EVIDENCE_BOUNDARY + 3_600_000);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'devin-fleet-facts-214s-'));
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

function deps(extra: Partial<DevinServiceDeps> = {}): DevinServiceDeps {
  return {
    config: () => ({ enabled: true }),
    cliProbe: async () => ({ state: 'missing' }),
    laneModels: async () => ({ lanes: [] }),
    now: () => AFTER,
    ...extra,
  };
}

describe('devinOverview fleetModel', () => {
  it('reports configured vs default origin', async () => {
    const configured = await devinOverview(deps({ config: () => ({ enabled: true, fleet: true, fleetModel: 'swe-2-max' }) }));
    expect(configured.fleetModel).toMatchObject({ configured: 'swe-2-max', source: 'config' });
    const fallback = await devinOverview(deps());
    expect(fallback.fleetModel).toMatchObject({ configured: DEVIN_CLI_FLEET_DEFAULT_MODEL, source: 'default' });
  });

  it('ignores a malformed id (source default) and redirects -lightning like launches do', async () => {
    const bad = await devinOverview(deps({ config: () => ({ enabled: true, fleet: true, fleetModel: 'SWE 2!' }) }));
    expect(bad.fleetModel).toMatchObject({ configured: DEVIN_CLI_FLEET_DEFAULT_MODEL, source: 'default' });
    const lightning = await devinOverview(deps({ config: () => ({ enabled: true, fleet: true, fleetModel: 'swe-2-max-lightning' }) }));
    expect(lightning.fleetModel).toMatchObject({ configured: 'swe-2-flash-max', source: 'config' });
  });

  it('pricing is never "free": unknown before the boundary, not-free after', async () => {
    const config = () => ({ enabled: true, fleet: true, fleetModel: 'swe-2-medium' });
    const before = await devinOverview(deps({ config, now: () => BEFORE }));
    expect(before.fleetModel?.pricing).toBe('unknown');
    const after = await devinOverview(deps({ config, now: () => AFTER }));
    expect(after.fleetModel?.pricing).toBe('not-free');
    expect(devinCliFleetModelPricing('swe-2-high', Number.NaN)).toBe('unknown');
    expect(devinCliFleetModelPricing('swe-2-max-lightning', BEFORE.getTime())).toBe('not-free');
  });

  it('source helper mirrors the resolver for blank and non-string values', () => {
    expect(devinCliFleetModelSource(undefined)).toBe('default');
    expect(devinCliFleetModelSource({ enabled: true, fleetModel: '  swe-2-max ' })).toBe('config');
    expect(devinCliFleetModelSource({ enabled: true, fleetModel: '' })).toBe('default');
  });

  it('lists devin* keys from a temp models.json, flags -lightning paid, drops other lanes', async () => {
    await writeFile(join(dir, 'models.json'), JSON.stringify({
      devin: 'swe-2-high', 'devin.fast': 'swe-2-max-lightning', 'devin-flash': 'swe-2-medium',
      claude: 'claude-opus-4-8', 'codex.frontier': 'gpt-5.4-codex',
    }));
    const overview = await devinOverview(deps({ laneModels: () => getLaneModelSnapshot({ runsDir: dir }) }));
    expect(overview.fleetModel?.laneModels).toEqual([
      { key: 'devin', model: 'swe-2-high', paid: false },
      { key: 'devin-flash', model: 'swe-2-medium', paid: false },
      { key: 'devin.fast', model: 'swe-2-max-lightning', paid: true },
    ]);
  });

  it('missing, malformed or failing models metadata is an empty list, never an error', async () => {
    const missing = await devinOverview(deps({ laneModels: () => getLaneModelSnapshot({ runsDir: dir }) }));
    expect(missing.fleetModel?.laneModels).toEqual([]);
    await writeFile(join(dir, 'models.json'), '{ broken');
    const broken = await devinOverview(deps({ laneModels: () => getLaneModelSnapshot({ runsDir: dir }) }));
    expect(broken.fleetModel?.laneModels).toEqual([]);
    const failing = await devinOverview(deps({ laneModels: () => Promise.reject(new Error('unreadable')) }));
    expect(failing.fleetModel?.laneModels).toEqual([]);
    expect(failing.fleetModel?.configured).toBe(DEVIN_CLI_FLEET_DEFAULT_MODEL);
    expect(devinCliLaneModelEntries([])).toEqual([]);
  });
});
