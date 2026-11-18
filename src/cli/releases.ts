/** `phm releases`: thin handler. Parses argv and prints the report built in core/release/status.ts. */
import { readReleases, releasesText, type ReadReleasesOptions, type ReleasesV1 } from '../core/release/status.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: phm releases [--json] [--root <directory>]
What is unreleased in each Ashlr repo: the latest tag on the default branch and its age, commits and merged PRs since,
whether the changelog's Unreleased section covers them, and one next action: "nothing to release", "write changelog" or
"ready: open release PR". Reads local Git refs only (fetch first for fresh numbers); never tags, releases or opens a PR.
  --json              print the typed report (schema phantom.releases.v1); summary is the field Home reuses
  --root <directory>  parent of the repo checkouts (default ~/Projects/ashlrai)
Anything whose source is missing prints as unknown with the reason, never as zero.`;

export async function cmdReleases(args: string[], read: (opts: ReadReleasesOptions) => Promise<ReleasesV1> = readReleases): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  let json = false, root: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--root' && root === undefined && args[i + 1] && !args[i + 1]!.startsWith('-')) root = args[++i];
    else { console.error(`phm releases: unknown or incomplete option ${args[i]}\n${usage}`); return 2; }
  }
  const report = sanitizePublicJson(await read(root ? { root } : {})) as ReleasesV1;
  console.log(json ? JSON.stringify(report) : releasesText(report).join('\n'));
  return 0;
}
