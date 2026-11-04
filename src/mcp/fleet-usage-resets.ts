/**
 * fleet_usage_resets — versioned public projection of the usage-reset
 * detector. Evidence only: `releasable` never authorizes a release, and an
 * unhealthy source forces it false. Raw hold reasons, the detector's prose
 * `tell` and any unknown fields are deliberately not forwarded.
 */
import { readUsageResets, type UsageResetRow, type UsageResetsV1 } from '../core/fleet/usage-reset-detect.js';
import { scrubPrivateText } from '../core/util/scrub.js';
import { MAX_FLEET_LANES } from './fleet-lanes.js';

export type FleetUsageResetState = UsageResetRow['state'];

export interface FleetUsageResetRow {
  lane: string;
  state: FleetUsageResetState;
  held: boolean;
  heldBy: 'autobackoff' | 'manual' | null;
  heldUntil: string | null;
  usedPct: number | null;
  readingAsOf: string | null;
  resetAt: string | null;
  releasable: boolean;
}

export interface FleetUsageResetsV1 {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
  sourceState: 'healthy' | 'degraded' | 'missing';
  note: string;
  rows: FleetUsageResetRow[];
}

const STATES = {
  'reset-detected': true,
  'reset-time-passed': true,
  'hold-expired': true,
  'consistent': true,
  'stale-reading': true,
  'no-reading': true,
  'manual-hold': true,
  'open': true,
} satisfies Record<UsageResetRow['state'], true>;
const NOTE = 'Evidence only: releasable never authorizes a release, and is forced false unless sourceState is healthy. Manual holds need operator release.';

const text = (value: unknown): string | null =>
  typeof value === 'string' ? scrubPrivateText(value, { emails: true }) : null;
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;

export async function readFleetUsageResets(read: () => Promise<UsageResetsV1> = readUsageResets): Promise<FleetUsageResetsV1> {
  let source: UsageResetsV1;
  try { source = await read(); } catch { source = { v: 1, generatedAt: new Date().toISOString(), sourceState: 'degraded', rows: [] }; }
  const known = source.sourceState === 'healthy' || source.sourceState === 'missing' || source.sourceState === 'degraded';
  let sourceState: FleetUsageResetsV1['sourceState'] = known ? source.sourceState : 'degraded';
  const input: unknown[] = Array.isArray(source.rows) ? source.rows : [];
  const rows: FleetUsageResetRow[] = [];
  for (const raw of input.slice(0, MAX_FLEET_LANES)) {
    const row = (raw ?? {}) as Partial<Record<keyof UsageResetRow, unknown>>;
    if (typeof row.lane !== 'string' || typeof row.state !== 'string' || !Object.hasOwn(STATES, row.state)) { sourceState = 'degraded'; continue; }
    rows.push({
      lane: scrubPrivateText(row.lane, { emails: true }),
      state: row.state as FleetUsageResetState,
      held: row.held === true,
      heldBy: row.heldBy === 'autobackoff' || row.heldBy === 'manual' ? row.heldBy : null,
      heldUntil: text(row.heldUntil),
      usedPct: num(row.usedPct),
      readingAsOf: text(row.readingAsOf),
      resetAt: text(row.resetAt),
      releasable: row.releasable === true && row.state !== 'manual-hold',
    });
  }
  // Truncated rows mean an incomplete picture; never present it as healthy.
  if (input.length > MAX_FLEET_LANES && sourceState === 'healthy') sourceState = 'degraded';
  if (sourceState !== 'healthy') for (const row of rows) row.releasable = false;
  const stamp = typeof source.generatedAt === 'string' && Number.isFinite(Date.parse(source.generatedAt)) ? source.generatedAt : new Date(0).toISOString();
  return { schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none', generatedAt: stamp, sourceState, note: NOTE, rows };
}
