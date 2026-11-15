/** Pure advisory ownership line for the recheck reply. Every evidence value
 * passes through the caller's scrub; landed history never supplies an owner. */
import type { FleetRecheckOwners } from './fleet-recheck.js';

export function formatOwnersLine(
  owners: FleetRecheckOwners | null | undefined,
  scrub: (s: string) => string,
): string | null {
  if (owners == null) return null;
  return `Owners: ${owners.surfaces.map(row => {
    const surface = scrub(row.surface);
    const owner = scrub(row.owner);
    // Keep the surface reader's single-token label contract even for a
    // hand-built verdict, including compressed IPv6 and redacted labels.
    const safeLabel = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(owner) && owner !== 'UNKNOWN';
    if (row.ownerSource === 'advisory-claim' && row.liveClaims === 1 && safeLabel) {
      return `${surface} ${owner} (claim)`;
    }
    const reason = row.liveClaims > 1 ? `${row.liveClaims} live claims`
      : row.reason?.startsWith('no live claim') ? 'no live claim'
        : row.reason ?? 'owner unknown';
    return `${surface} UNKNOWN (${scrub(reason)})`;
  }).join(' · ')}`;
}
