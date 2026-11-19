/** `phm disk runway [--json]`: hours of free disk left before launches freeze. Thin: the work is core/fleet/disk-runway.ts. Read-only. */
import { sanitizePublicJson } from '../core/util/public-json.js';
import { formatDiskRunway, readDiskRunway, type DiskRunwayDeps } from '../core/fleet/disk-runway.js';

const USAGE = 'usage: phm disk runway [--json]';
type Output = { log: (message: string) => void; error: (message: string) => void };

export async function cmdDiskRunway(args: string[], deps: DiskRunwayDeps & { output?: Output } = {}): Promise<number> {
  const output = deps.output ?? { log: console.log, error: console.error };
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    output.log(`${USAGE}\n` +
      'Read-only: free GB now, GB lost per hour over the last 6 hours, hours until the\n' +
      '60 GB launch freeze, the worktree count, and the ten largest worktrees grouped\n' +
      'as merged PR, empty or unpublished (the same classifier as phm disk --plan).\n' +
      '--json prints the typed fleet.disk-runway.v1 report. Deletes nothing.');
    return 0;
  }
  if (args.some(arg => arg !== '--json') || args.length > 1) { output.error(`error: invalid argument\n${USAGE}`); return 2; }
  const report = await readDiskRunway(deps);
  if (args[0] === '--json') output.log(JSON.stringify(sanitizePublicJson(report)));
  else for (const line of formatDiskRunway(report)) output.log(line);
  return 0;
}
