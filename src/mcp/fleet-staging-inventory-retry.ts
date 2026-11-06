import { cmdFleetStagingInventoryRetry } from '../cli/fleet-staging-inventory-retry.js';
import type { StagingScanner } from './fleet-staging-inventory-batch.js';

// The CLI owns report validation and the 1 MiB encoded-input limit.
export async function retryStagingInventory(args: Record<string, unknown>, scanner?: StagingScanner): Promise<unknown | null> {
  if (Object.keys(args).length !== 1 || !Object.hasOwn(args, 'report')) return null;
  let encoded: string;
  try {
    encoded = JSON.stringify(args.report);
    if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > 1024 * 1024) return null;
  } catch { return null; }
  let output = '';
  const input = (async function* () { yield encoded; })();
  const status = await cmdFleetStagingInventoryRetry(['--stdin', '--json'], {
    input, scanner, output: { log: line => { output = line; }, error: () => {} },
  });
  if (status === 2) return null;
  return JSON.parse(output) as unknown;
}
