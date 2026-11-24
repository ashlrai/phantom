/**
 * routes/verse/leader/LaneSupplyLine.tsx — the one-line "a lane is idle while usage is left" alarm on the
 * Leader card (desktop Mind, phone Leader). Built only on the typed fleet.lane-supply.v1 report
 * (`phm fleet lane-supply --json`); it draws nothing until a lane is idle with usage left, and nothing
 * when the Mac does not report it. Plain text only. Read-only.
 */
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { asLaneSupplyReport, LANE_SUPPLY_PATH, type LaneSupplyReport } from '../../../../core/fleet/lane-supply.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';

export const LANE_SUPPLY_POLL_MS = 60_000;
export const laneSupplyQuery: QueryDef<LaneSupplyReport | null> = {
  key: 'fleet-lane-supply',
  fetch: async signal => asLaneSupplyReport(await apiGet<unknown>(LANE_SUPPLY_PATH, signal)),
};

export function LaneSupplyLine({ className }: { className?: string }) {
  const query = useQuery(laneSupplyQuery, { freshMs: 30_000 });
  const refetch = useRefetch(laneSupplyQuery);
  usePollWhileVisible(refetch, LANE_SUPPLY_POLL_MS);
  const alarm = query?.data?.alarm ?? null;
  if (alarm === null) return null;
  return <p className={className} role="status" data-tone="warn">{alarm}. Run <code>phm fleet lane-supply</code>.</p>;
}
