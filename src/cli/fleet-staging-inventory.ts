import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  DEFAULT_MAX_DURATION_MS, DU_TIMEOUT_MS, MAX_DURATION_MS_LIMIT, inventoryStaging, isValidMaxDurationMs, type InventoryDeps,
} from '../core/fleet/staging-inventory.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const USAGE = 'usage: ashlr fleet staging-inventory [--root <absolute-directory>] [--max-duration-ms <integer>] [--json]';
const HELP = [
  USAGE,
  `  --max-duration-ms  total scan budget in milliseconds, listing included (default ${DEFAULT_MAX_DURATION_MS}; 1 to ${MAX_DURATION_MS_LIMIT})`,
  `  Each du is capped to the budget that remains and to ${DU_TIMEOUT_MS} ms. An exhausted budget reports complete=false with unmeasured entries.`,
].join('\n');
type Deps = InventoryDeps & { output?: { log: (line: string) => void; error: (line: string) => void } };
export async function cmdFleetStagingInventory(args: string[], deps: Deps = {}): Promise<number> {
  const output = deps.output ?? console;
  let root = join(homedir(), '.local/share/ashlr/release-staging');
  let json = false;
  let maxDurationMs = DEFAULT_MAX_DURATION_MS;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') { output.log(HELP); return 0; }
    if (seen.has(arg)) { output.error(USAGE); return 2; }
    seen.add(arg);
    if (arg === '--root') {
      const value = args[++i];
      if (!value || !isAbsolute(value)) { output.error(USAGE); return 2; }
      root = value;
    } else if (arg === '--max-duration-ms') {
      // Digits only: rejects signs, decimals and exponents that Number() would accept.
      const value = args[++i];
      const parsed = value && /^\d+$/.test(value) ? Number(value) : NaN;
      if (!isValidMaxDurationMs(parsed)) {
        output.error(`--max-duration-ms must be an integer from 1 to ${MAX_DURATION_MS_LIMIT}`);
        output.error(USAGE);
        return 2;
      }
      maxDurationMs = parsed;
    } else if (arg === '--json') json = true;
    else { output.error(USAGE); return 2; }
  }
  const report = sanitizePublicJson(await inventoryStaging(root, deps, { maxDurationMs })) as Awaited<ReturnType<typeof inventoryStaging>>;
  if (json) output.log(JSON.stringify(report));
  else {
    const { measurements, budget } = report;
    output.log(`Staging inventory: ${report.root}`);
    output.log(`Generated: ${report.generatedAt}; source: ${report.source}; ${report.complete ? 'complete' : 'incomplete'}${report.truncated ? ' (truncated)' : ''}`);
    if (!report.complete) output.log(`Incomplete reasons: ${report.incompleteReasons.join(', ')}`);
    output.log(`Budget: ${Math.round(budget.elapsedMs)} ms elapsed of ${budget.maxDurationMs} ms${budget.exhausted ? ' (exhausted)' : ''}`);
    output.log(`Measurements: ${measurements.measured} measured; ${measurements.unmeasured} unmeasured (${measurements.failed} failed, ${measurements.notAttempted} not attempted)`);
    output.log(`Skipped symlinks: ${report.skippedSymlinks}`);
    for (const entry of report.entries) {
      const bytes = entry.bytes !== null ? `${entry.bytes} bytes`
        : entry.measurement === 'not-attempted' ? 'not measured (budget exhausted)' : 'unknown (measurement failed)';
      output.log(`  ${JSON.stringify(entry.name)}: ${bytes}; modified ${entry.modifiedAt}`);
    }
    output.log(`Total measured: ${report.totalMeasuredBytes} bytes (inventory, not reclaimable space)`);
    if (measurements.unmeasured > 0) output.log(`Total excludes ${measurements.unmeasured} unmeasured entries; it is a lower bound.`);
    output.log(report.cleanupEligibility);
  }
  return 0;
}
