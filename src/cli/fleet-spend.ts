import { readUsageSpend, type SpendRow, type SpendSnapshot } from '../core/usage/spend.js';

const usage = 'Usage: phm fleet spend [--json]  (one line per pool, behind first; unknown stays unknown)';
const pct = (n: number | null): string => n === null ? 'unknown' : `${Math.round(n)}%`;

/** One plain line per pool: verdict, used now, projected at reset, countdown. */
export function spendLine(row: SpendRow): string {
  const left = row.resetsIn === null ? 'unknown' : `in ${row.resetsIn}`;
  if (row.unit === 'usd') {
    const balance = row.remainingUsd === null ? 'balance unknown' : `${row.remainingUsd} USD left (${pct(row.usedPercent)} used)`;
    return `${row.pool}: ${row.summary} · ${balance} · expires ${left}`;
  }
  return `${row.pool}: ${row.summary} · ${pct(row.usedPercent)} used, ${pct(row.projectedUsedPercent)} by reset · resets ${left}`;
}

export async function cmdFleetSpend(args: string[], read: () => Promise<SpendSnapshot> = () => readUsageSpend()): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(usage); return 0; }
  if (args.length > 1 || (args[0] !== undefined && args[0] !== '--json')) { console.error(usage); return 2; }
  const spend = await read();
  if (args[0] === '--json') console.log(JSON.stringify(spend, null, 2));
  else for (const row of spend.pools) console.log(spendLine(row));
  return 0;
}
