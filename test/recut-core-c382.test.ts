import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { devinOverview } from '../src/core/devin/service.js';
import { getLaneModelSnapshot } from '../src/core/fleet/lane-models.js';
import { devinFleetModelEvidence, devinFleetModelLines, narrowDevinOverview } from '../src/web-ui/routes/verse/devin/devin-model.js';

it('carries the real overview fleet model and lane snapshot into the Resources display', async () => {
  const runsDir = await mkdtemp(join(tmpdir(), 'recut-core-c382-'));
  try {
    await writeFile(join(runsDir, 'models.json'), JSON.stringify({
      'devin.fast': 'swe-2-max-lightning', codex: 'unrelated-model',
    }));
    const overview = await devinOverview({
      config: () => ({ enabled: true, fleetModel: 'swe-2-max-lightning' }),
      cliProbe: async () => ({ state: 'missing' }),
      keyStore: { platform: 'linux' },
      now: () => new Date('2026-11-14T12:00:00Z'),
      laneModels: () => getLaneModelSnapshot({ runsDir }),
    });
    // Exercise the same JSON boundary and narrowing functions as DevinResource.
    const parsed = narrowDevinOverview(JSON.parse(JSON.stringify(overview)));
    expect(parsed).not.toBeNull();
    const fleetModel = devinFleetModelEvidence(parsed?.fleetModel);
    expect(fleetModel).toMatchObject({
      configured: 'swe-2-flash-max', source: 'config', pricing: 'not-free',
      laneModels: [{ key: 'devin.fast', model: 'swe-2-max-lightning', paid: true }],
    });
    expect(devinFleetModelLines(fleetModel!)).toEqual({
      row: 'Fleet model: swe-2-flash-max · not free',
      warnings: ['models.json devin.fast = swe-2-max-lightning is a paid model; fleet runs fall back to swe-2-flash-max.'],
    });
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

it.each([
  undefined,
  { configured: 'swe-2-medium', source: 'config', promo: 'free', laneModels: [] },
  { configured: 'swe-2-medium', source: 'config', pricing: 'free', laneModels: [] },
  { configured: 'swe-2-medium', source: 'config', pricing: 'unknown', laneModels: [{ key: 'devin', model: 'swe-2-medium', paid: 'yes' }] },
])('rejects missing, stale or malformed fleet-model evidence (%#)', raw => {
  expect(devinFleetModelEvidence(raw)).toBeNull();
});
