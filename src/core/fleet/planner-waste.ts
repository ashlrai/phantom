import type { WasteRiskProjection } from '../resources/waste-risk.js';

// eslint-disable-next-line no-control-regex -- lane names must stay a single printable line.
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;
const LANE_NAME_MAX = 40;
/** The planner never sees more than this many lane lines. */
const CAP = 20;

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Projected unused share of the allowance (unused + used); null when not derivable. */
function unusedPct(row: WasteRiskProjection): number | null {
  const unused = row.projected_unused_at_reset;
  const used = row.projected_used_at_reset;
  if (unused === null || used === null) return null;
  const limit = unused + used;
  return Number.isFinite(limit) && limit > 0 ? round1(unused / limit * 100) : null;
}

/**
 * Lines for the WASTE RISK brief section: lanes projected to leave included
 * capacity unused at their next reset, high risk first, then by larger unused
 * share. Advisory only; it never changes targets or dispatch.
 */
export function wasteRiskBriefLines(rows: readonly WasteRiskProjection[]): string[] {
  const risky = rows
    .filter(row => row.waste_risk === 'high' || row.waste_risk === 'medium')
    .map(row => ({ row, pct: unusedPct(row) }))
    .sort((a, b) =>
      Number(b.row.waste_risk === 'high') - Number(a.row.waste_risk === 'high') ||
      (b.pct ?? -1) - (a.pct ?? -1));
  const unknown = rows.filter(row => row.waste_risk === 'unknown').length;
  const out = risky.slice(0, CAP).map(({ row, pct }) => {
    const lane = row.lane.replace(CONTROL, '').slice(0, LANE_NAME_MAX);
    const hours = row.hours_to_reset === null || !Number.isFinite(row.hours_to_reset) ? 'unknown' : String(round1(row.hours_to_reset));
    return `${lane} ${row.waste_risk} ${pct === null ? 'unknown' : pct}% projected unused at reset in ${hours} h, recommended target ${row.recommended_target ?? 'unknown'}`;
  });
  if (risky.length > CAP) out.push(`(${risky.length - CAP} more lanes at risk not shown)`);
  if (!out.length) out.push('(none: no lane is projected to waste capacity)');
  if (unknown > 0) out.push(`(${unknown} lanes with unknown usage evidence)`);
  return out;
}
