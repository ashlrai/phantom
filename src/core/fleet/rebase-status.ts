/** Read-only snapshot of conflicting bridge PRs and queuegen rebase coverage. */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultGitRunner } from '../verse/git-ops.js';
import { parseReadyTsv } from './lane-console.js';
import { readSource } from './runs-parked-queue.js';

const LIMIT = 1000;
type Pr = { number: number; title: string; mergeable: string; mergeStateStatus: string; createdAt: string; headRefOid: string };
type QueueRow = { id: string | null; status: string };

export function summarizeRebases(repo: string, prs: Pr[], jobs: QueueRow[], now: number) {
  const short = repo.split('/')[1]!.toUpperCase();
  const conflicts = prs.filter(p => p.title.startsWith('bridge:') && (p.mergeable === 'CONFLICTING' || p.mergeStateStatus === 'DIRTY'));
  let covered = 0, stale = 0, unknownHead = 0, unknownAge = 0;
  const ages: number[] = [];
  for (const pr of conflicts) {
    const age = Date.parse(pr.createdAt);
    if (!Number.isFinite(age) || age > now) unknownAge++;
    else ages.push(Math.floor((now - age) / 1000));
    const prefix = `RQ-REBASE-${short}-${pr.number}-`;
    const matching = jobs.filter(j => j.id?.toUpperCase().startsWith(prefix) && (j.status === 'READY' || j.status.startsWith('PARKED-') || j.status === 'RUNNING'));
    if (!/^[a-f0-9]{7,40}$/i.test(pr.headRefOid)) unknownHead++;
    else if (matching.some(j => j.id?.toUpperCase() === `${prefix}${pr.headRefOid.slice(0, 7).toUpperCase()}`)) covered++;
    else if (matching.length) stale++;
  }
  ages.sort((a, b) => a - b);
  return { conflicting: conflicts.length, ageSeconds: { oldest: ages.at(-1) ?? null, median: ages.length ? ages[Math.floor((ages.length - 1) / 2)] : null, unknown: unknownAge }, coverage: { currentHead: covered, staleHeadOnly: stale, unknownHead, uncovered: conflicts.length - covered - stale - unknownHead } };
}

export async function readRebaseStatus(repos: string[], runsDir: string, now = new Date()) {
  const queue = await readSource(join(runsDir, 'queue/ready.tsv'), 2 * 1024 * 1024, false);
  const parsed = parseReadyTsv(queue.text);
  const queueSource = queue.state === 'healthy' && (parsed.dropped || parsed.rows.length >= 50_000) ? 'degraded' : queue.state;
  const results = [];
  for (const repo of repos) {
    const result = await defaultGitRunner('gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(LIMIT), '--json', 'number,title,mergeable,mergeStateStatus,createdAt,headRefOid'], { cwd: tmpdir(), timeoutMs: 20000, maxStdoutBytes: 2 * 1024 * 1024 });
    let rows: unknown;
    try { rows = JSON.parse(result.stdout); } catch { rows = null; }
    if (result.code !== 0 || result.timedOut || result.truncated || !Array.isArray(rows) || rows.some(p => !p || !Number.isSafeInteger(p.number) || p.number < 1 || typeof p.title !== 'string' || typeof p.mergeable !== 'string' || typeof p.mergeStateStatus !== 'string' || typeof p.createdAt !== 'string' || typeof p.headRefOid !== 'string')) {
      results.push({ repo, source: 'unavailable', summary: null });
      continue;
    }
    const summary = summarizeRebases(repo, rows as Pr[], parsed.rows, now.getTime());
    results.push({ repo, source: rows.length >= LIMIT ? 'truncated' : 'ok', summary: { ...summary, coverage: queueSource === 'healthy' ? summary.coverage : null } });
  }
  return { v: 1, generatedAt: now.toISOString(), queueSource, repos: results };
}
