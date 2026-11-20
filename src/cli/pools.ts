/** `phm pools`: thin argv layer over core/fleet/pools-view.ts. Read-only. */
export const POOLS_USAGE = `Usage: phm pools [--text]
One row per resource: used percent, reset time, hours left, burn per hour
(slope of the last 6 h of readings, with its reading count), projected unused
percent at reset, when it runs empty, a plain-words verdict ("empty about 3 PM
Thu, 27 h before reset: slow down" or "40% will go unused: add work"), waste risk, running jobs against the slot
target, the reader behind the reading, its as-of time and any per-model windows.
JSON (pools.v1) by default; --text for people. Most at risk first, then soonest reset.
A stale or missing reading is unknown with a reason, never zero.

Usage: phm pools spenddown [--text]
One row per plan for a spend-down chart: used_frac, reset_at, even_pace_frac (where a straight line
from the last reset would be now), projected_at_reset and a verdict in plain words ("on pace",
"will leave 12% unused: add work", "drained until Fri 6 PM", "no reading"). JSON (pools.spenddown.v1)
by default; --text for people.`;

export async function cmdPools(args: string[]): Promise<number> {
  if (args.some(a => a === '--help' || a === '-h' || a === 'help')) { console.log(POOLS_USAGE); return 0; }
  const spenddown = args[0] === 'spenddown';
  const flags = spenddown ? args.slice(1) : args;
  if (flags.some(a => a !== '--text' && a !== '--json')) { console.error(POOLS_USAGE); return 2; }
  const [{ readResourceLedger }, { buildPoolsView, formatPoolsText }, { readUsageSamples }] = await Promise.all([
    import('../core/fleet/runs-resource-ledger.js'), import('../core/fleet/pools-view.js'), import('../core/fleet/usage-history.js'),
  ]);
  const now = Date.now();
  const { readLiveCaps } = await import('../core/fleet/model-caps.js');
  const view = buildPoolsView(await readResourceLedger({ now: () => now }), now, await readUsageSamples({ nowMs: now }), await readLiveCaps(now));
  if (spenddown) {
    const { buildSpendDown, formatSpendDownText } = await import('../core/fleet/pools-spenddown.js');
    const chart = buildSpendDown(view);
    console.log(flags.includes('--text') ? formatSpendDownText(chart) : JSON.stringify(chart, null, 2));
    return 0;
  }
  console.log(flags.includes('--text') ? formatPoolsText(view) : JSON.stringify(view, null, 2));
  return 0;
}
