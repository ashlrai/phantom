/** Same as phm spend [--json]: is every pool spent before it resets or expires. */
import { readUsageSpend, spendLabel, type SpendRow, type SpendSnapshot } from '../core/usage/spend.js';

const usage = `Usage: phm spend [--json]
Are we spending every pool before it resets or expires? One sentence, then one line per pool:
status (on-pace, behind, exhausted or unknown), used, burn per hour, projected unused, time left.
The pool that will waste the most comes first. Unknown stays unknown. Read-only.
Same command: phm usage spend [--json] and phm fleet spend [--json].
--json prints usage.spend.v1 {schema,v,asOf,headline,pools:[{pool,unit,status,usedPercent,resetAt,hoursLeft,burnPerHour,projectedUnusedPercent,remainingUsd,projectedUnusedUsd,reason}]}`;
const show = (n: number | null, unit: string): string => n === null ? 'unknown' : `${Math.round(n * 100) / 100}${unit}`;

/** One plain line per pool: status word, then used, burn per hour, projected unused, countdown and reset time when measured. */
export function spendLine(row: SpendRow): string {
  const gift = row.unit === 'usd';
  const status = row.status === 'behind' ? 'behind (will waste)' : row.reason !== null ? `${row.status} (${row.reason})` : row.status;
  // Nothing measured: the status word and its reason are the whole line.
  if (row.usedPercent === null && row.remainingUsd === null && row.resetsIn === null) return `${spendLabel(row)}: ${status}`;
  const used = gift && row.remainingUsd !== null ? `${row.remainingUsd} USD left (${show(row.usedPercent, '%')} used)` : `${show(row.usedPercent, '%')} used`;
  const unused = gift ? show(row.projectedUnusedUsd, ' USD') : show(row.projectedUnusedPercent, '%');
  const when = row.resetsIn === null ? 'unknown' : `in ${row.resetsIn} (${row.resetAt})`;
  return `${spendLabel(row)}: ${status} · ${used} · burn ${show(row.burnPerHour, gift ? ' USD/h' : '%/h')}`
    + ` · ${unused} unused at ${gift ? 'expiry' : 'reset'} · ${gift ? 'expires' : 'resets'} ${when}`;
}

export async function cmdFleetSpend(args: string[], read: () => Promise<SpendSnapshot> = () => readUsageSpend()): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(usage); return 0; }
  if (args.length > 1 || (args[0] !== undefined && args[0] !== '--json')) { console.error(usage); return 2; }
  const spend = await read();
  if (args[0] === '--json') console.log(JSON.stringify(spend, null, 2));
  else for (const line of [spend.headline, ...spend.pools.map(spendLine)]) console.log(line);
  return 0;
}
