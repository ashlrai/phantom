import type { CloudGh } from '../core/cloud/pr-actions.js';
import { defaultCloudGh } from '../core/cloud/tracker.js';

const USAGE = 'Usage: ashlr fleet behind-sweep [--repo phantom] [--limit 10] [--apply] --json';
const QUERY = `query($owner:String!,$name:String!,$endCursor:String){
  repository(owner:$owner,name:$name){pullRequests(first:100,after:$endCursor,states:OPEN,
    orderBy:{field:CREATED_AT,direction:ASC}){
    nodes{number createdAt mergeStateStatus autoMergeRequest{enabledAt} headRefOid}
    pageInfo{hasNextPage endCursor}
  }}
}`;
interface BehindPr { number: number; createdAt: string; headRefOid: string }
export interface FleetBehindSweepDeps {
  gh?: CloudGh;
  output?: (text: string) => void;
  error?: (text: string) => void;
}

export async function cmdFleetBehindSweep(args: string[], deps: FleetBehindSweepDeps = {}): Promise<number> {
  const output = deps.output ?? console.log, error = deps.error ?? console.error;
  if (args.includes('--help') || args.includes('-h')) { output(USAGE); return 0; }
  let repo = 'ashlrai/phantom', limit = 10, apply = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) { error(USAGE); return 2; }
    seen.add(arg);
    if (arg === '--json') continue;
    if (arg === '--apply') apply = true;
    else if (arg === '--repo') {
      const value = args[++i] ?? '';
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9_.-]*)?$/.test(value)) { error(USAGE); return 2; }
      repo = value.includes('/') ? value : `ashlrai/${value}`;
    } else if (arg === '--limit') {
      const value = args[++i] ?? '';
      limit = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(limit) || limit < 1) { error(USAGE); return 2; }
    } else { error(USAGE); return 2; }
  }
  const gh = deps.gh ?? defaultCloudGh;
  const report = { v: 1, repo, dryRun: !apply, candidates: 0, planned: [] as BehindPr[], updated: [] as number[], failed: [] as number[], error: undefined as string | undefined };
  const finish = (code: number, message?: string) => {
    if (message) report.error = message;
    output(JSON.stringify(report));
    return code;
  };
  try {
    const [owner, name] = repo.split('/');
    const read = await gh(['api', 'graphql', '--paginate', '--slurp', '-f', `query=${QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`]);
    if (!read.ok) return finish(1, 'Could not read open pull requests.');
    const pages = JSON.parse(read.stdout) as unknown;
    if (!Array.isArray(pages) || pages.length === 0) throw new Error('Invalid pages');
    const candidates: BehindPr[] = [];
    for (const page of pages) {
      const nodes = page?.data?.repository?.pullRequests?.nodes;
      if (page?.errors || !Array.isArray(nodes)) throw new Error('Invalid page');
      for (const pr of nodes) {
        if (pr?.mergeStateStatus !== 'BEHIND' || !pr.autoMergeRequest) continue;
        if (!Number.isSafeInteger(pr.number) || pr.number < 1 || typeof pr.createdAt !== 'string'
          || !Number.isFinite(Date.parse(pr.createdAt)) || !/^[a-f0-9]{40}$/.test(pr.headRefOid)) throw new Error('Invalid pull request');
        candidates.push({ number: pr.number, createdAt: pr.createdAt, headRefOid: pr.headRefOid });
      }
    }
    candidates.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number);
    report.candidates = candidates.length;
    report.planned = candidates.slice(0, limit);
    if (apply) for (const pr of report.planned) {
      try {
        const update = await gh(['api', '--method', 'PUT', `repos/${repo}/pulls/${pr.number}/update-branch`, '-f', `expected_head_sha=${pr.headRefOid}`]);
        (update.ok ? report.updated : report.failed).push(pr.number);
      } catch { report.failed.push(pr.number); }
    }
    return finish(report.failed.length ? 1 : 0);
  } catch { return finish(1, 'Could not read open pull requests.'); }
}
