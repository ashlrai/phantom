import type { CloudGh } from '../core/cloud/pr-actions.js';
import { collectCiRepairPacket } from '../core/fleet/ci-repair-packet.js';
import type { GitRunner } from '../core/verse/git-ops.js';

const USAGE = 'usage: ashlr fleet ci-packet [--repo OWNER/REPO] [--hours 1-720] [--max-groups 1-10] [--json] [--help]';
export async function cmdFleetCiPacket(args: string[], deps: { gh?: CloudGh; runner?: GitRunner; now?: () => Date } = {}): Promise<number> {
  let repo = 'ashlrai/phantom', hours = 24, maxGroups = 3, json = false, help = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const key = arg === '-h' ? '--help' : arg;
    if (seen.has(key) || !['--help', '--json', '--repo', '--hours', '--max-groups'].includes(key)) { process.stderr.write(`Invalid arguments. ${USAGE}\n`); return 2; }
    seen.add(key);
    if (key === '--help') help = true;
    else if (key === '--json') json = true;
    else {
      const value = args[++i] ?? '';
      if (key === '--repo') repo = value;
      else if (key === '--hours') hours = /^\d+$/.test(value) ? Number(value) : NaN;
      else maxGroups = /^\d+$/.test(value) ? Number(value) : NaN;
    }
  }
  const owner = repo.split('/')[0]!;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(repo) || owner.endsWith('-') || owner.includes('--') || repo.endsWith('/.') || repo.endsWith('/..') || !Number.isInteger(hours) || hours < 1 || hours > 720 || !Number.isInteger(maxGroups) || maxGroups < 1 || maxGroups > 10) {
    process.stderr.write(`Invalid arguments. ${USAGE}\n`); return 2;
  }
  if (help) { console.log(USAGE); return 0; }
  const packet = await collectCiRepairPacket(repo, hours, maxGroups, (deps.now ?? (() => new Date()))(), deps);
  if (json) console.log(JSON.stringify(packet));
  else {
    console.log(`CI repair packet ${packet.repo}: ${packet.coverage.from} to ${packet.coverage.to} (${packet.complete ? 'complete' : 'PARTIAL'}; grouping ${packet.coverage.complete ? 'complete' : 'partial'})`);
    if (packet.noFailuresObserved) console.log('No failures observed in the covered interval.');
    for (const item of packet.items) {
      console.log(`  ${item.group.workflowPath} / ${item.group.jobName} (${item.group.conclusion}), attempt ${item.attempt}\n    ${item.runUrl}\n    Failed steps: ${item.evidence?.failedSteps.join(', ') || 'unavailable or none reported'}\n    Source: ${item.unavailable ?? 'complete'}`);
    }
    if (packet.historical.length) console.log(`  Historical failure groups: ${packet.historical.length} (earlier attempts only are not fresh incidents).`);
    console.log(`  Omitted: ${packet.omitted.groups} groups, ${packet.omitted.evidence} evidence items; ${packet.omitted.duplicateJobs} duplicate jobs.`);
  }
  return packet.complete ? 0 : 1;
}
