/** `phm doctor build`: thin handler. The logic lives in core/fleet/build-live.ts. */
import { buildLiveLines, readBuildLive, type BuildLiveReport } from '../core/fleet/build-live.js';

const usage = 'Usage: phm doctor build [--json] [--fetch]';
const help = `${usage}
Is the phm running on this host the code the fleet merged? Prints the running commit (embedded at build time, else HEAD of the directory phm runs from), its branch, and how many commits it is behind origin/master (the local ref, no network by default; a host that never fetches reads current while master moves), then one verdict line. --fetch first refreshes origin's master ref (network), and says so when that fails.
Unknown stays unknown, with the reason. Exit 0 report, 2 bad usage. Reads only; never pulls, checks out or rebuilds, and fetches only with --fetch.`;

export async function cmdDoctorBuild(args: string[], read: (opts: { fetch: boolean }) => BuildLiveReport = o => readBuildLive(o)): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(help); return 0; }
  if (args.some(a => a !== '--json' && a !== '--fetch')) { console.error(usage); return 2; }
  const report = read({ fetch: args.includes('--fetch') });
  if (args.includes('--json')) console.log(JSON.stringify(report));
  else for (const line of buildLiveLines(report)) console.log(line);
  return 0;
}
