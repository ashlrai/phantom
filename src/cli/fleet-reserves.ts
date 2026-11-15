/**
 * `ashlr fleet reserves` — show which seats hold subscription usage back
 * automatically, and with `--clear` remove the reserves that come from the
 * budget MODE_DEFAULTS rather than from the operator
 * (RQ-PHX-FLEETRESERVESVERB111; Mason, Nov 5 22:02 ET: "Remove automatic
 * 85%, 98% or any subscription usage reserve… show unknown as unknown").
 *
 * READ (`ashlr fleet reserves`): seat ids are the stored policy's `seats`
 * keys plus every seat in the capacity snapshot, deduped and sorted; each
 * row is the policy the router actually applies — `effectiveSeatPolicy` —
 * with `source mode-default(<mode>)` when no stored entry exists and
 * `stored` when the operator set it. The last line counts the seats whose
 * hold-back is automatic: enabled, non-devin, non-local, mode-default, with
 * a reserve above 0% or a session ceiling below 100%.
 *
 * WRITE (`--clear`): for each automatically-reserved seat, in listed order,
 * one `updateBudgetPolicy` seat patch sets `reservePercent: 0` and clears
 * `maxSessionWindowPercent` — the same update the Budget panel posts.
 * Stored seats are the operator's explicit choice and are never touched.
 * `--dry-run` prints what would change and writes nothing.
 *
 * The policy file is never guessed: an unreadable file prints the store's
 * own reason and exits 2 (the same check the writer's
 * BudgetPolicyUnreadableError guards), and a missing file is simply the
 * defaults. Exit codes: 0 ok, 1 a --clear update failed, 2 bad usage or an
 * unreadable policy file.
 */

import {
  budgetPolicyPath,
  capacitySnapshotPath,
  readBudgetPolicyFileState,
  readCapacitySnapshot,
  updateBudgetPolicy,
} from '../core/routing/budget-store.js';
import { defaultBudgetPolicy, effectiveSeatPolicy, engineOfSeatId, type BudgetEngine } from '../core/routing/policy.js';
import type { BudgetMode, BudgetPolicy } from '../core/routing/types.js';

export const FLEET_RESERVES_USAGE = 'ashlr fleet reserves [--json] [--clear [--dry-run]]';
export const FLEET_RESERVES_SCHEMA = 'fleet.reserves.v1';

export interface FleetReservesDeps {
  /** Budget policy file; defaults to ~/.ashlr/budget.json. */
  policyFile?: string;
  /** Capacity snapshot file; defaults to ~/.ashlr/routing/capacity.json. */
  capacityFile?: string;
  /** Timestamp stamped on each --clear update; defaults to the store's clock. */
  now?: Date;
  out?: (s: string) => void;
}

interface ReserveRow {
  seatId: string;
  engine: BudgetEngine;
  enabled: boolean;
  reservePercent: number;
  maxSessionWindowPercent: number | null;
  source: 'mode-default' | 'stored';
}

function reserveRows(policy: BudgetPolicy, snapshotSeatIds: readonly string[]): ReserveRow[] {
  const ids = new Set<string>(Object.keys(policy.seats));
  for (const seatId of snapshotSeatIds) ids.add(seatId);
  return [...ids].sort().map((seatId) => {
    const effective = effectiveSeatPolicy(policy, seatId);
    return {
      seatId,
      engine: engineOfSeatId(seatId),
      enabled: effective.enabled,
      reservePercent: effective.reservePercent,
      maxSessionWindowPercent: effective.maxSessionWindowPercent ?? null,
      source: Object.hasOwn(policy.seats, seatId) ? 'stored' as const : 'mode-default' as const,
    };
  });
}

/**
 * A seat keeps usage back AUTOMATICALLY only when the hold-back is a mode
 * default the operator never asked for. A reserve of 0 with no ceiling
 * holds nothing; disabled seats hold nothing; devin (metered in ACUs, no
 * windows) and local (free) seats have no subscription usage to reserve.
 */
function automaticReserve(row: ReserveRow): boolean {
  return row.source === 'mode-default'
    && row.enabled
    && row.engine !== 'devin'
    && row.engine !== 'local'
    && (row.reservePercent > 0 || (row.maxSessionWindowPercent !== null && row.maxSessionWindowPercent < 100));
}

function formatRow(row: ReserveRow, mode: BudgetMode): string {
  const ceiling = row.maxSessionWindowPercent === null ? 'none' : `${row.maxSessionWindowPercent}%`;
  const source = row.source === 'stored' ? 'stored' : `mode-default(${mode})`;
  return `${row.seatId}  ${row.engine}  reserve ${row.reservePercent}%  session ceiling ${ceiling}  source ${source}  ${row.enabled ? 'enabled' : 'off'}`;
}

function jsonRow(row: ReserveRow): Record<string, unknown> {
  return {
    seatId: row.seatId,
    engine: row.engine,
    enabled: row.enabled,
    reservePercent: row.reservePercent,
    maxSessionWindowPercent: row.maxSessionWindowPercent,
    source: row.source,
  };
}

export async function cmdFleetReserves(args: string[], deps: FleetReservesDeps = {}): Promise<number> {
  const out = deps.out ?? console.log;
  let json = false;
  let clear = false;
  let dryRun = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] === '-h' ? '--help' : args[i]!;
    if ((arg === '--json' || arg === '--clear' || arg === '--dry-run' || arg === '--help') && !seen.has(arg)) {
      if (arg === '--json') json = true;
      else if (arg === '--clear') clear = true;
      else if (arg === '--dry-run') dryRun = true;
    } else {
      out(FLEET_RESERVES_USAGE);
      return 2;
    }
    seen.add(arg);
  }
  if (seen.has('--help')) { out(FLEET_RESERVES_USAGE); return 0; }
  if (dryRun && !clear) { out(FLEET_RESERVES_USAGE); return 2; }

  const policyFile = deps.policyFile ?? budgetPolicyPath();
  const capacityFile = deps.capacityFile ?? capacitySnapshotPath();
  // The writer's own file check, reused for the read: a mangled policy must
  // never be shown as "no reserves" — the reason is printed, not guessed.
  const found = readBudgetPolicyFileState(policyFile);
  if (found.state === 'unreadable') {
    out(`budget policy ${found.reason}; not rewriting or guessing (fix or move the file aside)`);
    return 2;
  }
  const policy = found.state === 'ok' ? found.policy : defaultBudgetPolicy();
  const snapshot = readCapacitySnapshot(capacityFile);
  const rows = reserveRows(policy, (snapshot?.seats ?? []).map((seat) => seat.seatId));
  const automatic = rows.filter(automaticReserve);
  const automaticCount = automatic.length;

  if (!clear) {
    if (json) {
      out(JSON.stringify({ schema: FLEET_RESERVES_SCHEMA, mode: policy.mode, seats: rows.map(jsonRow), automatic: automaticCount }));
    } else {
      out([...rows.map((row) => formatRow(row, policy.mode)), `${automaticCount} seats keep usage back automatically`].join('\n'));
    }
    return 0;
  }

  const engines = new Map<string, BudgetEngine>((snapshot?.seats ?? []).map((seat) => [seat.seatId, seat.engine]));
  const cleared: string[] = [];
  for (const row of automatic) {
    if (dryRun) {
      if (!json) out(`would clear ${row.seatId}`);
      cleared.push(row.seatId);
      continue;
    }
    try {
      updateBudgetPolicy(
        { kind: 'seat', seatId: row.seatId, patch: { reservePercent: 0, maxSessionWindowPercent: null } },
        { file: policyFile, now: deps.now, engineOf: (seatId) => engines.get(seatId) },
      );
    } catch (err) {
      out(`failed to clear ${row.seatId}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    if (!json) out(`cleared ${row.seatId}`);
    cleared.push(row.seatId);
  }
  if (json) {
    out(JSON.stringify({
      schema: FLEET_RESERVES_SCHEMA, mode: policy.mode, seats: rows.map(jsonRow),
      automatic: automaticCount, cleared, ...(dryRun ? { dryRun: true } : {}),
    }));
  } else {
    out(`${cleared.length} ${dryRun ? 'seats would be cleared' : 'seats cleared'} of automatic reserves`);
  }
  return 0;
}
