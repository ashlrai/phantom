import { defaultGh, type Gh } from '../autopilot/github.js';

export const ARM_SWEEP_REPOS = ['phantom', 'phantom-secrets', 'ashlr-plugin', 'ashlr-stack', 'locus', 'lexicon', 'ashlr-md'].map(name => `ashlrai/${name}`);
const HOLDS: Record<string, number[]> = { 'ashlrai/phantom': [197, 878, 743, 725, 738, 744, 693, 1228], 'ashlrai/phantom-secrets': [140, 197, 375, 168, 418, 136], 'ashlrai/ashlr-plugin': [152, 157] };
interface Pull {
  number: number; title: string; body: string; updatedAt: string; isDraft: boolean; mergeable: string;
  autoMergeRequest: object | null;
  statusCheckRollup: Array<{ conclusion?: string; state?: string; status?: string }> | null;
}
export interface ArmSweepRow { repo: string; number: number; title: string; action: 'armed' | 'would arm' | 'skipped'; reason?: string }
export interface ArmSweepOptions { repos?: string[]; sinceMs?: number; apply?: boolean; now?: number; gh?: Gh }
export async function armSweep({ repos = ARM_SWEEP_REPOS, sinceMs = 86_400_000, apply = false, now = Date.now(), gh = defaultGh }: ArmSweepOptions = {}) {
  repos = [...new Set(repos.map(repo => (repo.includes('/') ? repo : `ashlrai/${repo}`).toLowerCase()))];
  if (!repos.length || repos.some(repo => !/^ashlrai\/[a-z0-9][a-z0-9._-]*$/.test(repo)) || !Number.isFinite(sinceMs) || sinceMs <= 0 || !Number.isFinite(now)) throw new Error('Invalid sweep options');
  const rows: ArmSweepRow[] = [], errors: Array<{ repo: string; reason: string }> = [];
  const closeCandidates: Array<{ repo: string; number: number; title: string; supersededBy: number }> = [];
  for (const repo of repos) {
    let pulls: Pull[];
    try {
      const value: unknown = JSON.parse(await gh(['pr', 'list', '--state', 'open', '--limit', '10000', '-R', repo, '--json', 'number,title,body,updatedAt,isDraft,mergeable,autoMergeRequest,statusCheckRollup']));
      if (!Array.isArray(value) || value.length >= 10000 || value.some(p => !p || !Number.isSafeInteger(p.number) || p.number < 1
        || typeof p.title !== 'string' || typeof p.body !== 'string' || typeof p.isDraft !== 'boolean' || typeof p.mergeable !== 'string'
        || typeof p.updatedAt !== 'string' || !Number.isFinite(Date.parse(p.updatedAt)) || !Object.hasOwn(p, 'autoMergeRequest')
        || (p.autoMergeRequest !== null && typeof p.autoMergeRequest !== 'object')
        || (p.statusCheckRollup !== null && (!Array.isArray(p.statusCheckRollup) || p.statusCheckRollup.some((c: unknown) => !c || typeof c !== 'object'))))) throw new Error('Incomplete list');
      pulls = value;
    } catch { errors.push({ repo, reason: 'Could not read a complete open PR list' }); continue; }
    const byNumber = new Map(pulls.map(p => [p.number, p]));
    for (const p of pulls) {
      for (const number of new Set([...p.body.matchAll(/\bSupersedes\s+#(\d+)\b/gi)].map(m => Number(m[1])))) {
        const original = byNumber.get(number);
        if (original && number !== p.number) closeCandidates.push({ repo, number, title: original.title, supersededBy: p.number });
      }
      const reason = (HOLDS[repo] ?? []).includes(p.number) ? 'Owner hold'
        : Date.parse(p.updatedAt) < now - sinceMs ? 'Updated before the time window'
        : p.isDraft ? 'Draft'
        : p.autoMergeRequest !== null ? 'Already armed'
        : p.mergeable === 'CONFLICTING' ? 'Conflicting'
        : p.mergeable !== 'MERGEABLE' ? 'Mergeability unknown'
        : p.statusCheckRollup === null ? 'Checks unknown'
        : p.statusCheckRollup.some(c => [c.conclusion, c.state].some(s => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'].includes(s ?? ''))) ? 'Failing checks'
        : p.statusCheckRollup.some(c => ![c.conclusion, c.state, c.status].some(s => ['SUCCESS', 'NEUTRAL', 'SKIPPED', 'PENDING', 'IN_PROGRESS', 'QUEUED', 'WAITING', 'REQUESTED', 'EXPECTED'].includes(s ?? ''))) ? 'Checks unknown' : undefined;
      const row: ArmSweepRow = { repo, number: p.number, title: p.title, action: reason ? 'skipped' : 'would arm', ...(reason ? { reason } : {}) };
      if (!reason && apply) {
        try { await gh(['pr', 'merge', String(p.number), '--auto', '-R', repo]); row.action = 'armed'; }
        catch { row.action = 'skipped'; row.reason = 'Auto-merge request failed'; }
      }
      rows.push(row);
    }
  }
  const skipped: Record<string, number> = {};
  for (const row of rows) if (row.reason) skipped[row.reason] = (skipped[row.reason] ?? 0) + 1;
  return { schema: 'prs.arm-sweep.v1', dryRun: !apply, rows, closeCandidates, errors,
    counts: { armed: rows.filter(r => r.action === 'armed').length, wouldArm: rows.filter(r => r.action === 'would arm').length, skipped } };
}
