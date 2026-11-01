/** Offline advisory only; uses the existing resource ledger, never changes holds. */
import { readResourceLedger, type ResourceLedgerV1 } from '../core/fleet/runs-resource-ledger.js';
import { resetWindowPlan } from '../core/fleet/reset-window-plan.js';

export async function cmdFleetWindowPlan(
  args: string[],
  read: () => Promise<ResourceLedgerV1> = readResourceLedger,
  now: () => number = Date.now,
): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log('ashlr fleet window-plan [--json]\nAdvisory only; changes no slot or hold. Missing evidence stays unknown.');
    return 0;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) return 2;
  try {
    const ledger = await read();
    const nowMs = now();
    const resources = resetWindowPlan(ledger.lanes.map(row => {
      const observed = Date.parse(row.observation?.asOf ?? ledger.asOf ?? '');
      const fresh = Number.isFinite(observed) && observed <= nowMs && nowMs - observed <= 300_000;
      return { resource: row.lane, usedPercent: fresh ? row.usedPct : null, resetAt: row.resetAt,
        burnPctPerHour: fresh ? row.burnPctPerHour : null, running: row.running, target: row.target,
        // Weekly allowances expire; credit balances alone do not establish expiry.
        expiresUnused: row.window === 'weekly' };
    }), nowMs);
    const result = { schema: 'fleet.window-plan.v1', advisory: true, resources };
    console.log(args[0] === '--json' ? JSON.stringify(result) : resources.map(row => `${row.resource}: ${row.verdict} — ${row.reason}`).join('\n'));
    return 0;
  } catch {
    console.error('fleet window-plan: resource evidence unavailable');
    return 1;
  }
}
