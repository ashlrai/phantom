/** `phm pools`: thin argv layer over core/fleet/pools-view.ts. Read-only. */
export const POOLS_USAGE = `Usage: phm pools [--text]
One row per resource: used percent, reset time, hours left, burn per hour,
projected unused percent at reset, waste risk, running jobs against the slot
target, the reader behind the reading, its as-of time and any per-model windows.
JSON (pools.v1) by default; --text for people. Most at risk first, then soonest reset.
A stale or missing reading is unknown with a reason, never zero.`;

export async function cmdPools(args: string[]): Promise<number> {
  if (args.some(a => a === '--help' || a === '-h' || a === 'help')) { console.log(POOLS_USAGE); return 0; }
  if (args.some(a => a !== '--text' && a !== '--json')) { console.error(POOLS_USAGE); return 2; }
  const [{ readResourceLedger }, { buildPoolsView, formatPoolsText }] = await Promise.all([
    import('../core/fleet/runs-resource-ledger.js'), import('../core/fleet/pools-view.js'),
  ]);
  const now = Date.now();
  const view = buildPoolsView(await readResourceLedger({ now: () => now }), now);
  console.log(args.includes('--text') ? formatPoolsText(view) : JSON.stringify(view, null, 2));
  return 0;
}
