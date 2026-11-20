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
by default; --text for people.

Usage: phm pools cap <fable|opus|sonnet> [--message <limit message>] [--reset-at <iso>] [--clear]
Record that one Claude model hit its own limit ("You've reached your Fable limit") while the plan has room.
The router then runs that model's work on the next one (Fable, then Opus, then Sonnet) and marks the job
with fallback_from. The cap clears at the plan's reset time. Unrecorded models stay unknown and never move work.
--clear lifts a cap early. Prints the three model rows as JSON (capped true, false or null).`;

export async function cmdPools(args: string[]): Promise<number> {
  if (args.some(a => a === '--help' || a === '-h' || a === 'help')) { console.log(POOLS_USAGE); return 0; }
  if (args[0] === 'cap') return cmdPoolsCap(args.slice(1));
  const spenddown = args[0] === 'spenddown';
  const flags = spenddown ? args.slice(1) : args;
  if (flags.some(a => a !== '--text' && a !== '--json')) { console.error(POOLS_USAGE); return 2; }
  const [{ readResourceLedger }, { buildPoolsView, formatPoolsText }, { readUsageSamples }] = await Promise.all([
    import('../core/fleet/runs-resource-ledger.js'), import('../core/fleet/pools-view.js'), import('../core/fleet/usage-history.js'),
  ]);
  const now = Date.now();
  const view = buildPoolsView(await readResourceLedger({ now: () => now }), now, await readUsageSamples({ nowMs: now }));
  if (spenddown) {
    const { buildSpendDown, formatSpendDownText } = await import('../core/fleet/pools-spenddown.js');
    const chart = buildSpendDown(view);
    console.log(flags.includes('--text') ? formatSpendDownText(chart) : JSON.stringify(chart, null, 2));
    return 0;
  }
  console.log(flags.includes('--text') ? formatPoolsText(view) : JSON.stringify(view, null, 2));
  return 0;
}

/** `phm pools cap`: thin argv layer over routing/model-caps.ts. */
async function cmdPoolsCap(args: string[]): Promise<number> {
  const { parseLimitMessage, modelFamily, recordModelCap } = await import('../core/routing/model-caps.js');
  const { readResourceLedger } = await import('../core/fleet/runs-resource-ledger.js');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  let model = modelFamily(args[0]?.startsWith('--') ? null : args[0]);
  let message: string | undefined, resetAt: string | undefined, clear = false;
  for (let i = model === null ? 0 : 1; i < args.length; i++) {
    const arg = args[i]!, value = args[i + 1];
    if (arg === '--clear') clear = true;
    else if ((arg === '--message' || arg === '--reset-at') && value !== undefined) { if (arg === '--message') message = value; else resetAt = value; i++; }
    else { console.error(POOLS_USAGE); return 2; }
  }
  model ??= message === undefined ? null : parseLimitMessage(message);
  if (model === null || (resetAt !== undefined && !Number.isFinite(Date.parse(resetAt)))) { console.error(POOLS_USAGE); return 2; }
  const root = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const planResetAt = (await readResourceLedger({ runsDir: root })).lanes.find(lane => lane.lane === 'claude')?.resetAt ?? null;
  console.log(JSON.stringify(await recordModelCap(root, { model, ...(message === undefined ? {} : { message }), ...(resetAt === undefined ? {} : { resetAt }), clear, planResetAt }), null, 2));
  return 0;
}
