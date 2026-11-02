import { prepareGuardianRetryState } from '../core/fleet/guardian-retry-state.js';

export async function cmdFleetGuardianRetry(args: string[], prepare = prepareGuardianRetryState): Promise<number> {
  const values: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === '--json' && !json) { json = true; continue; }
    if (!['--manifest', '--source-state', '--output-state', '--repo', '--sha'].includes(flag) || values[flag] !== undefined || !args[i + 1] || args[i + 1]!.startsWith('--')) {
      process.stderr.write('error: invalid guardian-retry arguments\n'); return 2;
    }
    values[flag] = args[++i]!;
  }
  try {
    const summary = await prepare({
      manifest: values['--manifest'] ?? '', sourceState: values['--source-state'] ?? '', outputState: values['--output-state'] ?? '',
      repo: values['--repo'] ?? '', sha: values['--sha'] ?? '',
    });
    console.log(json ? JSON.stringify(summary) : `guardian-retry: removed=${summary.removed} retained=${summary.retained} next=${summary.nextAction}`);
    return 0;
  } catch {
    process.stderr.write('error: guardian-retry could not validate or prepare retry state\n');
    return 3;
  }
}
