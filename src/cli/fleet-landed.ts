/** `phm fleet landed`: thin handler. The logic lives in core/fleet/landed-from-git.ts. */
import { landedHeadline, landedLine, landedReposFromEnv, readLandedFromGit, type LandedFromGit } from '../core/fleet/landed-from-git.js';

const USAGE = 'Usage: phm fleet landed [--since 24h] [--job <id>]... [--json]';
const HELP = `${USAGE}
Which jobs reached the default branch? Read from git alone (git fetch origin, then job ids in commit subjects), so it works where gh cannot run. Run it inside a checkout of the repo; set ASHLR_LANDED_REPOS to comma-separated checkout paths to count several repos (the first line then names each repo's count). A shallow checkout is deepened to the window.
Repeat --job to select exact IDs; absence means only that the ID was not observed in the searched window. A failed repository read makes an otherwise absent ID unknown. One line per landed job includes its repository, commit and time.
--json prints fleet.landed.v1 with source "git". Exit 0 report, 1 git unreadable, 2 bad usage. Reads only.`;

export interface FleetLandedDeps { read?: (sinceHours: number) => LandedFromGit }

export async function cmdFleetLanded(args: string[], deps: FleetLandedDeps = {}): Promise<number> {
  if (!args.includes('--job') && (args.includes('--help') || args.includes('-h'))) { console.log(HELP); return 0; }
  let json = false, sinceHours = 24;
  const ids: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--job') {
      const id = args[++i] ?? '';
      if (!/^RQ-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(id)) { console.error(`${USAGE}\n--job requires a valid job id.`); return 2; }
      if (!ids.includes(id)) ids.push(id);
    } else if (arg === '--since') {
      const m = /^(\d+(?:\.\d+)?)([hd])$/.exec(args[++i] ?? '');
      sinceHours = m ? Number(m[1]) * (m[2] === 'd' ? 24 : 1) : NaN;
      if (!(sinceHours > 0 && sinceHours <= 8760)) { console.error(`${USAGE}\n--since takes a number and h or d, like 24h.`); return 2; }
    } else { console.error(USAGE); return 2; }
  }
  const report = (deps.read ?? (hours => readLandedFromGit({ sinceHours: hours, repos: landedReposFromEnv() })))(sinceHours);
  if (ids.length) {
    const results = ids.map(id => {
      const hit = report.jobs.find(job => job.id === id);
      return hit ? { ...hit, state: 'landed' as const } : {
        id, state: report.repos.length && report.repos.every(repo => repo.ok)
          ? 'not-observed-in-window' as const : 'unknown' as const,
      };
    });
    if (json) console.log(JSON.stringify({ ...report, jobs: report.jobs.filter(job => ids.includes(job.id)), results }));
    else {
      console.log(`Searched the last ${report.sinceHours} h (from git).`);
      for (const result of results) console.log(result.state === 'landed'
        ? `${result.id}: landed ${result.repo} ${result.sha} ${result.at}`
        : `${result.id}: ${result.state}`);
    }
    return results.some(result => result.state === 'unknown') ? 1 : 0;
  }
  if (json) console.log(JSON.stringify(report));
  else { console.log(landedHeadline(report)); for (const job of report.jobs) console.log(landedLine(job)); }
  return report.ok ? 0 : 1;
}
