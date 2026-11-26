/** All included allowance is usable; pace projections are advisory. Pure and shared by the pace CLI and both Pools screens. */
import { isFiniteNumber, nonNegativeFinite, poolLabel, round2 } from './runway.js';
export interface ReserveInput { id: string; usedPct: number | null; hoursLeft: number | null; burnPctPerHour: number | null }
export function reservePace(p: ReserveInput) {
  const used = nonNegativeFinite(p.usedPct);
  const hours = isFiniteNumber(p.hoursLeft) && p.hoursLeft > 0 ? p.hoursLeft : null;
  const burn = nonNegativeFinite(p.burnPctPerHour);
  const safeBurnPerHour = used !== null && hours !== null ? Math.max(0, 100 - used) / hours : null;
  const verdict = safeBurnPerHour === null || burn === null ? 'unknown' : burn > safeBurnPerHour ? 'over' : 'ok';
  const hoursToEmpty = used !== null && burn !== null && burn > 0 ? Math.max(0, 100 - used) / burn : null;
  const show = (n: number | null) => n === null ? 'unknown' : String(round2(n));
  const line = `${poolLabel(p.id)}: ${show(used)}% used, ${show(hours)} h left, spending ${show(burn)}/h, safe is ${show(safeBurnPerHour)}/h. `
    + `${verdict === 'over' ? 'Over pace' : verdict === 'ok' ? 'On pace' : 'Pace unknown'}, ${hoursToEmpty !== null ? `empty in about ${Math.round(hoursToEmpty)} h` : burn === 0 ? 'no spending' : 'empty time unknown'}.`;
  return { verdict: verdict as 'ok' | 'over' | 'unknown', safeBurnPerHour, hoursToEmpty, line };
}
