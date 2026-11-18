/** Offline advisory only; uses the existing resource ledger, never changes holds. */
import { readResourceLedger, type ResourceLedgerV1 } from '../core/fleet/runs-resource-ledger.js';
import { ledgerWindowPlan } from '../core/fleet/reset-window-plan.js';

const usage = `ashlr fleet window-plan [--json]
Advisory only; changes no slot or hold. Missing evidence stays unknown.`;

export async function cmdFleetWindowPlan(
  args: string[],
  read: () => Promise<ResourceLedgerV1> = readResourceLedger,
  now: () => number = Date.now,
): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(usage);
    return 0;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) return 2;
  try {
    const resources = ledgerWindowPlan(await read(), now());
    const result = { schema: 'fleet.window-plan.v1', advisory: true, resources };
    console.log(args[0] === '--json' ? JSON.stringify(result) : resources.map(row => `${row.resource}: ${row.verdict} — ${row.reason}`).join('\n'));
    return 0;
  } catch {
    console.error('fleet window-plan: resource evidence unavailable');
    return 1;
  }
}
