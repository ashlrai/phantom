import { diagnoseGuardianHealth, readFleetHealthAge, readGuardianLogHealth, readGuardianServiceHealth } from '../core/fleet/health-age.js';
export type { FleetHealthAge } from '../core/fleet/health-age.js';

const USAGE = 'phm fleet health-age [--diagnose] [--service] [--log] [--json]\nRead guardian status age and optionally check its launchd service and recent log errors; --diagnose runs every check and lists repairs. Exit 0: healthy; 1: unhealthy or unknown; 2: invalid arguments.\nReads ~/.ashlr-runs/supervisor/status-main-guardian.md; fresh means at most 30 minutes old.';

export async function cmdFleetHealthAge(
  args: string[],
  opts: { runsDir?: string; now?: () => number; service?: typeof readGuardianServiceHealth } = {},
): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(USAGE);
    return 0;
  }
  if (args.some(arg => !['--json', '--service', '--log', '--diagnose'].includes(arg)) || new Set(args).size !== args.length) {
    console.error(USAGE);
    return 2;
  }
  const report = await readFleetHealthAge(opts);
  const service = (args.includes('--service') || args.includes('--diagnose')) ? await (opts.service ?? readGuardianServiceHealth)() : null;
  const log = (args.includes('--log') || args.includes('--diagnose')) ? await readGuardianLogHealth(opts) : null;
  const statusDiagnostic = report.status === 'fresh' ? 'Guardian status is fresh.'
    : 'Check the guardian status file and service logs; verify the system clock if the timestamp is in the future.';
  const diagnosis = args.includes('--diagnose') ? diagnoseGuardianHealth({ age: report, service, log }) : null;
  if (args.includes('--json')) console.log(JSON.stringify({ ...report, ...(service ? { statusDiagnostic, service } : {}), ...(log ? { log } : {}), ...(diagnosis ? { diagnosis } : {}) }));
  else {
    console.log(`Guardian status: ${report.status}; age: ${report.ageSeconds === null ? 'unknown' : `${Math.floor(report.ageSeconds)} seconds`}; limit: ${report.maxAgeSeconds} seconds.`);
    if (report.status !== 'fresh') console.log(statusDiagnostic);
    if (service) console.log(service.diagnostic);
    if (log) console.log(`Guardian log: ${log.source}; recent errors: ${log.recentErrors ?? 'unknown'}; undated errors: ${log.unparseableErrors ?? 'unknown'}.`);
    if (diagnosis) {
      console.log(diagnosis.healthy ? 'Guardian is healthy.' : 'Repairs:');
      for (const p of diagnosis.problems) console.log(`- ${p.problem} ${p.repair}`);
    }
  }
  return report.status === 'fresh' && (!log || (log.source === 'healthy' && log.recentErrors === 0 && log.unparseableErrors === 0)) && (!service || (service.state === 'loaded' && service.lastExitCode === 0)) ? 0 : 1;
}
