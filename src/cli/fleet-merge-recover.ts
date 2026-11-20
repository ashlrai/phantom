import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { CloudGh } from '../core/cloud/pr-actions.js';
import { defaultCloudGh } from '../core/cloud/tracker.js';
import { recutDropJob } from '../core/fleet/recut-drop-body.js';
import { countQueuedDropJobPrompts, DROP_JOB_QUEUE_LIMIT, dropJobExists, DropJobExistsError, resolveDropJobRoot, writeDropJob } from '../core/fleet/drop-job-writer.js';
import { cmdFleetDirtyLanded, type DirtyLandedPr } from './fleet-dirty-landed.js';
import { mergeQueueAge, validMergeQueueAgeInput } from './fleet-merge-queue-age.js';
import { reserveMergeRecoveryAttempt } from '../core/fleet/merge-recovery-budget.js';

const USAGE = 'Usage: phm fleet merge-recover [--queue-input <snapshot.json>] [--apply] [--json] [--runs-dir <absolute path>]\nPreview stale conflicting fleet PRs. A queue snapshot prioritizes the oldest measured entries and reports their wait. Apply queues isolated recuts; run again after publication to request auto-merge. Required checks remain enforced.';
const REPO = 'ashlrai/phantom';
/** Mason's own holds in ashlrai/phantom (AGENTS.md hold list); never auto-acted on. */
export const PHANTOM_PR_HOLDS = new Set([197, 878, 743, 725, 738, 744, 693, 1228]);
const FIELDS = 'number,title,state,headRefOid,baseRefName,isDraft,mergeStateStatus,autoMergeRequest';
const REPLACEMENT_LIMIT = 100;
interface Pr { number: number; title: string; state: string; headRefOid: string; baseRefName: string; isDraft: boolean; mergeStateStatus: string; autoMergeRequest: unknown }
export interface MergeRecoverDeps {
  gh?: CloudGh;
  inspect?: () => Promise<DirtyLandedPr[]>;
  exists?: (root: string, id: string) => Promise<boolean>;
  write?: typeof writeDropJob;
  reserve?: typeof reserveMergeRecoveryAttempt;
  output?: (text: string) => void;
  /** Limit the plan to these `number:head` pairs (used by `queue-latency --recover`). */
  only?: ReadonlySet<string>;
}
/** Plain-words reason for every row that is not progress. The original PR and its work are never closed or edited. */
export const MERGE_RECOVER_REASONS: Readonly<Record<string, string>> = {
  'replacement-conflict': 'The recut still conflicts with the default branch. The original PR stays open with all its work; a person or agent must resolve it.',
  'replacement-changed': 'The replacement PR was renamed or retargeted, so it is left alone. The original PR stays open.',
  'retry-limit': 'Recovery attempts for this PR are used up. The original PR stays open with all its work.',
  'source-changed': 'The PR moved since it was inspected. Run again to recover its new head.',
  'already-present-on-base': 'The default branch already has this work; nothing to recover.',
  'too-wide': 'More than 20 files remain, too wide for an automatic recut. The original PR stays open.',
  'owner-path': 'The PR touches owner-only paths, so only a person may recut it. The original PR stays open.',
  title: 'Not a fleet agent PR (`bridge: RQ-...`), so it is left alone.',
  held: 'On the hold list; never recovered automatically.',
  capped: 'Two recuts are queued per run; run again for the rest.',
  failed: 'A GitHub read or write failed. Nothing was changed; run again.',
};
export async function cmdFleetMergeRecover(args: string[], deps: MergeRecoverDeps = {}): Promise<number> {
  const output = deps.output ?? console.log;
  if (args.length === 1 && args[0] === '--help') { output(USAGE); return 0; }
  let apply = false, json = false, root: string | undefined, queuePath: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) { output(USAGE); return 2; }
    seen.add(arg);
    if (arg === '--apply') apply = true;
    else if (arg === '--json') json = true;
    else if (arg === '--runs-dir' && isAbsolute(args[i + 1] ?? '')) root = args[++i];
    else if (arg === '--queue-input' && args[i + 1] && !args[i + 1]!.startsWith('-')) queuePath = args[++i];
    else { output(USAGE); return 2; }
  }
  const gh = deps.gh ?? defaultCloudGh;
  const rows: { pr: number; action: string }[] = [];
  let failed = false, queued = 0;
  let queue: ReturnType<typeof mergeQueueAge> | null = null;
  const read = async (argv: string[]): Promise<unknown> => {
    const result = await gh(argv);
    if (!result.ok) throw new Error('read');
    return JSON.parse(result.stdout);
  };
  const valid = (p: Pr) => p && Number.isSafeInteger(p.number) && p.number > 0
    && typeof p.title === 'string' && /^[a-f0-9]{40}$/.test(p.headRefOid)
    && ['OPEN', 'CLOSED', 'MERGED'].includes(p.state) && typeof p.isDraft === 'boolean';
  try {
    if (queuePath) {
      const snapshot: unknown = JSON.parse(await readFile(queuePath, 'utf8'));
      if (!validMergeQueueAgeInput(snapshot)) throw new Error('invalid queue snapshot');
      queue = mergeQueueAge(snapshot);
    }
    const prs = (await (deps.inspect ?? (async () => {
      let text = '';
      if (await cmdFleetDirtyLanded(['--json'], { gh, output: t => { text = t; } })) throw new Error('inspect');
      return (JSON.parse(text) as { prs: DirtyLandedPr[] }).prs;
    }))()).filter(p => !deps.only || deps.only.has(`${p.number}:${p.head}`));
    const ranks = new Map<number, number>();
    queue?.entries.forEach((entry, index) => {
      if (entry.ageSeconds !== null && !entry.missingData.includes('unique_queue_entry')) ranks.set(entry.number, index);
    });
    for (const pr of [...prs].sort((a, b) => (ranks.get(a.number) ?? Infinity) - (ranks.get(b.number) ?? Infinity))) {
      if (PHANTOM_PR_HOLDS.has(pr.number)) { rows.push({ pr: pr.number, action: 'held' }); continue; }
      const job = recutDropJob(pr, 0);
      if ('reason' in job) { rows.push({ pr: pr.number, action: job.reason }); continue; }
      // Stable across dates and processes; a changed source head is a new recovery.
      job.id = `MR${createHash('sha256').update(`${pr.number}:${pr.head}`).digest('hex').slice(0, 32).toUpperCase()}`;
      const title = `bridge: RQ-PHX-${job.id}`;
      try {
        const current = await read(['pr', 'view', String(pr.number), '--repo', REPO, '--json', FIELDS]) as Pr;
        if (!valid(current) || current.number !== pr.number) throw new Error('invalid');
        const sourceUnchanged = async () => {
          const latest = await read(['pr', 'view', String(pr.number), '--repo', REPO, '--json', FIELDS]) as Pr;
          return valid(latest) && latest.number === pr.number && latest.state === 'OPEN'
            && latest.headRefOid === pr.head && latest.baseRefName === pr.base && !latest.isDraft && latest.mergeStateStatus === 'DIRTY';
        };
        let action = 'source-changed';
        if (current.state !== 'OPEN') action = current.state.toLowerCase();
        else if (current.headRefOid === pr.head && current.baseRefName === pr.base && !current.isDraft && current.mergeStateStatus === 'DIRTY') {
          const matches = await read(['pr', 'list', '--repo', REPO, '--state', 'all', '--limit', String(REPLACEMENT_LIMIT), '--search', `in:title "${title}"`, '--json', FIELDS]) as Pr[];
          // A full page cannot prove there is no second replacement.
          if (!Array.isArray(matches) || matches.length >= REPLACEMENT_LIMIT || !matches.every(valid)) throw new Error('invalid');
          const replacements = matches.filter(p => p.title === title);
          if (replacements.length > 1) throw new Error('ambiguous');
          const match = replacements[0];
          if (match) {
            if (PHANTOM_PR_HOLDS.has(match.number)) { rows.push({ pr: pr.number, action: 'held' }); continue; }
            // Search locates the PR; a direct read decides whether to re-arm it.
            const replacement = await read(['pr', 'view', String(match.number), '--repo', REPO, '--json', FIELDS]) as Pr;
            if (!valid(replacement) || replacement.number !== match.number) throw new Error('invalid');
            if (replacement.title !== title || replacement.baseRefName !== pr.base) {
              rows.push({ pr: pr.number, action: 'replacement-changed' }); continue;
            }
            action = `replacement-${replacement.state.toLowerCase()}`;
            if (replacement.state === 'OPEN' && replacement.mergeStateStatus === 'DIRTY') action = 'replacement-conflict';
            if (replacement.state === 'OPEN' && !replacement.isDraft && ['CLEAN', 'BLOCKED', 'BEHIND', 'UNSTABLE', 'HAS_HOOKS'].includes(replacement.mergeStateStatus)) {
              action = replacement.autoMergeRequest ? 'auto-merge-requested' : 'request-auto-merge';
              if (!replacement.autoMergeRequest && !await (deps.reserve ?? reserveMergeRecoveryAttempt)(resolveDropJobRoot(root), pr.number, 'merge', false)) {
                rows.push({ pr: pr.number, action: 'retry-limit' }); continue;
              }
              if (apply && !replacement.autoMergeRequest) {
                if (!await sourceUnchanged()) { rows.push({ pr: pr.number, action: 'source-changed' }); continue; }
                if (!await (deps.reserve ?? reserveMergeRecoveryAttempt)(resolveDropJobRoot(root), pr.number, 'merge', true)) {
                  rows.push({ pr: pr.number, action: 'retry-limit' }); continue;
                }
                const result = await gh(['pr', 'merge', String(replacement.number), '--repo', REPO, '--auto', '--match-head-commit', replacement.headRefOid]);
                if (!result.ok) throw new Error('merge request');
                action = 'auto-merge-requested';
              }
            }
          } else if (await (deps.exists ?? dropJobExists)(resolveDropJobRoot(root), job.id)) action = 'recut-queued';
          else {
            if (queued >= 2) { rows.push({ pr: pr.number, action: 'capped' }); continue; }
            if (!await sourceUnchanged()) { rows.push({ pr: pr.number, action: 'source-changed' }); continue; }
            if (apply && !deps.write && await countQueuedDropJobPrompts(resolveDropJobRoot(root)) >= DROP_JOB_QUEUE_LIMIT) throw new Error('queue full');
            if (!await (deps.reserve ?? reserveMergeRecoveryAttempt)(resolveDropJobRoot(root), pr.number, 'recut', apply)) {
              rows.push({ pr: pr.number, action: 'retry-limit' }); continue;
            }
            queued++;
            action = 'queue-recut';
            // The worker leaves edits uncommitted; the existing router publisher owns publication.
            job.body += `\nRecovery identity: ${title}. The sanctioned router publisher must use this exact PR title. Never bypass required checks or the merge queue.\n`;
            if (apply) {
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
  const detailed = rows.map(r => MERGE_RECOVER_REASONS[r.action] ? { ...r, reason: MERGE_RECOVER_REASONS[r.action] } : r);
  const report = { schema: 'fleet.merge-recover.v1', dryRun: !apply, ok: !failed, queue, rows: detailed };
  output(json ? JSON.stringify(report) : `${USAGE}\n${queue ? queue.entries.map(e => `#${e.number}: ${e.ageSeconds === null ? 'unknown wait' : `${e.ageSeconds}s queued`}`).join('\n') + '\n' : ''}${detailed.map(r => `#${r.pr}: ${r.action}${'reason' in r ? ` (${r.reason})` : ''}`).join('\n')}`);
  return failed ? 1 : 0;
}
