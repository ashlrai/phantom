import { defaultGh, type Gh } from '../core/autopilot/github.js';
import { summarizeCiRuns, type CiRunLite } from '../core/fleet/ci-run-facts.js';
import { FLEET_REPOS } from '../core/portfolio/restock-lint.js';

type Row = { repo: string; run: CiRunLite | null; failedTests: Array<{ file: string; status: 'fixed-after-run' | 'still-open'; commits: string[] }> | null };
const usage = 'usage: ashlr fleet daily-reds [--json]';

/** A later touching merge is evidence of a possible fix, not a passing rerun. */
export async function readDailyReds(gh: Gh = defaultGh): Promise<Row[]> {
  return Promise.all(FLEET_REPOS.map(async name => {
    const repo = `ashlrai/${name}`;
    const row: Row = { repo, run: null, failedTests: null };
    const api = async (path: string) => JSON.parse(await gh(['api', `repos/${repo}/${path}`]));
    // Refuse incomplete pagination rather than interpreting a bounded prefix as clean.
    const pages = async (path: string): Promise<Record<string, unknown>[]> => {
      const all: Record<string, unknown>[] = [];
      for (let page = 1; page <= 30; page++) {
        const batch = await api(`${path}&per_page=100&page=${page}`);
        if (!Array.isArray(batch)) throw new Error('Invalid listing');
        all.push(...batch);
        if (batch.length < 100 || (path.startsWith('pulls?') && row.run &&
          typeof batch.at(-1)?.updated_at === 'string' && Date.parse(batch.at(-1).updated_at) < Date.parse(row.run.createdAt))) return all;
      }
      throw new Error('Incomplete listing');
    };
    try {
      let latest;
      for (let page = 1; page <= 30; page++) {
        const listing = await api(`actions/runs?event=schedule&per_page=100&page=${page}`);
        if (!Array.isArray(listing.workflow_runs)) throw new Error('Invalid runs');
        latest = listing.workflow_runs.find((r: { name: string }) => r.name === 'CI');
        if (latest || listing.workflow_runs.length < 100) break;
        if (page === 30) throw new Error('Incomplete runs');
      }
      if (!latest) return row;
      if (!Number.isSafeInteger(latest.id) || !Number.isFinite(Date.parse(latest.created_at)) || typeof latest.head_branch !== 'string') throw new Error('Invalid run');
      const run: CiRunLite = { id: latest.id, name: 'CI', event: 'schedule', headBranch: latest.head_branch,
        prNumber: null, status: latest.status, conclusion: latest.conclusion ?? null, createdAt: latest.created_at,
        htmlUrl: `https://github.com/${repo}/actions/runs/${latest.id}` };
      // The summarizer accepts any branch for recent facts, without its master-only daily selector.
      const facts = summarizeCiRuns([run], new Map(), { repo, nowMs: Date.parse(run.createdAt), windowHours: 1 });
      if (facts.recent.length !== 1) throw new Error('Invalid run facts');
      row.run = run;
      if (run.status !== 'completed') return row;
      if (run.conclusion === 'success') { row.failedTests = []; return row; }
      if (run.conclusion !== 'failure') return row;
      const log = await gh(['run', 'view', String(run.id), '--repo', repo, '--log-failed']);
      // Vitest/Jest failure headers only; incidental paths in stack traces are not failed suites.
      const files = [...new Set([...log.matchAll(/\bFAIL\s+(?:[^\s/]+\s+)?((?:[\w.@-]+\/)*[\w.@-]+\.(?:test|spec)\.[cm]?[jt]sx?)(?=\s|$)/g)].map(m => m[1]!))].sort();
      if (!files.length) return row;
      const pulls = await pages('pulls?state=closed&sort=updated&direction=desc');
      const commits = new Map(files.map(file => [file, [] as string[]]));
      for (const pr of pulls) {
        if (pr.merged_at === null) continue;
        if (typeof pr.merged_at !== 'string' || !Number.isFinite(Date.parse(pr.merged_at))) throw new Error('Invalid merge');
        if (Date.parse(pr.merged_at) <= Date.parse(run.createdAt)) continue;
        const base = pr.base as { ref?: string } | undefined;
        if (!base || typeof base.ref !== 'string') throw new Error('Invalid base');
        if (base.ref !== run.headBranch) continue;
        if (!Number.isSafeInteger(pr.number) || typeof pr.merge_commit_sha !== 'string' || !/^[a-f0-9]{40}$/.test(pr.merge_commit_sha)) throw new Error('Invalid commit');
        for (const changed of await pages(`pulls/${pr.number}/files?`)) {
          if (typeof changed.filename !== 'string') throw new Error('Invalid file');
          for (const file of files) if (changed.filename === file || changed.previous_filename === file) commits.get(file)!.push(pr.merge_commit_sha);
        }
      }
      row.failedTests = files.map(file => ({ file, status: commits.get(file)!.length ? 'fixed-after-run' : 'still-open', commits: [...new Set(commits.get(file)!)] }));
    } catch { /* Failed reads stay null; raw errors/logs never reach output. */ }
    return row;
  }));
}

export async function cmdFleetDailyReds(args: string[], deps: { gh?: Gh } = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  if (args.length && (args.length !== 1 || args[0] !== '--json')) { process.stderr.write(`${usage}\n`); return 2; }
  const repos = await readDailyReds(deps.gh);
  if (args.includes('--json')) console.log(JSON.stringify({ v: 1, repos }));
  else {
    console.log('fixed-after-run means a later merge touched the file; a passing rerun is not proven.');
    for (const row of repos) console.log(`${row.repo}: ${row.run?.htmlUrl ?? 'unknown'} ${row.failedTests === null ? 'unknown' : row.failedTests.map(t => `${t.file}: ${t.status} ${t.commits.join(',')}`).join('; ') || 'no failed tests'}`);
  }
  return repos.some(row => row.failedTests === null) ? 1 : 0;
}
