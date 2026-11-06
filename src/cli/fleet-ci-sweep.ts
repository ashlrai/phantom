import type { CloudGh } from '../core/cloud/pr-actions.js';
import type { BusInboxOptions } from '../core/fleet/bus-inbox.js';
import { validCiPublishInput } from '../core/fleet/ci-bus-incident.js';
import { sweepScheduledCi } from '../core/fleet/ci-scheduled-sweep.js';
import { scrubSecrets } from '../core/util/scrub-secrets.js';

export async function cmdFleetCiSweep(args: string[], deps: { gh?: CloudGh; bus?: BusInboxOptions } = {}): Promise<number> {
  const values = new Map<string, string>(), flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if ((arg === '--json' || arg === '--dry-run') && !flags.has(arg)) flags.add(arg);
    else if ((arg === '--repo' || arg === '--to') && !values.has(arg) && args[i + 1] && !args[i + 1]!.startsWith('-')) values.set(arg, args[++i]!);
    else { console.error('usage: ashlr fleet ci-sweep --repo <owner/name> --to <bus-address> [--dry-run] [--json]'); return 2; }
  }
  const repo = values.get('--repo') ?? '', to = values.get('--to') ?? '';
  if (!validCiPublishInput(repo, '1', to)) { console.error('ci-sweep: valid --repo and --to are required'); return 2; }
  const report = await sweepScheduledCi({ repo, to, dryRun: flags.has('--dry-run') }, deps);
  console.log(scrubSecrets(JSON.stringify(report)));
  return report.error ? 1 : 0;
}
