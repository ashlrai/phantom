/** `phm inventory [--kind <kind>] [--json]`: thin argv layer over core/fleet/inventory.ts. Read-only. */
import { INVENTORY_KINDS, parseInventoryKind, type Inventory, type InventoryKind } from '../core/fleet/inventory-schema.js';

export const INVENTORY_USAGE = `Usage: phm inventory [--kind <kind>] [--json]
Everything this install can use, in one list: messaging channels, connectors,
plugins, skills and tools. Each has a state in plain words: ready, needs setup,
off, error or unknown. An item that needs setup names the one next step.
It ends with the tool gap between lanes: what each lane can use and what it lacks.
Read-only: it never installs, enables or changes anything, and never prints a
credential. A source that cannot be read is shown as unknown.
--kind: one of ${INVENTORY_KINDS.join(', ')}.
--json prints phantom.inventory.v1. Exit 0, or 2 on bad usage.`;

export interface InventoryCliDeps { read?: () => Promise<Inventory> }

export async function cmdInventory(args: string[], deps: InventoryCliDeps = {}): Promise<number> {
  if (args.some(a => a === '--help' || a === '-h' || a === 'help')) { console.log(INVENTORY_USAGE); return 0; }
  let json = false;
  let kind: InventoryKind | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') json = true;
    else if (a === '--kind' && kind === null && args[i + 1] !== undefined) {
      kind = parseInventoryKind(args[++i]!);
      if (!kind) {
        const error = `Unknown kind "${args[i]!.slice(0, 40)}". Use one of: ${INVENTORY_KINDS.join(', ')}.`;
        console.error(json || args.includes('--json') ? JSON.stringify({ error }) : error);
        return 2;
      }
    } else { console.error(INVENTORY_USAGE); return 2; }
  }
  const core = await import('../core/fleet/inventory.js');
  const all = await (deps.read ?? core.readInventory)();
  const inventory = kind ? core.filterInventory(all, kind) : all;
  console.log(json ? JSON.stringify(inventory, null, 2) : core.formatInventory(inventory));
  return 0;
}
