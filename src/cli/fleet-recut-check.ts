import { checkPrRecut, validRecutIdentity, type PrRecutCheckDeps } from '../core/fleet/pr-recut-check.js';
import { scrubSecrets } from '../core/util/scrub.js';

const usage = 'Usage: ashlr fleet recut-check <N> [--repo owner/name] [--json]';
export async function cmdFleetRecutCheck(args: string[], deps: PrRecutCheckDeps = {}): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(usage); return 0; }
  const pr = Number(args[0]);
  let repo = 'ashlrai/phantom';
  let json = false, repoSeen = false, valid = /^\d+$/.test(args[0] ?? '');
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--repo' && !repoSeen && args[i + 1]) { repoSeen = true; repo = args[++i]!; }
    else valid = false;
  }
  if (!valid || !validRecutIdentity(pr, repo)) { console.error(usage); return 2; }
  const report = await checkPrRecut(pr, repo, deps);
  const files = (paths: string[] | null) => paths === null ? 'unknown' : paths.join(', ') || 'none';
  console.log(scrubSecrets(json ? JSON.stringify(report) : `${report.next}\nAlready on master: ${files(report.alreadyOnMasterFiles)}\nRemaining files: ${files(report.remainingFiles)}`));
  return report.alreadyOnMaster === null ? 1 : 0;
}
