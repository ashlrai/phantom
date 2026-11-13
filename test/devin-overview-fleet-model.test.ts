/**
 * devin-overview-fleet-model.test.ts — the overview's `fleetModel` field
 * (RQ-PHX-DEVINFLEETMODEL89): the model the fleet's Devin lane resolves to
 * and whether it came from `devin.fleetModel`, the promotional reading taken
 * only from isDevinCliFreeModel at a fixed clock, and models.json's `devin*`
 * keys with `-lightning` flagged paid. The lane-model read is the real
 * fleet/lane-models.ts snapshot over a temp dir; a missing or unreadable
 * models.json is an empty list, never an error.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEVIN_CLI_PROMOTION_EVIDENCE_BOUNDARY } from '../src/core/devin/cli-engine.js';
import { devinOverview, type DevinServiceDeps } from '../src/core/devin/service.js';
import { getLaneModelSnapshot } from '../src/core/fleet/lane-models.js';

const BEFORE = DEVIN_CLI_PROMOTION_EVIDENCE_BOUNDARY - 3_600_000;
const AFTER = DEVIN_CLI_PROMOTION_EVIDENCE_BOUNDARY + 3_600_000;
const NO_LANES = async () => ({ lanes: [] });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'devin-fleet-model-'));
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

function deps(extra: Partial<DevinServiceDeps> = {}): DevinServiceDeps {
  return {
    config: () => ({ enabled: true }),
    cliProbe: async () => ({ state: 'missing' }),
    laneModels: NO_LANES,
    ...extra,
  };
}

describe('devinOverview fleetModel', () => {
  it('names the configured model and its source; unset config is the compiled default', async () => {
    const configured = await devinOverview(deps({
      config: () => ({ enabled: true, fleet: true, fleetModel: 'swe-2-max' }),
      now: () => new Date(AFTER),
    }));
    expect(configured.fleetModel).toMatchObject({ configured: 'swe-2-max', source: 'config' });

    const fallback = await devinOverview(deps({ now: () => new Date(AFTER) }));
    expect(fallback.fleetModel).toMatchObject({ configured: 'swe-2-high', source: 'default' });
  });

  it('a -lightning config resolves to swe-2-flash-max; promo follows isDevinCliFreeModel across the boundary', async () => {
    const config = () => ({ enabled: true, fleet: true, fleetModel: 'swe-2-max-lightning' });
    const before = await devinOverview(deps({ config, now: () => new Date(BEFORE) }));
    // swe-2-flash-max is not on the free list; pre-boundary it stays unknown — never claimed free.
    expect(before.fleetModel).toMatchObject({ configured: 'swe-2-flash-max', source: 'config', promo: 'unknown' });
    const after = await devinOverview(deps({ config, now: () => new Date(AFTER) }));
    expect(after.fleetModel).toMatchObject({ configured: 'swe-2-flash-max', source: 'config', promo: 'not-free' });
  });

  it('promo is free only on isDevinCliFreeModel’s answer, and never after the boundary', async () => {
    const config = () => ({ enabled: true, fleet: true, fleetModel: 'swe-2-medium' });
    expect((await devinOverview(deps({ config, now: () => new Date(BEFORE) }))).fleetModel?.promo).toBe('free');
    expect((await devinOverview(deps({ config, now: () => new Date(AFTER) }))).fleetModel?.promo).toBe('not-free');
  });

  it('reads devin* keys from a temp models.json and flags the paid one', async () => {
    await writeFile(join(dir, 'models.json'), JSON.stringify({
      devin: 'swe-2-high', 'devin.fast': 'swe-2-max-lightning', 'devin-flash': 'swe-2-medium',
      claude: 'claude-opus-4-8', 'codex.frontier': 'gpt-5.4-codex',
    }));
    const overview = await devinOverview(deps({
      now: () => new Date(AFTER),
      laneModels: () => getLaneModelSnapshot({ runsDir: dir }),
    }));
    expect(overview.fleetModel?.laneModels).toEqual([
      { key: 'devin', model: 'swe-2-high', paid: false },
      { key: 'devin-flash', model: 'swe-2-medium', paid: false },
      { key: 'devin.fast', model: 'swe-2-max-lightning', paid: true },
    ]);
  });

  it('missing or unreadable models.json is an empty lane list, not an error', async () => {
    // No models.json written under the temp runs dir.
    const missing = await devinOverview(deps({
      now: () => new Date(AFTER),
      laneModels: () => getLaneModelSnapshot({ runsDir: dir }),
    }));
    expect(missing.fleetModel?.laneModels).toEqual([]);

    await writeFile(join(dir, 'models.json'), '{ broken');
    const degraded = await devinOverview(deps({
      now: () => new Date(AFTER),
      laneModels: () => getLaneModelSnapshot({ runsDir: dir }),
    }));
    expect(degraded.fleetModel?.laneModels).toEqual([]);

    const failing = await devinOverview(deps({
      now: () => new Date(AFTER),
      laneModels: () => Promise.reject(new Error('unreadable')),
    }));
    expect(failing.fleetModel?.laneModels).toEqual([]);
    expect(failing.fleetModel?.configured).toBe('swe-2-high');
  });
});
