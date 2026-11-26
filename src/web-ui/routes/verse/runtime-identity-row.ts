import type { RuntimeSnapshotResponse } from './fleet-host/runtime-snapshot-query.js';
import { ageInSeconds } from '../../lib/relative-time.js';

export interface RuntimeIdentityRow {
  tone: 'ok' | 'stale' | 'down';
  text: string;
}

/** A reading older than this is shown amber. */
export const RUNTIME_STALE_MS = 5 * 60_000;

const known = (v: unknown): string => (typeof v === 'string' && v.trim() !== '' && v !== 'UNKNOWN' ? v.trim() : 'unknown');

/**
 * One-line runtime identity for the sidebar. Pure: `now` is epoch ms. A fetch
 * failure (error set, or no snapshot at all) is "down"; any field the snapshot
 * lacks prints "unknown" rather than a guess, and an unparseable read time is
 * "stale" because freshness cannot be shown.
 */
export function describeRuntimeIdentity(
  snapshot: RuntimeSnapshotResponse | null | undefined,
  error: unknown,
  now: number,
): RuntimeIdentityRow {
  if (error != null || snapshot == null) return { tone: 'down', text: 'runtime unreachable' };
  const snap: Partial<RuntimeSnapshotResponse['snapshot']> =
    snapshot.snapshot !== null && typeof snapshot.snapshot === 'object' ? snapshot.snapshot : {};
  const version = known(snap.installedVersion);
  const readAt = typeof snap.asOf === 'string' ? Date.parse(snap.asOf) : NaN;
  const valid = Number.isFinite(readAt);
  const age = valid ? Math.max(0, now - readAt) : null;
  return {
    tone: age !== null && age <= RUNTIME_STALE_MS ? 'ok' : 'stale',
    text: `runtime ${known(snap.host)} · v${version === 'unknown' ? version : version.replace(/^v/, '')} · read ${age === null ? 'unknown' : ageInSeconds(age / 1000)}`,
  };
}
