/**
 * One line on the desktop Leader card and the phone Home status: is the phm running on this Mac the code the
 * fleet merged? "Live build: current", "Live build: 644 behind (since Nov 12)", or "Live build: unknown".
 * Reads the typed `build` of the doctor.supply.v1 report (the same read as the Supply card) and the limits saved in Settings; the words come from core/fleet/build-stale.ts. Past the stale limits the line is marked as a warning.
 */
import { buildStaleness, liveBuildLine } from '../../../../core/fleet/build-stale.js';
import { useQuery } from '../../../data/hooks.js';
import { buildStaleLimitsQuery } from '../sections/build-stale-limits-queries.js';
import { supplyQuery } from './SupplyCard.js';

export function LiveBuildLine({ className }: { className?: string }) {
  const report = useQuery(supplyQuery).data ?? null;
  const build = report?.build ?? null;
  // Same limits the pulse alert uses; until they load (or if the read fails) the defaults apply.
  const limits = useQuery(buildStaleLimitsQuery).data?.limits;
  const state = buildStaleness(build, Date.now(), limits);
  return <p className={className} role="status" aria-label="Live build" data-tone={state === 'stale' ? 'red' : state === 'unknown' ? 'unknown' : 'ok'}>{liveBuildLine(build)}</p>;
}
