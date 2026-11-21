/** `phm fleet landed`: thin handler. The logic lives in core/fleet/landed-from-git.ts. */
import { landedHeadline, landedLine, landedReposFromEnv, readLandedFromGit, type LandedFromGit } from '../core/fleet/landed-from-git.js';

const USAGE = 'Usage: phm fleet landed [--since 24h] [--json]';
const HELP = `${USAGE}
Which jobs reached the default branch? Read from git alone (git fetch origin, then job ids in commit subjects and bodies), so it works where gh cannot run. Run it inside a checkout of the repo; set ASHLR_LANDED_REPOS to comma-separated checkout paths to count several repos (the first line then names each repo's count). A shallow checkout is deepened to the window.
One line per job: id, repo, merge commit short sha, time. A failed fetch says so plainly and lists nothing.
--json prints fleet.landed.v1 with source "git". Exit 0 report, 1 git unreadable, 2 bad usage. Reads only.`;

export interface FleetLandedDeps { read?: (sinceHours: number) => LandedFromGit }

export async function cmdFleetLanded(args: string[], deps: FleetLandedDeps = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(HELP); return 0; }
  let json = false, sinceHours = 24;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--since') {
      const m = /^(\d+(?:\.\d+)?)([hd])$/.exec(args[++i] ?? '');
      sinceHours = m ? Number(m[1]) * (m[2] === 'd' ? 24 : 1) : NaN;
      if (!(sinceHours > 0 && sinceHours <= 8760)) { console.error(`${USAGE}\n--since takes a number and h or d, like 24h.`); return 2; }
    } else { console.error(USAGE); return 2; }
  }
  const report = (deps.read ?? (hours => readLandedFromGit({ sinceHours: hours, repos: landedReposFromEnv() })))(sinceHours);
  if (json) console.log(JSON.stringify(report));
  else { console.log(landedHeadline(report)); for (const job of report.jobs) console.log(landedLine(job)); }
  return report.ok ? 0 : 1;
}
