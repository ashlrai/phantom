import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFleetShippedMerges, type GhRunner } from './fleet-truth.js';
import { readLedgerLines, type YieldLineReader } from './ledger-lines.js';
import { scrubSecrets } from '../util/scrub.js';

export const SHIPPED_REPOS = ['phantom', 'phantom-secrets', 'ashlr-plugin', 'ashlr-stack', 'locus', 'lexicon', 'ashlr-md'].map(name => `ashlrai/${name}`);
export interface ShippedPr {
  repo: string; number: number; title: string; url: string; mergedAt: string;
  jobId: string | null; lane: string | null; openToMergeSeconds: number | null;
}
export interface FleetShippedReport {
  schema: 'fleet.shipped.v1'; since: string; generatedAt: string; complete: boolean;
  items: ShippedPr[]; byRepo: Record<string, number>;
  totals: { merged: number | null; mergedPerHour: number | null; medianOpenToMergeSeconds: number | null };
}
export async function readFleetShipped(deps: { now?: number; gh?: GhRunner; read?: YieldLineReader } = {}): Promise<FleetShippedReport> {
  const now = deps.now ?? Date.now(), since = now - 86_400_000;
  const lanes = new Map<string, Set<string>>();
  const [merges, known] = await Promise.all([
    readFleetShippedMerges(since, now, SHIPPED_REPOS, deps.gh),
    (deps.read ?? readLedgerLines)(join(process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs'), 'metrics/jobs.jsonl'), line => {
      try {
        const row = JSON.parse(line), job = row.job ?? row.jobId ?? row.job_id ?? row.id, lane = row.lane ?? row.pool ?? row.arm;
        const repo = typeof row.repo === 'string' && row.repo.startsWith('ashlrai/') ? row.repo : `ashlrai/${row.repo}`;
        if (typeof job !== 'string' || typeof lane !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(lane)) return;
        const key = `${repo}#${job}`, values = lanes.get(key) ?? new Set<string>();
        values.add(lane); lanes.set(key, values);
      } catch { /* Malformed metrics cannot establish a lane. */ }
    }).catch(() => false),
  ]);
  const items: ShippedPr[] = (merges?.rows ?? []).filter(pr => SHIPPED_REPOS.includes(pr.repo)).map(pr => {
    const values = known && pr.jobId ? lanes.get(`${pr.repo}#${pr.jobId}`) : null;
    return { repo: pr.repo, number: pr.number, title: scrubSecrets(pr.title).slice(0, 300), url: pr.url,
      mergedAt: new Date(pr.mergedAtMs).toISOString(), jobId: pr.jobId ?? null,
      lane: values?.size === 1 ? [...values][0]! : null,
      openToMergeSeconds: pr.openedAtMs === undefined ? null : (pr.mergedAtMs - pr.openedAtMs) / 1000 };
  }).sort((a, b) => b.mergedAt.localeCompare(a.mergedAt) || a.repo.localeCompare(b.repo) || b.number - a.number);
  const complete = merges?.complete === true;
  const times = items.flatMap(pr => pr.openToMergeSeconds === null ? [] : [pr.openToMergeSeconds]).sort((a, b) => a - b);
  const middle = Math.floor(times.length / 2);
  return { schema: 'fleet.shipped.v1', since: new Date(since).toISOString(), generatedAt: new Date(now).toISOString(), complete, items,
    byRepo: Object.fromEntries(SHIPPED_REPOS.map(repo => [repo, items.filter(pr => pr.repo === repo).length])),
    totals: { merged: complete ? items.length : null, mergedPerHour: complete ? items.length / 24 : null,
      medianOpenToMergeSeconds: complete && times.length ? (times[middle]! + times[Math.floor((times.length - 1) / 2)]!) / 2 : null } };
}
