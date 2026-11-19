import { readFile, stat } from 'node:fs/promises';
import type { CloudGh } from '../core/cloud/pr-actions.js';
import { defaultCloudGh } from '../core/cloud/tracker.js';
import { collectLiveQueue, LIVE_QUEUE_REPOS, liveQueueSummary, parseLiveRepos } from '../core/fleet/queue-latency-live.js';
import { cmdFleetMergeRecover, type MergeRecoverDeps } from './fleet-merge-recover.js';
import { formatQueueLatency, queueLatency, validQueueLatencyInput } from '../core/fleet/queue-latency.js';

export { queueLatency, formatQueueLatency, validQueueLatencyInput };
export type { QueueLatencyInput, QueueLatencyPr, QueueLatencyReport, QueueLatencyAdvice, QueueStage } from '../core/fleet/queue-latency.js';

const MAX_BYTES = 8 * 1024 * 1024;
const usage = 'Usage: phm fleet queue-latency (--input <snapshot.json> | --live [--repos <list>] [--recover [--apply]]) [--json]\nShow where PRs lose time on the way to merge (approval, joining the queue, waiting in it, running checks) and which conflicts can be recut automatically. --live reads open PRs itself (default: the seven ashlrai repos; --repos takes names or owner/name, comma separated) and ends with one summary line. --recover previews recuts for conflicting ashlrai/phantom heads through merge-recover; add --apply to queue them (keyed, budget-bounded, auto-merge only with the head pinned). Snapshot: {prs:[{repo,number,stages:[{stage,at}],headSha?,mergeable?,queuePosition?,recutRequests?,lastRecutHead?}]}. Stages: opened, approved, queued, checks_started. Required checks always stay in place and nothing is merged or requeued directly.';

export interface QueueLatencyDeps { gh?: CloudGh; now?: number; output?: (text: string) => void;
  /** Test seams for the merge-recover planner. */
  recover?: Pick<MergeRecoverDeps, 'inspect' | 'exists' | 'write' | 'reserve'> }

export async function cmdFleetQueueLatency(args: string[], deps: QueueLatencyDeps = {}): Promise<number> {
  const output = deps.output ?? console.log;
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { output(usage); return 0; }
  let path: string | undefined, json = false, live = false, recover = false, apply = false, repoList: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json' && !json) json = true;
    else if (args[i] === '--live' && !live) live = true;
    else if (args[i] === '--recover' && !recover) recover = true;
    else if (args[i] === '--apply' && !apply) apply = true;
    else if (args[i] === '--repos' && !repoList && args[i + 1] && !args[i + 1]!.startsWith('-')) repoList = args[++i];
    else if (args[i] === '--input' && !path && args[i + 1] && !args[i + 1]!.startsWith('-')) path = args[++i];
    else { console.error(usage); return 2; }
  }
  if (live === !!path || (!live && (recover || apply || repoList)) || (apply && !recover)) { console.error(usage); return 2; }
  const repos = repoList ? parseLiveRepos(repoList) : undefined;
  if (repoList && !repos) { console.error('error: --repos takes names like phantom or owner/name, comma separated'); return 2; }
  if (!live) {
    try {
      if ((await stat(path!)).size > MAX_BYTES) throw new Error('Snapshot too large');
      const input: unknown = JSON.parse(await readFile(path!, 'utf8'));
      if (!validQueueLatencyInput(input)) throw new Error('Invalid snapshot');
      const report = queueLatency(input);
      output(json ? JSON.stringify(report) : formatQueueLatency(report));
      return 0;
    } catch { console.error('error: unable to read a valid queue snapshot; use --help for its shape'); return 1; }
  }

  const gh = deps.gh ?? defaultCloudGh;
  const probe = await gh(['--version']).catch(() => ({ ok: false, stdout: '', stderr: '' }));
  if (!probe.ok) { console.error('error: --live needs the GitHub CLI (gh) installed and signed in; run gh auth login, or use --input with a snapshot'); return 2; }
  const read = await collectLiveQueue(gh, repos ?? undefined);
  if (read.unread.length === (repos ?? LIVE_QUEUE_REPOS).length) { console.error('error: could not read open PRs from GitHub; check gh auth status'); return 1; }
  const report = queueLatency(read.snapshot, deps.now);

  // Only ashlrai/phantom can be recut; merge-recover owns the plan, the budget and the auto-merge submit.
  let recuts: { pr: number; action: string }[] | null = null, recoverOk = true;
  if (recover) {
    const only = new Set(read.conflicts.filter(c => c.repo === 'ashlrai/phantom').map(c => `${c.number}:${c.head}`));
    recuts = [];
    if (only.size) {
      let text = '';
      recoverOk = await cmdFleetMergeRecover(['--json', ...(apply ? ['--apply'] : [])], { ...deps.recover, gh, only, output: t => { text = t; } }) === 0;
      try { recuts = (JSON.parse(text) as { rows: { pr: number; action: string }[] }).rows; } catch { recoverOk = false; }
    }
  }
  const planned = recuts?.filter(r => r.action === 'queue-recut' || r.action === 'recut-queued').length ?? 0;
  const summary = liveQueueSummary(read.counts, planned);
  if (json) output(JSON.stringify({ ...report, live: { counts: read.counts, unread: read.unread, summary, recover: recuts && { dryRun: !apply, ok: recoverOk, rows: recuts } } }));
  else {
    output([formatQueueLatency(report),
      ...(recuts?.length ? recuts.map(r => `recover #${r.pr}: ${r.action}`) : []),
      ...(read.unread.length ? [`Could not read: ${read.unread.join(', ')}.`] : []), summary].join('\n'));
  }
  return recoverOk ? 0 : 1;
}
