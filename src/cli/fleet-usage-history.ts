/** `phm fleet usage-history [--pool <name>] [--json]`: each plan's used share over its current window. Thin: core/fleet/usage-history.ts. */
import { readUsageHistory, USAGE_HISTORY_ROUTE, usageHistoryText, type UsageHistoryV1 } from '../core/fleet/usage-history.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: phm fleet usage-history [--pool <name>] [--json]
How each plan's usage is spent down over its current window, against the straight line from 0% at window start
to 100% at reset. Pace is one word: ahead (spending faster than the line), on pace, behind (some would go unused
at reset) or unknown (fewer than two readings, no reset time, or the window already reset).
The first lines say, per pool, whether it runs dry before its reset or leaves usage unspent, from the two most recent
distinct readings, with the pace to slow or speed up to: "Claude: 23% used, 45 h to reset, running dry 28 h early at
this pace; slow to 1.7 points per hour". One reading, a stale reading or no reset time reads unknown.
Takes a fresh resource-ledger reading and keeps it in metrics/usage-history.json (14 days, unchanged readings skipped).
The desktop Resources > Spend down chart shows exactly this, read from GET ${USAGE_HISTORY_ROUTE}[?pool=<name>].
--json prints fleet.usage-history.v1 {schema,v,generated_at,source_state,pools:[{pool,pace,reason,used_pct,observed_at,
reset_at,window_start,points,ideal,ideal_pct,resets,runway:{verdict,pace_per_hour,pace_6h_per_hour,runway_hours,hours_to_reset,
hours_early,unspent_pct,target_pace_per_hour,advice,reason,sentence}}]}. Unknown is null, never 0.`;

export async function cmdFleetUsageHistory(args: string[],
  read: (pool?: string) => Promise<UsageHistoryV1> = pool => readUsageHistory(pool === undefined ? {} : { pool })): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(usage); return 0; }
  let json = false;
  let pool: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) json = true;
    else if (arg === '--pool' && pool === undefined && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(args[i + 1] ?? '')) pool = args[++i]!;
    else { console.error(usage); return 2; }
  }
  const snapshot = sanitizePublicJson(await read(pool)) as UsageHistoryV1;
  console.log(json ? JSON.stringify(snapshot, null, 2) : usageHistoryText(snapshot, Date.parse(snapshot.generated_at)).join('\n'));
  return 0;
}
