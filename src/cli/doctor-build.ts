/** `phm doctor build`: thin handler. The logic lives in core/fleet/build-live.ts. */
import { buildLiveLines, readBuildLive, type BuildLiveReport } from '../core/fleet/build-live.js';

const usage = 'Usage: phm doctor build [--json]';
const help = `${usage}
Is the phm running on this host the code the fleet merged? Prints the running commit (embedded at build time, else HEAD of the directory phm runs from), its branch, and how many commits it is behind origin/master (the local ref, no network), then one verdict line.
Unknown stays unknown, with the reason. Exit 0 report, 2 bad usage. Reads only; never fetches, pulls, checks out or rebuilds.`;

export async function cmdDoctorBuild(args: string[], read: () => BuildLiveReport = () => readBuildLive()): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(help); return 0; }
  if (args.some(a => a !== '--json')) { console.error(usage); return 2; }
  const report = read();
  if (args.includes('--json')) console.log(JSON.stringify(report));
  else for (const line of buildLiveLines(report)) console.log(line);
  return 0;
}
