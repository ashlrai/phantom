import { tmpdir } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withScratchRepo } from '../core/fleet/dirty-landed-inspect.js';
import { defaultGitRunner } from '../core/verse/git-ops.js';

const usage = 'Usage: phm prs arm-sweep [--repos <list>] [--since 24h] [--apply] [--json]\n       phm prs triage [--repo ashlrai/<name>] [--limit N] --json';
const sha = /^[0-9a-f]{40}$/;
type Verdict = 'superseded' | 'rebase-clean' | 'rebase-manual' | 'failing-checks' | 'green' | 'unknown';
const run = (dir: string, binary: 'git' | 'gh', args: string[]) => defaultGitRunner(binary, args, { cwd: dir, timeoutMs: 60_000, maxStdoutBytes: 16 * 1024 * 1024 });
const ok = (r: Awaited<ReturnType<typeof run>>) => r.code === 0 && !r.timedOut && !r.truncated;

type KnownVerdict = Exclude<Verdict, 'unknown'>;
type TriageHead = { number: number; headRefOid: string; baseRefName: string; mergeable: string };
type TriageInspection =
  | { verdict: 'unknown'; evidence: null }
  | { verdict: KnownVerdict; evidence: { headSha: string; baseTipSha: string; mergeBaseSha: string; proof: 'reverse-patch' | null } };

export async function inspectTriageEvidence(dir: string, remote: string, row: TriageHead, checks: string): Promise<TriageInspection> {
  if (!validHead(row) || !ok(await run(dir, 'git', ['check-ref-format', `refs/heads/${row.baseRefName}`]))) return unknown();
  const fetch = await fetchTriageRefs(run, dir, remote, [
    `+refs/heads/${row.baseRefName}:refs/triage/base`, `+refs/pull/${row.number}/head:refs/triage/head`,
  ]);
  if (!ok(fetch)) return unknown();
  return inspectFetched(dir, row, checks, 'refs/triage/head', await commitAt(run, dir, 'refs/triage/base'), run);
}

const unknown = (): TriageInspection => ({ verdict: 'unknown', evidence: null });
const validHead = (row: TriageHead): boolean =>
  Number.isSafeInteger(row.number) && row.number > 0 && sha.test(row.headRefOid);
const TRIAGE_HEADS_PER_FETCH = 25;

function fetchTriageRefs(exec: typeof run, dir: string, remote: string, specs: readonly string[]) {
  return exec(dir, 'git', ['-c', 'core.hooksPath=/dev/null', 'fetch', '--atomic', '--no-tags', '--no-write-fetch-head', '--', remote, ...specs]);
}

async function commitAt(exec: typeof run, dir: string, ref: string): Promise<string | null> {
  const result = await exec(dir, 'git', ['rev-parse', '--verify', `${ref}^{commit}`]);
  const oid = result.stdout.trim();
  return ok(result) && sha.test(oid) ? oid : null;
}

/** One base snapshot per branch per report. Keep the shared scratch index serial. */
export async function inspectTriageBatch(dir: string, remote: string,
  input: readonly { row: TriageHead; checks: string }[], exec = run): Promise<TriageInspection[]> {
  const tips = new Map<string, string | null>();
  const result: TriageInspection[] = [];
  for (let cursor = 0; cursor < input.length; cursor += TRIAGE_HEADS_PER_FETCH) {
    const batch = input.slice(cursor, cursor + TRIAGE_HEADS_PER_FETCH);
    const entries = [];
    for (const [index, { row, checks }] of batch.entries()) {
      const ref = `refs/triage/heads/${cursor + index}`;
      if (validHead(row) && !tips.has(row.baseRefName)) {
        const source = `refs/heads/${row.baseRefName}`;
        const dest = `refs/triage/bases/${tips.size}`;
        const checked = await exec(dir, 'git', ['check-ref-format', source]);
        const fetched = ok(checked) && ok(await fetchTriageRefs(exec, dir, remote, [`+${source}:${dest}`]));
        tips.set(row.baseRefName, fetched ? await commitAt(exec, dir, dest) : null);
      }
      entries.push({ row, checks, ref, base: validHead(row) ? tips.get(row.baseRefName) : null,
        spec: `+refs/pull/${row.number}/head:${ref}` });
    }
    const ready = entries.filter(entry => entry.base);
    if (!ready.length) { result.push(...entries.map(unknown)); continue; }
    const fetched = await fetchTriageRefs(exec, dir, remote, ready.map(entry => entry.spec));
    const bulkOk = ok(fetched);
    // A vanished ref can reject a whole atomic fetch. Recover the rest without
    // changing the base; do not amplify auth, network or unexplained failures.
    const missing = !fetched.timedOut && !fetched.truncated && fetched.code === 128
      ? /^fatal: couldn't find remote ref (refs\/pull\/[1-9][0-9]*\/head)\s*$/m.exec(fetched.stderr)?.[1] : undefined;
    const recover = missing !== undefined && ready.length > 1 && ready.some(entry => entry.spec.startsWith(`+${missing}:`));
    for (const entry of entries) {
      const available = entry.base && (bulkOk || (recover && !entry.spec.startsWith(`+${missing}:`) &&
        ok(await fetchTriageRefs(exec, dir, remote, [entry.spec]))));
      result.push(available
        ? await inspectFetched(dir, entry.row, entry.checks, entry.ref, entry.base ?? null, exec)
        : unknown());
    }
  }
  return result;
}

async function inspectFetched(dir: string, row: TriageHead, checks: string, ref: string, baseTipSha: string | null,
  exec: typeof run): Promise<TriageInspection> {
  if (!baseTipSha) return unknown();
  const headSha = await commitAt(exec, dir, ref);
  if (!headSha || headSha !== row.headRefOid) return unknown();
  // Freeze both fetched object IDs: the patch, index, and trial merge must all
  // refer to the same commits this row reports, not to mutable scratch refs.
  const base = await exec(dir, 'git', ['merge-base', '--all', baseTipSha, headSha]);
  const mergeBaseSha = base.stdout.trim();
  if (!ok(base) || !sha.test(mergeBaseSha)) return unknown();
  const known = (verdict: KnownVerdict): TriageInspection => ({
    verdict,
    evidence: { headSha, baseTipSha, mergeBaseSha, proof: verdict === 'superseded' ? 'reverse-patch' : null },
  });
  const diff = await exec(dir, 'git', ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', mergeBaseSha, headSha]);
  if (!ok(diff)) return unknown();
  if (diff.stdout) {
    try { await writeFile(join(dir, 'triage.patch'), diff.stdout); } catch { return unknown(); }
    if (!ok(await exec(dir, 'git', ['read-tree', baseTipSha]))) return unknown();
    const reverse = await exec(dir, 'git', ['apply', '--cached', '--check', '--reverse', 'triage.patch']);
    if (reverse.timedOut || reverse.truncated || (reverse.code !== 0 && reverse.code !== 1)) return unknown();
    if (ok(reverse)) return known('superseded');
  }
  if (row.mergeable === 'CONFLICTING') {
    const merge = await exec(dir, 'git', ['merge-tree', '--write-tree', baseTipSha, headSha]);
    if (merge.timedOut || merge.truncated || (merge.code !== 0 && merge.code !== 1)) return unknown();
    return known(merge.code === 0 ? 'rebase-clean' : 'rebase-manual');
  }
  if (row.mergeable !== 'MERGEABLE') return unknown();
  return checks === 'failure' ? known('failing-checks') : checks === 'success' ? known('green') : unknown();
}

/** Preserve the verdict-only interface for existing callers. */
export async function inspectTriage(dir: string, remote: string, row: TriageHead, checks: string): Promise<Verdict> {
  return (await inspectTriageEvidence(dir, remote, row, checks)).verdict;
}

export async function cmdPrs(args: string[]): Promise<number> {
  if (args[0] === 'arm-sweep') return (await import('./prs-arm-sweep.js')).cmdPrsArmSweep(args.slice(1));
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
      const input = rows.map(row => {
        if (!Number.isSafeInteger(row.number) || row.number < 1 || typeof row.headRefName !== 'string' || typeof row.baseRefName !== 'string' || typeof row.headRefOid !== 'string' || typeof row.mergeable !== 'string' || !Number.isFinite(Date.parse(row.createdAt))) throw new Error('invalid');
        const checks = !Array.isArray(row.statusCheckRollup) || row.statusCheckRollup.length === 0 ? 'unknown' : row.statusCheckRollup.some(c => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'].includes(c.conclusion ?? c.state ?? '')) ? 'failure' : row.statusCheckRollup.every(c => ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(c.conclusion ?? c.state ?? '') && (!c.status || c.status === 'COMPLETED')) ? 'success' : 'pending';
        return { row, checks };
      });
      const inspections = await inspectTriageBatch(dir, `https://github.com/${repo}.git`, input);
      return input.map(({ row, checks }, index) => ({
        number: row.number, headBranch: row.headRefName, mergeable: row.mergeable, checks,
        ageSeconds: Math.max(0, Math.floor((now - Date.parse(row.createdAt)) / 1000)), ...inspections[index]!,
      }));
    });
    const counts: Record<string, number> = { superseded: 0, 'rebase-clean': 0, 'rebase-manual': 0, 'failing-checks': 0, green: 0, unknown: 0 };
    for (const pr of prs) counts[pr.verdict]!++;
    console.log(JSON.stringify({ schema: 'prs.triage.v1', repo, generatedAt: new Date(now).toISOString(), complete: rows.length < limit, counts, prs }));
    return 0;
  } catch { console.error('prs triage: invalid response or inspection failed'); return 1; }
}
