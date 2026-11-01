/** Publish one explicit failed scheduled run; no polling or workflow mutations. */
import type { CloudGh } from '../core/cloud/pr-actions.js';
import type { BusInboxOptions } from '../core/fleet/bus-inbox.js';
import { publishCiIncident, validCiPublishInput } from '../core/fleet/ci-bus-incident.js';

export async function cmdFleetCiPublish(args: string[], deps: { gh?: CloudGh; bus?: BusInboxOptions } = {}): Promise<number> {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if ((arg === '--json' || arg === '--dry-run') && !flags.has(arg)) flags.add(arg);
    else if ((arg === '--repo' || arg === '--run' || arg === '--to') && !values.has(arg) && args[i + 1] && !args[i + 1]!.startsWith('--')) values.set(arg, args[++i]!);
    else {
      console.error('usage: ashlr fleet ci-publish --repo <owner/name> --run <id> --to <bus-address> [--dry-run] [--json]');
      return 2;
    }
  }
  const repo = values.get('--repo') ?? '', run = values.get('--run') ?? '', to = values.get('--to') ?? '';
  if (!validCiPublishInput(repo, run, to)) {
    console.error('ci-publish: valid --repo, --run and --to are required');
    return 2;
  }
  const result = await publishCiIncident({ repo, run, to, dryRun: flags.has('--dry-run') }, deps);
  if (flags.has('--json') || result.status !== 'error') console.log(JSON.stringify(result));
  else console.error(`ci-publish: ${result.reason}`);
  return result.status === 'error' ? 1 : 0;
}
