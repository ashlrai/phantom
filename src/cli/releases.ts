import { readReleases, releaseRepo, type ReadReleasesOptions, type ReleasesV1 } from '../core/release/releases.js';
import { releaseRowLine } from '../core/release/releases-shape.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: phm releases [--json] [--repo <name>] [--root <directory>]\nRead published releases, drafts and merged PRs since publication. Missing evidence stays unknown.';
export async function cmdReleases(args: string[], read: (opts: ReadReleasesOptions) => Promise<ReleasesV1> = readReleases): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  const opts: ReadReleasesOptions = {}; let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if ((arg === '--root' || arg === '--repo') && !opts[arg.slice(2) as 'root' | 'repo'] && args[i + 1] && !args[i + 1]!.startsWith('-')) opts[arg.slice(2) as 'root' | 'repo'] = args[++i];
    else { console.error(usage); return 2; }
  }
  if (opts.repo !== undefined && !releaseRepo(opts.repo)) { console.error('Unknown enrolled repository'); return 2; }
  const report = sanitizePublicJson(await read(opts)) as ReleasesV1;
  console.log(json ? JSON.stringify(report) : report.repos.map(releaseRowLine).join('\n'));
  return 0;
}
