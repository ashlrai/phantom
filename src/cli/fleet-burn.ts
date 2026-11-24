/**
 * `phm fleet burn [--pool claude] [--json]`: who is spending the Claude plan and
 * when it runs out at this pace. Read-only. Logic lives in core/usage/burn-who.ts.
 */
import { readBurnWho, type BurnWho } from '../core/usage/burn-who.js';

const USAGE = 'Usage: phm fleet burn [--pool claude] [--json]';

export interface FleetBurnDeps { read?: () => Promise<BurnWho> }

const pace = (v: number | null): string => v === null ? 'unknown' : `${v} points/h`;

export function burnLines(r: BurnWho): string[] {
  const lines = [r.sentence, '',
    `Pace: last 1 h ${pace(r.pace1h)}, last 6 h ${pace(r.pace6h)}${r.paceBasis === 'reported' ? `, dispatchd reports ${pace(r.paceNow)}` : ''}`,
    `Even pace: ${r.evenPacePercent === null ? 'unknown' : `${r.evenPacePercent}% used by now`}${r.hoursToReset === null ? '' : ` (${r.hoursToReset} h to reset)`}`,
    '', `Job starts, last 6 h (${r.startsNote.replace(/^Shares count /, 'a count of ').replace(/ in the last 6 hours, not tokens\.$/, ', not tokens')}):`];
  for (const c of r.consumers) lines.push(`  ${c.name}: ${c.starts} (${c.sharePercent}%, ${c.startsPerHour}/h)`);
  return lines;
}

export async function cmdFleetBurn(args: string[], deps: FleetBurnDeps = {}): Promise<number> {
  if (args.some(a => a === '--help' || a === '-h')) { console.log(USAGE); return 0; }
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') json = true;
    else if (a === '--pool' && args[i + 1] === 'claude') i++;
    else { console.error(USAGE); return 2; }
  }
  const report = await (deps.read ?? readBurnWho)();
  console.log(json ? JSON.stringify(report) : burnLines(report).join('\n'));
  return 0;
}
