import { expect, it } from 'vitest';
import { projectLiveStatus } from '../src/core/fleet/live-status.js';
import { buildFleetLiveSnapshot } from '../src/core/verse/fleet-live-api.js';
import { buildResourceView } from '../src/core/fabric/resource-view.js';
it('preserves unavailable sources and all pool reset readings', async () => {
  const { snapshot } = await buildFleetLiveSnapshot();
  const resources = buildResourceView({});
  const result = projectLiveStatus({ ...snapshot, merged24h: null, summary: { ...snapshot.summary, building: null } }, resources);
  expect(result.running).toBeNull();
  expect(result.merged).toBeNull();
  expect(result.spent).toHaveLength(6);
  expect(result.spent.every(pool => pool.pctUsed === null && pool.resetAt === null)).toBe(true);
});
it('uses recorded 24h merges rather than the 12h run list', async () => {
  const { snapshot } = await buildFleetLiveSnapshot();
  const merged = [{ id: 'landing', repo: 'ashlrai/phantom', prNumber: 123, landedAt: snapshot.generatedAt }];
  expect(projectLiveStatus({ ...snapshot, runs: [], merged24h: merged }, buildResourceView({})).merged).toEqual(merged);
});
