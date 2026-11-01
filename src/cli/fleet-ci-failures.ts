import type { CloudGh } from '../core/cloud/pr-actions.js';
import { collectCiFailureGroups } from '../core/fleet/ci-failure-groups.js';

const USAGE = 'ashlr fleet ci-failures [--repo OWNER/REPO] [--hours 1-720] [--json]';
export async function cmdFleetCiFailures(args: string[], deps: { gh?: CloudGh; now?: () => Date } = {}): Promise<number> {
  let repo = 'ashlrai/phantom', hours = 24, json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') { console.log(`usage: ${USAGE}`); return 0; }
    if (seen.has(arg)) { process.stderr.write(`error: duplicate ${arg}\n`); return 2; }
    seen.add(arg);
    if (arg === '--json') json = true;
    else if (arg === '--repo') repo = args[++i] ?? '';
    else if (arg === '--hours') { const value = args[++i] ?? ''; hours = /^\d+$/.test(value) ? Number(value) : NaN; }
    else { process.stderr.write(`error: invalid argument ${arg}\nusage: ${USAGE}\n`); return 2; }
  }
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})\/[a-zA-Z0-9_.-]{1,100}$/.test(repo) || repo.endsWith('/.') || repo.endsWith('/..') || !Number.isInteger(hours) || hours < 1 || hours > 720) {
    process.stderr.write(`error: invalid repo or hours\nusage: ${USAGE}\n`); return 2;
  }
  const report = await collectCiFailureGroups(repo, hours, (deps.now ?? (() => new Date()))(), deps.gh);
  if (json) console.log(JSON.stringify(report));
  else {
    console.log(`CI failures for ${repo}: ${report.coverage.from} to ${report.coverage.to} (${report.coverage.complete ? 'complete' : 'PARTIAL'}; ${report.coverage.runsFetched} runs)`);
    for (const group of report.groups) console.log(`  ${group.latestRunCount} latest run(s), ${group.historicalAttemptCount} earlier attempt(s), PRs ${group.distinctPullRequests ?? 'unknown'}: ${group.workflowPath} / ${group.event} / ${group.jobName} / ${group.conclusion}\n    ${group.evidence[0]?.jobUrl ?? ''}`);
    for (const issue of [...report.coverage.truncations, ...report.coverage.errors]) console.log(`  PARTIAL: ${issue}`);
  }
  return report.coverage.complete ? 0 : 1;
}
