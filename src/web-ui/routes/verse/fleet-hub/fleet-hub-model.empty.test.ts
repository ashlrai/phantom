import { expect, it } from 'vitest';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { hubEmptyState } from './fleet-hub-model.js';

const reading = (runsDir: FleetRuns['sources']['runsDir']) => ({ sources: { runsDir } }) as FleetRuns;

it.each(['healthy', 'degraded'] as const)('keeps tiles for a %s runs directory', (state) => {
  expect(hubEmptyState(reading(state))).toBeNull();
});

it('identifies a missing fleet directory', () => {
  expect(hubEmptyState(reading('missing'))).toEqual({ kind: 'no-fleet' });
});

it('identifies an unavailable runs reader or route', () => {
  expect(hubEmptyState(reading('not-landed'))).toEqual({ kind: 'not-landed' });
  expect(hubEmptyState(null)).toEqual({ kind: 'not-landed' });
});
