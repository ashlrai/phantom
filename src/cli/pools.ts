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
from the last reset would be now), projected_at_reset and a verdict in plain words ("spending on pace",
"behind: will waste ~12%", "exhausted until Fri 6 PM", "refilled, lane idle", "unknown: no reading"). Also running
jobs against the slot target and rows queued for the lane. JSON (pools.spenddown.v1) by default; --text for people.

Usage: phm pools waste [--json]
Which pool is about to waste included usage, and the one fix, in plain words: "Gemini: 85% will go unused in 5 h.
Sign in to Gemini once: run gemini in a terminal." Flags a pool that resets within 12 h and has waste risk high or
at least 25% projected unused. A pool with no current reading is listed as unknown, never flagged. When the fix needs
you (a one-time sign-in) it is also put on the phone Asks card. People text by default; --json is pools.waste.v1.`;

export async function cmdPools(args: string[]): Promise<number> {
  if (args.some(a => a === '--help' || a === '-h' || a === 'help')) { console.log(POOLS_USAGE); return 0; }
  const spenddown = args[0] === 'spenddown';
  if (args[0] === 'waste') {
    const flags = args.slice(1);
    if (flags.some(a => a !== '--text' && a !== '--json')) { console.error(POOLS_USAGE); return 2; }
    const { readPoolsWaste, formatPoolsWasteText } = await import('../core/fleet/pools-waste.js');
    const waste = await readPoolsWaste();
    await (await import('../core/fleet/asks-sync.js')).syncAsks().catch(() => null);
    console.log(flags.includes('--json') ? JSON.stringify(waste, null, 2) : formatPoolsWasteText(waste));
    return 0;
  }
  const flags = spenddown ? args.slice(1) : args;
  if (flags.some(a => a !== '--text' && a !== '--json')) { console.error(POOLS_USAGE); return 2; }
  const [{ readResourceLedger }, { buildPoolsView, formatPoolsText }, { readUsageSamples }] = await Promise.all([
    import('../core/fleet/runs-resource-ledger.js'), import('../core/fleet/pools-view.js'), import('../core/fleet/usage-history.js'),
  ]);
  const now = Date.now();
  const view = buildPoolsView(await readResourceLedger({ now: () => now }), now, await readUsageSamples({ nowMs: now }));
  if (spenddown) {
    const { readSpendDown, formatSpendDownText } = await import('../core/fleet/pools-spenddown.js');
    const chart = await readSpendDown(view, { nowMs: now });
    console.log(flags.includes('--text') ? formatSpendDownText(chart) : JSON.stringify(chart, null, 2));
    return 0;
  }
  console.log(flags.includes('--text') ? formatPoolsText(view) : JSON.stringify(view, null, 2));
  return 0;
}
