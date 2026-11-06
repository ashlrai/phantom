import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { inventoryStaging, type InventoryDeps } from '../core/fleet/staging-inventory.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const USAGE = 'usage: ashlr fleet staging-inventory [--root <absolute-directory>] [--json]';
type Deps = InventoryDeps & { output?: { log: (line: string) => void; error: (line: string) => void } };
export async function cmdFleetStagingInventory(args: string[], deps: Deps = {}): Promise<number> {
  const output = deps.output ?? console;
  let root = join(homedir(), '.local/share/ashlr/release-staging');
  let json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') { output.log(USAGE); return 0; }
    if (seen.has(arg)) { output.error(USAGE); return 2; }
    seen.add(arg);
    if (arg === '--root') {
      const value = args[++i];
      if (!value || !isAbsolute(value)) { output.error(USAGE); return 2; }
      root = value;
    } else if (arg === '--json') json = true;
    else { output.error(USAGE); return 2; }
  }
  const report = sanitizePublicJson(await inventoryStaging(root, deps)) as Awaited<ReturnType<typeof inventoryStaging>>;
  if (json) output.log(JSON.stringify(report));
  else {
    output.log(`Staging inventory: ${report.root}`);
    output.log(`Generated: ${report.generatedAt}; source: ${report.source}; ${report.complete ? 'complete' : 'incomplete'}${report.truncated ? ' (truncated)' : ''}`);
    output.log(`Skipped symlinks: ${report.skippedSymlinks}`);
    for (const entry of report.entries) output.log(`  ${JSON.stringify(entry.name)}: ${entry.bytes === null ? 'unknown' : `${entry.bytes} bytes`}; modified ${entry.modifiedAt}`);
    output.log(`Total measured: ${report.totalMeasuredBytes} bytes (inventory, not reclaimable space)`);
    output.log(report.cleanupEligibility);
  }
  return 0;
}
