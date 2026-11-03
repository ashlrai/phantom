import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { CloudGh } from '../core/cloud/pr-actions.js';
import { defaultCloudGh } from '../core/cloud/tracker.js';
import { recutDropJob } from '../core/fleet/recut-drop-body.js';
import { countQueuedDropJobPrompts, DROP_JOB_QUEUE_LIMIT, dropJobExists, DropJobExistsError, resolveDropJobRoot, writeDropJob } from '../core/fleet/drop-job-writer.js';
import { cmdFleetDirtyLanded, type DirtyLandedPr } from './fleet-dirty-landed.js';

const USAGE = 'Usage: phm fleet merge-recover [--apply] [--json] [--runs-dir <absolute path>]\nPreview stale conflicting fleet PRs. Apply queues isolated recuts; run again after publication to request auto-merge. Required checks remain enforced.';
const REPO = 'ashlrai/phantom';
const HOLDS = new Set([197, 878, 743, 725, 738, 744, 693, 1228]);
const FIELDS = 'number,title,state,headRefOid,baseRefName,isDraft,mergeStateStatus,autoMergeRequest';
interface Pr { number: number; title: string; state: string; headRefOid: string; baseRefName: string; isDraft: boolean; mergeStateStatus: string; autoMergeRequest: unknown }
export interface MergeRecoverDeps {
  gh?: CloudGh;
  inspect?: () => Promise<DirtyLandedPr[]>;
  exists?: (root: string, id: string) => Promise<boolean>;
  write?: typeof writeDropJob;
  output?: (text: string) => void;
}
export async function cmdFleetMergeRecover(args: string[], deps: MergeRecoverDeps = {}): Promise<number> {
  const output = deps.output ?? console.log;
  if (args.length === 1 && args[0] === '--help') { output(USAGE); return 0; }
  let apply = false, json = false, root: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) { output(USAGE); return 2; }
    seen.add(arg);
    if (arg === '--apply') apply = true;
    else if (arg === '--json') json = true;
    else if (arg === '--runs-dir' && isAbsolute(args[i + 1] ?? '')) root = args[++i];
    else { output(USAGE); return 2; }
  }
  const gh = deps.gh ?? defaultCloudGh;
  const rows: { pr: number; action: string }[] = [];
  let failed = false, queued = 0;
  const read = async (argv: string[]): Promise<unknown> => {
    const result = await gh(argv);
    if (!result.ok) throw new Error('read');
    return JSON.parse(result.stdout);
  };
  const valid = (p: Pr) => p && Number.isSafeInteger(p.number) && p.number > 0
    && typeof p.title === 'string' && /^[a-f0-9]{40}$/.test(p.headRefOid)
    && ['OPEN', 'CLOSED', 'MERGED'].includes(p.state) && typeof p.isDraft === 'boolean';
  try {
    const prs = await (deps.inspect ?? (async () => {
      let text = '';
      if (await cmdFleetDirtyLanded(['--json'], { gh, output: t => { text = t; } })) throw new Error('inspect');
      return (JSON.parse(text) as { prs: DirtyLandedPr[] }).prs;
    }))();
    for (const pr of prs) {
      if (HOLDS.has(pr.number)) { rows.push({ pr: pr.number, action: 'held' }); continue; }
      const job = recutDropJob(pr, 0);
      if ('reason' in job || !['main', 'master'].includes(pr.base)) continue;
      // Stable across dates and processes; a changed source head is a new recovery.
      job.id = `MR${createHash('sha256').update(`${pr.number}:${pr.head}`).digest('hex').slice(0, 32).toUpperCase()}`;
      job.body = job.body.replaceAll('master', pr.base);
      const title = `bridge: RQ-PHX-${job.id}`;
      try {
        const current = await read(['pr', 'view', String(pr.number), '--repo', REPO, '--json', FIELDS]) as Pr;
        if (!valid(current)) throw new Error('invalid');
        let action = 'source-changed';
        if (current.state !== 'OPEN') action = current.state.toLowerCase();
        else if (current.headRefOid === pr.head && current.baseRefName === pr.base && !current.isDraft && current.mergeStateStatus === 'DIRTY') {
          const matches = await read(['pr', 'list', '--repo', REPO, '--state', 'all', '--search', `in:title "${title}"`, '--json', FIELDS]) as Pr[];
          if (!Array.isArray(matches) || !matches.every(valid)) throw new Error('invalid');
          const replacements = matches.filter(p => p.title === title);
          if (replacements.length > 1) throw new Error('ambiguous');
          const replacement = replacements[0];
          if (replacement) {
            action = `replacement-${replacement.state.toLowerCase()}`;
            if (replacement.state === 'OPEN' && !replacement.isDraft && replacement.baseRefName === pr.base && ['CLEAN', 'BLOCKED', 'BEHIND', 'UNSTABLE', 'HAS_HOOKS'].includes(replacement.mergeStateStatus)) {
              action = replacement.autoMergeRequest ? 'auto-merge-requested' : 'request-auto-merge';
              if (apply && !replacement.autoMergeRequest) {
                const result = await gh(['pr', 'merge', String(replacement.number), '--repo', REPO, '--auto', '--match-head-commit', replacement.headRefOid]);
                if (!result.ok) throw new Error('merge request');
                action = 'auto-merge-requested';
              }
            }
          } else if (await (deps.exists ?? dropJobExists)(resolveDropJobRoot(root), job.id)) action = 'recut-queued';
          else {
            if (queued >= 2) { rows.push({ pr: pr.number, action: 'capped' }); continue; }
            queued++;
            action = 'queue-recut';
            // The worker leaves edits uncommitted; the existing router publisher owns publication.
            job.body += `\nRecovery identity: ${title}. The sanctioned router publisher must use this exact PR title. Never bypass required checks or the merge queue.\n`;
            if (apply) {
              if (!deps.write && await countQueuedDropJobPrompts(resolveDropJobRoot(root)) >= DROP_JOB_QUEUE_LIMIT) throw new Error('queue full');
              try { await (deps.write ?? writeDropJob)(resolveDropJobRoot(root), job); }
              catch (e) { if (!(e instanceof DropJobExistsError)) throw e; }
              action = 'recut-queued';
            }
          }
        }
        rows.push({ pr: pr.number, action });
      } catch { failed = true; rows.push({ pr: pr.number, action: 'failed' }); }
    }
  } catch { failed = true; }
  const report = { schema: 'fleet.merge-recover.v1', dryRun: !apply, ok: !failed, rows };
  output(json ? JSON.stringify(report) : `${USAGE}\n${rows.map(r => `#${r.pr}: ${r.action}`).join('\n')}`);
  return failed ? 1 : 0;
}
