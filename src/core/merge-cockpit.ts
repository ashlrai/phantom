import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { assertRepo, defaultGh, type Gh } from './autopilot/github.js';

export interface CockpitPr { number: number; title: string; body: string; mergeable: string; checks: string | null; autoMerge: boolean }
export interface CockpitRepo { repo: string; observedAt: string; prs: CockpitPr[] }
export interface CockpitCache { version: 1; snapshots: CockpitRepo[] }
const QUERY = `query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){pullRequests(first:100,after:$cursor,states:OPEN,orderBy:{field:CREATED_AT,direction:ASC}){pageInfo{hasNextPage endCursor} nodes{number title body mergeable autoMergeRequest{enabledAt} commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}} rateLimit{remaining resetAt}}`;

/** One query per page, bounded; no individual PR/check requests. */
export async function fetchRepo(repo: string, gh: Gh = defaultGh, now = new Date()): Promise<CockpitRepo> {
  const [owner, name] = assertRepo(repo).split('/') as [string, string];
  const prs: CockpitPr[] = [];
  let cursor = '';
  for (let page = 0; page < 20; page++) {
    const args = ['api', 'graphql', '-f', `query=${QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`];
    if (cursor) args.push('-f', `cursor=${cursor}`);
    const result = JSON.parse(await gh(args));
    const connection = result?.data?.repository?.pullRequests;
    if (result.errors?.length || !Array.isArray(connection?.nodes) || !connection.pageInfo || typeof connection.pageInfo.hasNextPage !== 'boolean') throw new Error('GitHub returned an incomplete response');
    for (const p of connection.nodes) {
      if (!Number.isSafeInteger(p.number) || p.number < 1 || typeof p.title !== 'string' || typeof p.body !== 'string') throw new Error('GitHub returned an invalid PR');
      prs.push({ number: p.number, title: p.title, body: p.body, mergeable: p.mergeable, checks: p.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null, autoMerge: p.autoMergeRequest != null });
    }
    if (!connection.pageInfo.hasNextPage) return { repo, observedAt: now.toISOString(), prs };
    if (result.data.rateLimit?.remaining === 0) throw new Error('GitHub rate limit exhausted');
    const next = connection.pageInfo.endCursor;
    if (typeof next !== 'string' || !next || next === cursor) throw new Error('GitHub returned an invalid cursor');
    cursor = next;
  }
  throw new Error('GitHub page limit reached; snapshot incomplete');
}

// Owner holds are observation only: this command has no merge or close path.
const HOLDS: Record<string, number[]> = { 'ashlrai/phantom': [197, 878, 743, 725, 738, 744, 693, 1228], 'ashlrai/phantom-secrets': [140, 197, 375, 168, 418, 136], 'ashlrai/ashlr-plugin': [152, 157] };
export function summarize(snapshot: CockpitRepo) {
  const edges = snapshot.prs.flatMap(p => [...`${p.title}\n${p.body}`.matchAll(/\breworks\s+#(\d+)\b/gi)].map(m => ({ rework: p.number, original: Number(m[1]) })))
    .filter((e, i, all) => e.original !== e.rework && all.findIndex(x => x.rework === e.rework && x.original === e.original) === i);
  return { open: snapshot.prs.length, conflicting: snapshot.prs.filter(p => p.mergeable === 'CONFLICTING').length,
    green: snapshot.prs.filter(p => p.checks === 'SUCCESS').length, autoMerge: snapshot.prs.filter(p => p.autoMerge).length,
    unknownMergeable: snapshot.prs.filter(p => p.mergeable !== 'MERGEABLE' && p.mergeable !== 'CONFLICTING').length,
    unknownChecks: snapshot.prs.filter(p => p.checks === null).length, held: snapshot.prs.filter(p => (HOLDS[snapshot.repo.toLowerCase()] ?? []).includes(p.number)).map(p => p.number), edges: edges.map(e => ({ ...e, originalHeld: (HOLDS[snapshot.repo.toLowerCase()] ?? []).includes(e.original) })) };
}

export async function readCache(path: string): Promise<CockpitCache> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (value && typeof value === 'object' && (value as CockpitCache).version === 1 && Array.isArray((value as CockpitCache).snapshots)) {
      const snapshots = (value as CockpitCache).snapshots.filter(s => s && typeof s.repo === 'string' && typeof s.observedAt === 'string' && Array.isArray(s.prs) && s.prs.every(p => p && Number.isSafeInteger(p.number) && typeof p.title === 'string' && typeof p.body === 'string'));
      return { version: 1, snapshots };
    }
  } catch { /* unavailable cache */ }
  return { version: 1, snapshots: [] };
}
export async function writeCache(path: string, cache: CockpitCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify(cache), { mode: 0o600 });
}
