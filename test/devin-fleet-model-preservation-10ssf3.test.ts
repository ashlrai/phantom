// #4768 preservation: real overview over a fake models.json at fixed clocks either side of the
// evidence boundary; missing evidence never becomes free, -lightning stays refused, old UI shape holds.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEVIN_CLI_PROMOTION_EVIDENCE_BOUNDARY, devinCliFleetModelPromo } from '../src/core/devin/cli-engine.js';
import { devinOverview } from '../src/core/devin/service.js';
import { getLaneModelSnapshot } from '../src/core/fleet/lane-models.js';
import { devinFleetModelEvidence } from '../src/web-ui/routes/verse/devin/devin-model.js';
const BEFORE = new Date(DEVIN_CLI_PROMOTION_EVIDENCE_BOUNDARY - 60_000);
const AFTER = new Date(DEVIN_CLI_PROMOTION_EVIDENCE_BOUNDARY + 60_000);
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'devin-fm-10ssf3-')); });
afterEach(async () => rm(dir, { recursive: true, force: true }));

const overview = (fleetModel: string, now: Date) => devinOverview({
  config: () => ({ enabled: true, fleet: true, fleetModel }),
  cliProbe: async () => ({ state: 'missing' }),
  laneModels: () => getLaneModelSnapshot({ runsDir: dir }),
  now: () => now,
});

describe('#4768 fleet-model evidence preservation', () => {
  it('reads a fake models.json and keeps paid -lightning refused on both sides of the boundary', async () => {
    await writeFile(join(dir, 'models.json'), JSON.stringify({ devin: 'swe-2-high', 'devin.fast': 'swe-2-max-lightning' }));
    for (const now of [BEFORE, AFTER]) {
      const fm = (await overview('swe-2-max-lightning', now)).fleetModel;
      expect(fm?.configured).toBe('swe-2-flash-max'); expect(fm?.promo).not.toBe('free');
      expect(fm?.laneModels).toEqual([{ key: 'devin', model: 'swe-2-high', paid: false },
        { key: 'devin.fast', model: 'swe-2-max-lightning', paid: true }]);
    }
  });

  it('a listed name is free only before the boundary; missing evidence never becomes free', async () => {
    expect((await overview('swe-2-high', BEFORE)).fleetModel?.promo).toBe('free');
    expect((await overview('swe-2-high', AFTER)).fleetModel?.promo).toBe('not-free');
    const unlisted = await overview('swe-2-custom', BEFORE); // no models.json, unlisted id
    expect(unlisted.fleetModel).toMatchObject({ promo: 'unknown', laneModels: [] });
    expect(devinCliFleetModelPromo('swe-2-high', Number.NaN)).toBe('unknown');
  });

  it('unknown or missing server fields keep the old UI shape', () => {
    for (const omitted of [undefined, null]) expect(devinFleetModelEvidence(omitted)).toBeNull();
    expect(devinFleetModelEvidence({ configured: 'swe-2-high', source: 'config', promo: 'maybe-free', laneModels: [] })).toBeNull();
    expect(devinFleetModelEvidence({ configured: 'swe-2-high', source: 'default', promo: 'unknown', laneModels: [{ key: 'devin' }] })).toBeNull();
  });
});
