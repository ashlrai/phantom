import { readFleetHealthAge, readGuardianServiceHealth } from '../core/fleet/health-age.js';
export type { FleetHealthAge } from '../core/fleet/health-age.js';

const USAGE = 'phm fleet health-age [--service] [--json]\nRead guardian status age and optionally check its launchd service. Exit 0: healthy; 1: unhealthy or unknown; 2: invalid arguments.\nReads ~/.ashlr-runs/supervisor/status-main-guardian.md; fresh means at most 30 minutes old.';

export async function cmdFleetHealthAge(
  args: string[],
  opts: { runsDir?: string; now?: () => number; service?: typeof readGuardianServiceHealth } = {},
): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(USAGE);
    return 0;
  }
  if (args.some(arg => !['--json', '--service'].includes(arg)) || new Set(args).size !== args.length) {
    console.error(USAGE);
    return 2;
  }
  const report = await readFleetHealthAge(opts);
  const service = args.includes('--service') ? await (opts.service ?? readGuardianServiceHealth)() : null;
  const statusDiagnostic = report.status === 'fresh' ? 'Guardian status is fresh.'
    : 'Check the guardian status file and service logs; verify the system clock if the timestamp is in the future.';
  if (args.includes('--json')) console.log(JSON.stringify(service ? { ...report, statusDiagnostic, service } : report));
  else {
    console.log(`Guardian status: ${report.status}; age: ${report.ageSeconds === null ? 'unknown' : `${Math.floor(report.ageSeconds)} seconds`}; limit: ${report.maxAgeSeconds} seconds.`);
    if (report.status !== 'fresh') console.log(statusDiagnostic);
    if (service) console.log(service.diagnostic);
  }
  return report.status === 'fresh' && (!service || (service.state === 'loaded' && service.lastExitCode === 0)) ? 0 : 1;
}
