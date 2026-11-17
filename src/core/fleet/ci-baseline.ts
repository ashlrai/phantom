import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, posix } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { CloudGh } from '../cloud/pr-actions.js';
import { scrubSecrets } from '../util/scrub.js';
import { defaultCiGh } from './ci-failure-groups.js';

type Failure = { testId: string; file: string; names: string; excerpt: string };
type Pr = { number: number; headRefOid: string; headRefName: string; files: { path: string }[] };
type Run = { id: number; head_sha: string; workflow_id: number; status: string };
type Job = { id: number; conclusion: string; head_sha: string };
type Observation = { pr: Pr; failure: Failure; touched: boolean | null; runId: number };

const clean = (s: string) => scrubSecrets(stripVTControlCharacters(s)).slice(0, 2000);
const lines = (s: string) => stripVTControlCharacters(s).split('\n').map(l => l.replace(/^\d{4}-\d\d-\d\dT\S+\s+/, '').trim());

export function parseBaselineFailures(log: string): Failure[] {
  const result: Failure[] = [];
  let current: Failure | undefined;
  for (const line of lines(log)) {
    const match = /^FAIL\s+(test\/[^\s>]+\.test\.[cm]?[jt]sx?)\s*>\s*(.+)$/.exec(line);
    if (match) {
      if (result.length >= 100) break;
      const file = match[1]!, names = clean(match[2]!);
      if (posix.normalize(file) !== file || file.includes('..')) continue;
      current = { file, names, testId: `${file} > ${names}`, excerpt: clean(line) };
      result.push(current);
    } else if (current && /^AssertionError:/.test(line)) {
      current.excerpt = clean(`${current.excerpt}\n${line}`);
    }
  }
  return result;
}

export async function analyzeCiBaseline(repo: string, gh: CloudGh = defaultCiGh) {
  if (!/^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(repo)) throw new Error('Invalid repository');
  const errors: string[] = [];
  async function json<T>(endpoint: string): Promise<T | null> {
    try {
      const r = await gh(['api', endpoint]);
      return r.ok ? JSON.parse(r.stdout) as T : null;
    } catch { return null; }
  }
  async function runs(ref: string): Promise<Run[] | null> {
    const data = await json<{ workflow_runs: Run[]; total_count: number }>(`repos/${repo}/actions/runs?head_sha=${encodeURIComponent(ref)}&per_page=100`);
    if (!Array.isArray(data?.workflow_runs) || data.total_count > 100) return null;
    const seen = new Set<number>();
    return data.workflow_runs.filter(r => { if (seen.has(r.workflow_id)) return false; seen.add(r.workflow_id); return true; });
  }
  async function logs(run: Run, head: string) {
    const data = await json<{ jobs: Job[]; total_count: number }>(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`);
    if (!Array.isArray(data?.jobs) || data.total_count > 100) return null;
    const result: { conclusion: string; text: string }[] = [];
    for (const job of data.jobs) {
      if (job.conclusion === 'skipped') continue;
      let r;
      try { r = await gh(['api', `repos/${repo}/actions/jobs/${job.id}/logs`]); } catch { return null; }
      const output = lines(r.stdout);
      const checkout = output.findIndex(line => /(?:^|\/)git log -1 --format=%H$/.test(line));
      if (!r.ok || job.head_sha !== head || checkout < 0 || output[checkout + 1] !== head) return null;
      result.push({ conclusion: job.conclusion, text: r.stdout });
    }
    return result;
  }
  const branch = await json<{ commit: { sha: string } }>(`repos/${repo}/branches/master`);
  const masterRuns = branch?.commit?.sha ? await runs(branch.commit.sha) : null;
  const masterLogs: { conclusion: string; text: string }[] = [];
  let masterKnown = !!branch?.commit?.sha && !!masterRuns?.length;
  for (const run of masterRuns ?? []) {
    if (run.head_sha !== branch?.commit?.sha || run.status !== 'completed') { masterKnown = false; continue; }
    const evidence = await logs(run, run.head_sha);
    if (evidence) masterLogs.push(...evidence); else masterKnown = false;
  }
  const masterFailures = masterLogs.flatMap(l => parseBaselineFailures(l.text));
  const passes = (f: Failure) => masterKnown && !masterFailures.some(m => m.testId === f.testId) && masterLogs.some(l => l.conclusion === 'success' && lines(l.text).some(line => {
    const m = /^[✓✔√]\s+(test\/\S+)\s*>\s*(.+?)(?:\s+\d+(?:\.\d+)?m?s)?$/.exec(line);
    return m?.[1] === f.file && m[2] === f.names;
  }));
  const dependencyCache = new Map<string, Promise<Set<string> | null>>();
  function dependencies(file: string): Promise<Set<string> | null> {
    const cached = dependencyCache.get(file);
    if (cached) return cached;
    const task = (async () => {
      const visited = new Set<string>();
      async function visit(path: string): Promise<boolean> {
        if (visited.has(path)) return true;
        if (visited.size >= 100 || path.startsWith('../')) return false;
        visited.add(path);
        const data = await json<{ content: string; encoding: string }>(`repos/${repo}/contents/${path}?ref=${branch?.commit?.sha ?? 'master'}`);
        if (data?.encoding !== 'base64' || typeof data.content !== 'string') return false;
        const source = Buffer.from(data.content, 'base64').toString('utf8');
        // Computed imports cannot be proved independent of a PR diff.
        if (/import\s*\(\s*[^'"\s]/.test(source)) return false;
        for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]+)['"]/g)) {
          const spec = match[1]!;
          if (spec.startsWith('node:')) continue;
          if (!spec.startsWith('.')) {
            if (spec.startsWith('#') || spec.startsWith('@/')) return false;
            for (const manifest of ['package.json', 'package-lock.json', 'pnpm-lock.yaml']) visited.add(manifest);
            continue;
          }
          let target = posix.normalize(posix.join(posix.dirname(path), spec));
          if (target.endsWith('.js')) target = target.slice(0, -3) + '.ts';
          if (!/\.[cm]?[jt]sx?$/.test(target) || !await visit(target)) return false;
        }
        return true;
      }
      return await visit(file) ? visited : null;
    })();
    dependencyCache.set(file, task);
    return task;
  }
  let prs: Pr[] = [];
  try {
    const r = await gh(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', 'number,headRefOid,headRefName,files']);
    if (r.ok) prs = JSON.parse(r.stdout) as Pr[]; else errors.push('open PRs unreadable');
    if (!Array.isArray(prs)) { prs = []; errors.push('invalid PR list'); }
  } catch { errors.push('open PRs unreadable'); }
  if (prs.length === 100) errors.push('PR list capped at 100');
  const freshness: { pr: number; head: string; state: string; reason?: string }[] = [];
  const observations: Observation[] = [];
  for (const pr of prs) {
    const data = await json<{ workflow_runs: Run[]; total_count: number }>(`repos/${repo}/actions/runs?branch=${encodeURIComponent(pr.headRefName)}&per_page=100`);
    const seen = new Set<number>();
    const latest = data?.workflow_runs?.filter(r => { if (seen.has(r.workflow_id)) return false; seen.add(r.workflow_id); return true; });
    if (!latest?.length || data!.total_count > 100) { freshness.push({ pr: pr.number, head: pr.headRefOid, state: 'unknown', reason: 'missing-or-capped-runs' }); continue; }
    if (latest.some(r => r.head_sha !== pr.headRefOid)) { freshness.push({ pr: pr.number, head: pr.headRefOid, state: 'stale', reason: 'stale-head' }); continue; }
    let known = true;
    const found: (Failure & { runId: number })[] = [];
    for (const run of latest) {
      if (run.status !== 'completed') { known = false; continue; }
      const evidence = await logs(run, pr.headRefOid);
      if (!evidence) { known = false; continue; }
      for (const log of evidence.filter(l => l.conclusion === 'failure')) {
        const failures = parseBaselineFailures(log.text);
        if (!failures.length) known = false;
        found.push(...failures.map(failure => ({ ...failure, runId: run.id })));
      }
    }
    freshness.push({ pr: pr.number, head: pr.headRefOid, state: known ? 'fresh' : 'unknown', ...(!known ? { reason: 'unreadable-log-or-unverified-checkout' } : {}) });
    if (!known) continue;
    for (const failure of found) {
      const deps = await dependencies(failure.file);
      const touched = pr.files?.some(f => f.path === failure.file) ? true : deps && pr.files?.length < 100 ? pr.files.some(f => deps.has(f.path)) : null;
      observations.push({ pr, failure, touched, runId: failure.runId });
    }
  }
  const ids = [...new Set(observations.map(o => o.failure.testId))].sort();
  const groups = ids.map(testId => {
    const rows = observations.filter(o => o.failure.testId === testId);
    const { file, names, testId: id, excerpt } = rows[0]!.failure;
    const failure = { file, names, testId: id, excerpt };
    const runs = [...new Map(rows.map(o => [`${o.pr.headRefOid}:${o.runId}`, { pr: o.pr.number, head: o.pr.headRefOid, runId: o.runId }])).values()];
    const unaffected = [...new Set(rows.filter(o => o.touched === false).map(o => o.pr.number))];
    const prNumbers = [...new Set(rows.map(o => o.pr.number))];
    const classification = unaffected.length >= 2 ? 'shared-baseline' : rows.every(o => o.touched === true) ? 'pr-caused' : prNumbers.length === 1 && rows[0]!.touched === false && passes(failure) ? 'probable-flake' : 'unknown';
    const action = classification === 'shared-baseline' ? 'queue-master-fix' : classification === 'probable-flake' ? 'rerun-failed' : classification === 'pr-caused' ? 'pr-caused' : 'unknown';
    const evidence = { ...failure, runs };
    const jobId = `RQ-CIBASE-${createHash('sha256').update(repo + ':' + testId).digest('hex').slice(0, 16).toUpperCase()}`;
    const brief = `Reproduce ${testId} on latest master in ${repo}; verify the intentional production contract before changing anything. Fix only the stale baseline or report if not reproducible; never weaken tests or edit Security GATES v3 files. Run affected tests. Include ${jobId} in the fix PR body. Blocked PRs: ${unaffected.join(', ')}. After merge, re-analyze and plan update-branch for unchanged heads.`;
    return { ...evidence, prs: prNumbers, unaffectedPrs: unaffected, classification, action, master: passes(failure) ? 'pass' : masterFailures.some(f => f.testId === testId) ? 'fail' : 'unknown', jobId, ...(action === 'queue-master-fix' ? { brief: clean(brief).replace(/[\r\n]/g, ' ') } : {}) };
  });
  const updates = groups.filter(g => g.classification === 'shared-baseline').flatMap(g => g.unaffectedPrs.map(pr => ({ pr, testId: g.testId, ready: g.master === 'pass', reason: g.master === 'pass' ? 'master-test-passes; merge provenance requires verification' : 'master-fix-not-verified', args: ['api', '-X', 'PUT', `repos/${repo}/pulls/${pr}/update-branch`, '-f', `expected_head_sha=${prs.find(p => p.number === pr)!.headRefOid}`] })));
  return { v: 1, repo, groups, freshness, master: { head: branch?.commit?.sha ?? null, known: masterKnown }, updates, errors };
}

export function enqueueBaselineFixes(report: Awaited<ReturnType<typeof analyzeCiBaseline>>, queuePath: string) {
  if (!isAbsolute(queuePath)) throw new Error('queue-file must be absolute');
  mkdirSync(dirname(queuePath), { recursive: true });
  const queued: string[] = [];
  let existing = existsSync(queuePath) ? readFileSync(queuePath, 'utf8') : '';
  for (const group of report.groups) {
    if (group.action !== 'queue-master-fix' || !group.brief || existing.includes(group.jobId)) continue;
    const line = `\n- READY ${group.jobId} (P1, repo=${report.repo.split('/')[1]}, tier=work, needs=git|gh|node): ${group.brief}\n`;
    appendFileSync(queuePath, line, 'utf8'); existing += line; queued.push(group.jobId);
  }
  return queued;
}

export async function applyBaselineUpdates(report: Awaited<ReturnType<typeof analyzeCiBaseline>>, gh: CloudGh = defaultCiGh) {
  const results: { pr: number; state: string }[] = [];
  for (const pr of new Set(report.updates.map(u => u.pr))) {
    const updates = report.updates.filter(u => u.pr === pr);
    let verified = updates.every(u => u.ready);
    try {
      for (const update of updates) {
        if (!verified) break;
        const group = report.groups.find(g => g.testId === update.testId)!;
        const response = await gh(['pr', 'list', '--repo', report.repo, '--state', 'merged', '--base', 'master', '--search', `${group.jobId} in:body`, '--json', 'body,mergeCommit', '--limit', '10']);
        const fixes = response.ok ? JSON.parse(response.stdout) as { body: string; mergeCommit: { oid: string } }[] : [];
        verified = false;
        for (const fix of fixes) {
          if (!fix.body.includes(group.jobId) || !/^[a-f0-9]{40}$/.test(fix.mergeCommit?.oid)) continue;
          const comparison = await gh(['api', `repos/${report.repo}/compare/${fix.mergeCommit.oid}...${report.master.head}`]);
          if (comparison.ok && ['ahead', 'identical'].includes((JSON.parse(comparison.stdout) as { status: string }).status)) verified = true;
        }
      }
      if (!verified) { results.push({ pr, state: 'skipped: master-fix-merge-unverified' }); continue; }
      const response = await gh(updates[0]!.args);
      results.push({ pr, state: response.ok ? 'updated' : 'failed' });
    } catch { results.push({ pr, state: 'unknown' }); }
  }
  return results;
}
