import { tmpdir } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withScratchRepo } from '../core/fleet/dirty-landed-inspect.js';
import { defaultGitRunner } from '../core/verse/git-ops.js';

const usage = 'Usage: phm prs triage [--repo ashlrai/<name>] [--limit N] --json';
const sha = /^[0-9a-f]{40}$/;
type Verdict = 'superseded' | 'rebase-clean' | 'rebase-manual' | 'failing-checks' | 'green' | 'unknown';
const run = (dir: string, binary: 'git' | 'gh', args: string[]) => defaultGitRunner(binary, args, { cwd: dir, timeoutMs: 60_000, maxStdoutBytes: 16 * 1024 * 1024 });
const ok = (r: Awaited<ReturnType<typeof run>>) => r.code === 0 && !r.timedOut && !r.truncated;

export async function inspectTriage(dir: string, remote: string, row: { number: number; headRefOid: string; baseRefName: string; mergeable: string }, checks: string): Promise<Verdict> {
  if (!sha.test(row.headRefOid) || !ok(await run(dir, 'git', ['check-ref-format', `refs/heads/${row.baseRefName}`]))) return 'unknown';
  const fetch = await run(dir, 'git', ['-c', 'core.hooksPath=/dev/null', 'fetch', '--no-tags', '--no-write-fetch-head', remote, `+refs/heads/${row.baseRefName}:refs/triage/base`, `+refs/pull/${row.number}/head:refs/triage/head`]);
  if (!ok(fetch)) return 'unknown';
  const head = await run(dir, 'git', ['rev-parse', 'refs/triage/head']);
  if (!ok(head) || head.stdout.trim() !== row.headRefOid) return 'unknown';
  const base = await run(dir, 'git', ['merge-base', '--all', 'refs/triage/base', 'refs/triage/head']);
  if (!ok(base) || !sha.test(base.stdout.trim())) return 'unknown';
  const diff = await run(dir, 'git', ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', base.stdout.trim(), 'refs/triage/head']);
  if (!ok(diff)) return 'unknown';
  if (diff.stdout) {
    await writeFile(join(dir, 'triage.patch'), diff.stdout);
    if (!ok(await run(dir, 'git', ['read-tree', 'refs/triage/base']))) return 'unknown';
    if (ok(await run(dir, 'git', ['apply', '--cached', '--check', '--reverse', 'triage.patch']))) return 'superseded';
  }
  if (row.mergeable === 'CONFLICTING') {
    const merge = await run(dir, 'git', ['merge-tree', '--write-tree', 'refs/triage/base', 'refs/triage/head']);
    if (merge.timedOut || merge.truncated || (merge.code !== 0 && merge.code !== 1)) return 'unknown';
    return merge.code === 0 ? 'rebase-clean' : 'rebase-manual';
  }
  if (row.mergeable !== 'MERGEABLE') return 'unknown';
  return checks === 'failure' ? 'failing-checks' : checks === 'success' ? 'green' : 'unknown';
}

export async function cmdPrs(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  if (args.shift() !== 'triage') { console.error(usage); return 2; }
  let repo = 'ashlrai/phantom', limit = 100, json = false;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--json' && !json) json = true;
    else if (arg === '--repo') repo = args.shift() ?? '';
    else if (arg === '--limit') { const value = args.shift() ?? ''; limit = /^\d+$/.test(value) ? Number(value) : 0; }
    else { console.error(usage); return 2; }
  }
  if (!/^ashlrai\/[A-Za-z0-9_.-]+$/.test(repo) || repo.endsWith('/.') || repo.endsWith('/..') || !Number.isSafeInteger(limit) || limit < 1 || limit > 10000 || !json) { console.error(usage); return 2; }
  const list = await run(tmpdir(), 'gh', ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(limit), '--json', 'number,headRefName,headRefOid,baseRefName,mergeable,statusCheckRollup,createdAt']);
  if (!ok(list)) { console.error('prs triage: GitHub read failed'); return 1; }
  try {
    const rows: Array<{ number: number; headRefName: string; headRefOid: string; baseRefName: string; mergeable: string; createdAt: string; statusCheckRollup: Array<{ status?: string; conclusion?: string; state?: string }> | null }> = JSON.parse(list.stdout);
    if (!Array.isArray(rows)) throw new Error('invalid');
    const now = Date.now();
    const prs = await withScratchRepo(async dir => {
      const out = [];
      for (const row of rows) {
        if (!Number.isSafeInteger(row.number) || row.number < 1 || typeof row.headRefName !== 'string' || typeof row.baseRefName !== 'string' || typeof row.headRefOid !== 'string' || typeof row.mergeable !== 'string' || !Number.isFinite(Date.parse(row.createdAt))) throw new Error('invalid');
        const checks = !Array.isArray(row.statusCheckRollup) || row.statusCheckRollup.length === 0 ? 'unknown' : row.statusCheckRollup.some(c => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'].includes(c.conclusion ?? c.state ?? '')) ? 'failure' : row.statusCheckRollup.every(c => ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion ?? c.state ?? '') && (!c.status || c.status === 'COMPLETED')) ? 'success' : 'pending';
        const verdict = await inspectTriage(dir, `https://github.com/${repo}.git`, row, checks);
        out.push({ number: row.number, headBranch: row.headRefName, mergeable: row.mergeable, checks, ageSeconds: Math.max(0, Math.floor((now - Date.parse(row.createdAt)) / 1000)), verdict });
      }
      return out;
    });
    const counts: Record<string, number> = { superseded: 0, 'rebase-clean': 0, 'rebase-manual': 0, 'failing-checks': 0, green: 0, unknown: 0 };
    for (const pr of prs) counts[pr.verdict]!++;
    console.log(JSON.stringify({ schema: 'prs.triage.v1', repo, generatedAt: new Date(now).toISOString(), complete: rows.length < limit, counts, prs }));
    return 0;
  } catch { console.error('prs triage: invalid response or inspection failed'); return 1; }
}
