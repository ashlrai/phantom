/**
 * routes/verse/mobile/mobile-switches-queries.ts — the two reads behind the
 * "Switches on the Mac" card.
 *
 *   snapshot   GET /api/verse/fleet/runs              — the workbench's own
 *             key ('verse-fleet-runs', same one ops/MergePulse uses), so the
 *             card shares the one cached reading of the runs directory; its
 *             `switches` are the file names the Mac observed.
 *   control    GET /api/verse/fleet/control/switches   — PR #1575's route;
 *             it is also the write path, so a build without it (404) means a
 *             read-only card, which the model reports as `writable: false`.
 */
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export const fleetRunsSnapshotQuery: QueryDef<unknown> = {
  key: 'verse-fleet-runs',
  fetch: (signal) => apiGet<unknown>('/api/verse/fleet/runs', signal),
};

export const fleetControlSwitchesQuery: QueryDef<unknown> = {
  key: 'verse-fleet-control-switches',
  fetch: (signal) => apiGet<unknown>('/api/verse/fleet/control/switches', signal),
};
