import { defaults, readRuntimeSnapshot, type FleetRuntimeDeps } from '../core/fleet/runtime-snapshot.js';
export type { FleetRuntimeDeps } from '../core/fleet/runtime-snapshot.js';

const usage = 'Usage: ashlr fleet runtime [--json]';

/** One read-only snapshot; failures never expose raw exceptions or store contents. */
export async function cmdFleetRuntime(args: string[], deps: FleetRuntimeDeps = defaults): Promise<number> {
  if (args.some(arg => !['--json', '--help', '-h'].includes(arg))) {
    console.error(usage); return 2;
  }
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  const report = await readRuntimeSnapshot(deps);
  const { installedVersion, stateRoot, lastFleetStateRead, coordination, execution, reasons } = report;
  console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : [
    `host: ${report.host}; tailnet: ${report.tailnetName}`,
    `phantom: ${installedVersion}${report.sourceVersion ? `; source: ${report.sourceVersion}` : ''}`,
    `process: ${report.pid}; uptime: ${report.uptimeSeconds}s; ${report.platform}/${report.arch}`,
    `state: ${stateRoot}; mtime: ${lastFleetStateRead.mtime}; age: ${lastFleetStateRead.ageSeconds}s; asOf: ${report.asOf}${reasons.length ? `; ${reasons.join('; ')}` : ''}`,
    `coordination: ${coordination.state}; active claims: ${coordination.activeClaims}; newest return age: ${coordination.newestReturnAgeSeconds}s${coordination.reason ? `; ${coordination.reason}` : ''}`,
    execution ? `execution: ${execution.state}; running: ${execution.running}; claimedNoWorker: ${execution.claimedNoWorker}; unknown: ${execution.unknown}${execution.reason ? `; ${execution.reason}` : ''}` : 'execution: UNKNOWN',
  ].join('\n'));
  return 0;
}
