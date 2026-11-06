import { compactGuardianState, type GuardianCompactOptions } from '../core/fleet/guardian-state-compact.js';

// Deliberately a const-arrow export: this job must not touch the shared
// fleet-subcommand registry, whose generator only collects `export async
// function` verbs. Convention dispatch activates with the next registry pass.
export const cmdFleetGuardianCompact = async (args: string[], compact = compactGuardianState): Promise<number> => {
  const values: Record<string, string> = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === '--json' && !json) { json = true; continue; }
    if (!['--manifest', '--source-state', '--output-state'].includes(flag) || values[flag] !== undefined || !args[i + 1] || args[i + 1]!.startsWith('--')) {
      process.stderr.write('error: invalid guardian-compact arguments\n'); return 2;
    }
    values[flag] = args[++i]!;
  }
  if (!values['--manifest'] || !values['--source-state'] || !values['--output-state']) {
    process.stderr.write('error: invalid guardian-compact arguments\n'); return 2;
  }
  const options: GuardianCompactOptions = { manifest: values['--manifest'], sourceState: values['--source-state'], outputState: values['--output-state'] };
  try {
    const counts = await compact(options);
    // Bounded output only: counts and a fixed next-action hint, no raw paths or errors.
    console.log(json
      ? JSON.stringify({ ...counts, nextAction: 'fleet guardian-verify --state <output-state>' })
      : `guardian-compact: before=${counts.before} retained=${counts.retained} removed=${counts.removed}`);
    return 0;
  } catch {
    process.stderr.write('error: guardian-compact could not validate or compact state\n');
    return 1;
  }
};
