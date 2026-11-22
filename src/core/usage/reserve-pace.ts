/** All included allowance is usable; pace projections are advisory. Pure and shared by the pace CLI and both Pools screens. */
import { poolLabel } from './runway.js';
export interface ReserveInput { id: string; usedPct: number | null; hoursLeft: number | null; burnPctPerHour: number | null }
export function reservePace(p: ReserveInput) {
  const valid = (n: number | null): n is number => n !== null && Number.isFinite(n);
  const used = valid(p.usedPct) && p.usedPct >= 0 ? p.usedPct : null;
  const hours = valid(p.hoursLeft) && p.hoursLeft > 0 ? p.hoursLeft : null;
  const burn = valid(p.burnPctPerHour) && p.burnPctPerHour >= 0 ? p.burnPctPerHour : null;
  const safeBurnPerHour = used !== null && hours !== null ? Math.max(0, 100 - used) / hours : null;
  const verdict = safeBurnPerHour === null || burn === null ? 'unknown' : burn > safeBurnPerHour ? 'over' : 'ok';
  const hoursToEmpty = used !== null && burn !== null && burn > 0 ? Math.max(0, 100 - used) / burn : null;
  const show = (n: number | null) => n === null ? 'unknown' : String(Math.round(n * 100) / 100);
  const line = `${poolLabel(p.id)}: ${show(used)}% used, ${show(hours)} h left, spending ${show(burn)}/h, safe is ${show(safeBurnPerHour)}/h. `
    + `${verdict === 'over' ? 'Over pace' : verdict === 'ok' ? 'On pace' : 'Pace unknown'}, ${hoursToEmpty !== null ? `empty in about ${Math.round(hoursToEmpty)} h` : burn === 0 ? 'no spending' : 'empty time unknown'}.`;
  return { verdict: verdict as 'ok' | 'over' | 'unknown', safeBurnPerHour, hoursToEmpty, line };
}
