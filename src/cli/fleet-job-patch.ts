import { jobPatch, validPatchPath } from '../core/fleet/job-patch.js';
import { validJobId } from '../core/fleet/job-path-history.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: ashlr fleet job-patch RQ-ID [--path repo/relative/file] [--json]';

export async function cmdFleetJobPatch(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  let job: string | undefined, path: string | undefined, json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) json = true;
    else if (arg === '--path' && path === undefined) {
      path = args[++i];
      if (!path || !validPatchPath(path)) { console.error(usage); return 2; }
    } else if (!arg.startsWith('-') && job === undefined) job = arg;
    else { console.error(usage); return 2; }
  }
  if (!job || !validJobId(job)) { console.error(usage); return 2; }
  try {
    const result = await jobPatch(job, path);
    if (json) console.log(JSON.stringify(result));
    else console.log(sanitizePublicJson(`${result.jobId}: ${result.status}\nRef: ${result.resolvedRef}\nCommit: ${result.commit ?? 'none'} PR: ${result.pr ?? 'unknown'}\nPaths: ${result.paths.join(', ')}\nScanned: ${result.scanned}/${result.scanBound}; scan may be truncated: ${result.scanMayBeTruncated}; more matches: ${result.matchesTruncated}\nPatch truncated: ${result.patchTruncated}\n${result.patch}`));
    return 0;
  } catch { console.error('error: unable to read job patch or path is not in the matching commit'); return 1; }
}
