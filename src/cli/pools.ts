/** `phm pools`: thin argv layer over core/fleet/pools-view.ts. Read-only. */
export const POOLS_USAGE = `Usage: phm pools [--text]
One row per resource: used percent, reset time, hours left, burn per hour
(slope of the last 6 h of readings, with its reading count), projected unused
percent at reset, when it runs empty, a plain-words verdict ("empty about 3 PM
Thu, 27 h before reset: slow down" or "40% will go unused: add work"), waste risk, running jobs against the slot
target, the reader behind the reading, its as-of time and any per-model windows.
JSON (pools.v1) by default; --text for people. Most at risk first, then soonest reset.
A stale or missing reading is unknown with a reason, never zero.`;

export async function cmdPools(args: string[]): Promise<number> {
  if (args.some(a => a === '--help' || a === '-h' || a === 'help')) { console.log(POOLS_USAGE); return 0; }
  if (args.some(a => a !== '--text' && a !== '--json')) { console.error(POOLS_USAGE); return 2; }
  const [{ readResourceLedger }, { buildPoolsView, formatPoolsText }, { readUsageSamples }] = await Promise.all([
    import('../core/fleet/runs-resource-ledger.js'), import('../core/fleet/pools-view.js'), import('../core/fleet/usage-history.js'),
  ]);
  const now = Date.now();
  const view = buildPoolsView(await readResourceLedger({ now: () => now }), now, await readUsageSamples({ nowMs: now }));
  console.log(args.includes('--text') ? formatPoolsText(view) : JSON.stringify(view, null, 2));
  return 0;
}
