import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, posix } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { CloudGh } from '../cloud/pr-actions.js';
import { globMatches } from '../authority/protected-paths.js';
import { scrubSecrets } from '../util/scrub.js';
import { defaultCiGh } from './ci-failure-groups.js';
import { nextFixGeneration } from './ci-fix-generations.js';

type Failure = { testId: string; file: string; names: string; excerpt: string };
type Pr = { number: number; headRefOid: string; headRefName: string; files: { path: string }[] };
type Run = { id: number; head_sha: string; workflow_id: number; status: string };
type Job = { id: number; conclusion: string; head_sha: string };
type Observation = { pr: Pr; failure: Failure; touched: boolean | null; runId: number };

const clean = (s: string) => scrubSecrets(stripVTControlCharacters(s)).slice(0, 2000);
const lines = (s: string) => stripVTControlCharacters(s).split('\n').map(l => l.replace(/^\d{4}-\d\d-\d\dT\S+\s+/, '').trim());

// Vitest runs under named projects (unit, real-io, serial-cpu on the backend;
// console, transcript on the web console), so failure and verbose pass lines
// carry a `|project|` label between the marker and the repo-relative test
// path. The vitest suites live under `test/` and `src/web-ui/`.
const FAIL_LINE = /^FAIL\s+(?:\|[^|]*\|\s+)?((?:test|src\/web-ui)\/[^\s>]+\.test\.[cm]?[jt]sx?)\s*>\s*(.+)$/;
// A suite that fails to load (transform, parse, or top-level throw during
// collection) never reaches a test, so vitest prints `FAIL  <file> [ <file> ]`
// with no `> name`. Without this shape those failures are invisible: every PR
// reads unknown and no master fix is ever queued for a broken suite.
const SUITE_FAIL_LINE = /^FAIL\s+(?:\|[^|]*\|\s+)?((?:test|src\/web-ui)\/[^\s>]+\.test\.[cm]?[jt]sx?)\s+\[[^\]]*\]\s*$/;
const SUITE_NAMES = '(suite)';
const PASS_LINE = /^[\u2713\u2714\u221a]\s+(?:\|[^|]*\|\s+)?((?:test|src\/web-ui)\/\S+)\s*>\s*(.+?)(?:\s+\d+(?:\.\d+)?m?s)?$/;

export function parseBaselineFailures(log: string): Failure[] {
  const result: Failure[] = [];
  let current: Failure | undefined;
  let currentSuite = false;
  for (const line of lines(log)) {
    const match = FAIL_LINE.exec(line);
    const suite = match === null ? SUITE_FAIL_LINE.exec(line) : null;
    if (match !== null || suite !== null) {
      if (result.length >= 100) break;
      const file = (match ?? suite)![1]!, names = match === null ? SUITE_NAMES : clean(match[2]!);
      if (posix.normalize(file) !== file || file.includes('..')) continue;
      current = { file, names, testId: `${file} > ${names}`, excerpt: clean(line) };
      currentSuite = match === null;
      result.push(current);
    } else if (current && (/^AssertionError:/.test(line) || (currentSuite && /^[\w$]*Error:/.test(line)))) {
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
  // A suite failure has no per-test pass line to match: the file loading and
  // running at all (any verbose pass in it) is what resolves it.
  const passes = (f: Failure) => masterKnown && !masterFailures.some(m => m.testId === f.testId) && masterLogs.some(l => l.conclusion === 'success' && lines(l.text).some(line => {
    const m = PASS_LINE.exec(line);
    return m?.[1] === f.file && (f.names === SUITE_NAMES || m[2] === f.names);
  }));
  const dependencyCache = new Map<string, Promise<Set<string> | null>>();
  const contentsCache = new Map<string, Promise<{ ok: boolean; absent: boolean; source: string | null }>>();
  const ref = branch?.commit?.sha ?? 'master';
  // Bundler-resolution candidates for one normalized repo-relative spec base.
  // Explicit extensions keep TypeScript precedence (.js -> .ts before .tsx,
  // the literal spec last so a real .js/.mjs file still resolves); extensionless
  // specs try file then directory index; every other extension (.json, css,
  // assets, query-stripped specs) resolves to itself and joins the closure as
  // a leaf without recursion.
  function specCandidates(base: string): string[] {
    if (base === '.') return ['index.ts', 'index.tsx'];
    const ext = posix.extname(base).toLowerCase();
    const stem = base.slice(0, base.length - ext.length);
    switch (ext) {
      case '.js': return [`${stem}.ts`, `${stem}.tsx`, base];
      case '.jsx': return [`${stem}.tsx`, `${stem}.ts`, base];
      case '.mjs': return [`${stem}.mts`, base];
      case '.cjs': return [`${stem}.cts`, base];
      case '': return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
      default: return [base];
    }
  }
  const CODE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
  const isCode = (path: string) => CODE_EXT.has(posix.extname(path).toLowerCase());
  async function contents(path: string) {
    let pending = contentsCache.get(path);
    if (!pending) {
      pending = (async () => {
        try {
          const r = await gh(['api', `repos/${repo}/contents/${path}?ref=${ref}`]);
          if (!r.ok) return { ok: false, absent: /404|not found/i.test(r.stderr ?? ''), source: null };
          const data = JSON.parse(r.stdout) as { content?: unknown; encoding?: unknown };
          if (data?.encoding !== 'base64' || typeof data.content !== 'string') return { ok: false, absent: false, source: null };
          return { ok: true, absent: false, source: Buffer.from(data.content, 'base64').toString('utf8') };
        } catch { return { ok: false, absent: false, source: null }; }
      })();
      contentsCache.set(path, pending);
    }
    return pending;
  }
  function dependencies(file: string): Promise<Set<string> | null> {
    const cached = dependencyCache.get(file);
    if (cached) return cached;
    const task = (async () => {
      const visited = new Set<string>();
      async function visit(path: string): Promise<boolean> {
        if (visited.has(path)) return true;
        if (visited.size >= 100 || path.startsWith('../')) return false;
        visited.add(path);
        const fetched = await contents(path);
        if (!fetched.ok || fetched.source === null) return false;
        const source = fetched.source;
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
          const queryIndex = spec.indexOf('?');
          const cleanSpec = queryIndex === -1 ? spec : spec.slice(0, queryIndex);
          const query = queryIndex === -1 ? '' : spec.slice(queryIndex);
          const base = posix.normalize(posix.join(posix.dirname(path), cleanSpec));
          if (base.startsWith('../') || posix.isAbsolute(base)) return false;
          let resolved: string | null = null;
          for (const candidate of specCandidates(base)) {
            const hit = await contents(candidate);
            if (hit.ok) { resolved = candidate; break; }
            // A definitive 404 tries the next candidate; any other failure
            // (rate limit, 5xx, malformed body) fails the whole closure closed.
            if (!hit.absent) return false;
          }
          if (resolved === null) return false;
          // Asset queries (?raw/?url/?inline) embed file contents or URLs; the
          // resolved file is a leaf dep and its own imports never execute.
          if (!isCode(resolved) || /[?&](?:raw|url|inline)\b/.test(query)) { visited.add(resolved); continue; }
          if (!await visit(resolved)) return false;
        }
        return true;
      }
      return await visit(file) ? visited : null;
    })();
    dependencyCache.set(file, task);
    return task;
  }

  // ---------------------------------------------------------------------
  // Harness dependencies
  //
  // A test's import closure misses everything the RUNNER injects: the vitest
  // config itself (timeouts, lane membership, sequencer), its setupFiles and
  // globalSetup entries, and whatever those import (HOME guards, mock shims,
  // src helpers). It also misses toolchain configs (tsconfig/jsconfig) that
  // change how sources transform, and manifests for suites running without
  // bare imports (vitest globals mode). A PR touching only the harness fails
  // suites whose own closures look untouched — without this union it is
  // misread as a flake or a shared-baseline break.
  //
  // Harness deps resolve once per repo. An unreadable governing config, an
  // unresolvable setup entry, or a failed probe yields null — the touched
  // check then fails closed (unknown), never "unaffected".
  //
  // Runner configs are discovered by name, not probed: `vitest.config.web.ts`,
  // `vitest.config.coverage.mjs` and friends all govern suites, so the root
  // listing (one API call) is filtered for the vitest config/workspace shape.
  const VITEST_CONFIG_NAME = /^vitest\.(?:config|workspace)(?:\.[\w-]+)*\.[cm]?[jt]sx?$/;
  const HARNESS_AMBIENT_BASE = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'tsconfig.json', 'jsconfig.json'];
  const HARNESS_QUOTED = /'([^']*)'|"([^"]*)"|`([^`]*)`/g;
  const HARNESS_GLOB_CHARS = /[*?[\]{}]/;

  interface HarnessConfig { path: string; includes: string[]; setups: string[] }

  function harnessLiterals(source: string, keyPattern: RegExp): string[] {
    const out: string[] = [];
    for (const m of source.matchAll(keyPattern)) {
      for (const q of m[1]!.matchAll(HARNESS_QUOTED)) out.push(q[1] ?? q[2] ?? q[3] ?? '');
    }
    return out;
  }

  // Path strings in a config are relative to the config's directory. `..`
  // escapes and glob setup entries cannot be enumerated without a tree listing,
  // so they fail the whole harness closed rather than guess.
  function harnessRepoPath(dir: string, entry: string): string | null {
    const joined = posix.normalize(posix.join(dir === '.' ? '' : dir, entry));
    return joined === '..' || joined.startsWith('../') || posix.isAbsolute(joined) ? null : joined;
  }

  function parseHarnessConfig(path: string, source: string): HarnessConfig | 'degraded' {
    const dir = posix.dirname(path);
    const setups = new Set<string>();
    for (const entry of harnessLiterals(source, /(?:setupFiles|globalSetup)\s*:\s*(\[[^\]]*\]|['"`][^'"`]*['"`])/g)) {
      if (!entry.startsWith('.')) continue; // bare specifier: package manifests are already ambient
      if (HARNESS_GLOB_CHARS.test(entry)) return 'degraded';
      const resolved = harnessRepoPath(dir, entry);
      if (resolved === null) return 'degraded';
      setups.add(resolved);
    }
    const includes = harnessLiterals(source, /\binclude\s*:\s*(\[[^\]]*\]|['"`][^'"`]*['"`])/g)
      .map(g => harnessRepoPath(dir, g))
      .filter((g): g is string => g !== null);
    return { path, includes, setups: [...setups] };
  }

  let harnessDiscovery: Promise<HarnessConfig[] | null> | null = null;
  function discoverHarnessConfigs(): Promise<HarnessConfig[] | null> {
    harnessDiscovery ??= (async () => {
      let names: string[];
      try {
        const r = await gh(['api', `repos/${repo}/contents/?ref=${ref}`]);
        if (!r.ok) return null;
        const entries = JSON.parse(r.stdout) as { name?: unknown; type?: unknown }[] | null;
        if (!Array.isArray(entries)) return null;
        names = entries
          .filter(e => e?.type === 'file' && typeof e?.name === 'string' && VITEST_CONFIG_NAME.test(e.name))
          .map(e => e.name as string)
          .sort();
      } catch {
        return null;
      }
      const configs: HarnessConfig[] = [];
      for (const name of names) {
        const fetched = await contents(name);
        if (fetched.ok && fetched.source !== null) {
          const parsed = parseHarnessConfig(name, fetched.source);
          if (parsed === 'degraded') return null;
          configs.push(parsed);
        } else if (!fetched.absent) {
          return null;
        }
      }
      return configs;
    })();
    return harnessDiscovery;
  }

  const harnessFileCache = new Map<string, Promise<Set<string> | null>>();
  function harnessAmbient(file: string): Promise<Set<string> | null> {
    let pending = harnessFileCache.get(file);
    if (!pending) {
      pending = (async () => {
        const configs = await discoverHarnessConfigs();
        if (configs === null) return null;
        const out = new Set(HARNESS_AMBIENT_BASE);
        for (const cfg of configs) {
          // No literal includes means the config's collection scope cannot be
          // proven narrow, so it governs every suite (conservative).
          if (cfg.includes.length > 0 && !cfg.includes.some(g => globMatches(g, file))) continue;
          const own = await dependencies(cfg.path);
          if (own === null) return null;
          for (const p of own) out.add(p);
          for (const setup of cfg.setups) {
            const closure = await dependencies(setup);
            if (closure === null) return null;
            for (const p of closure) out.add(p);
          }
        }
        // Nearest toolchain config walking up from the test file: bundlers read
        // the closest tsconfig/jsconfig per transformed file.
        let dir = posix.dirname(file);
        for (;;) {
          for (const name of ['tsconfig.json', 'jsconfig.json']) {
            const p = dir === '.' ? name : `${dir}/${name}`;
            const fetched = await contents(p);
            if (fetched.ok) out.add(p);
            else if (!fetched.absent) return null;
          }
          if (dir === '.') break;
          const parent = posix.dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
        return out;
      })();
      harnessFileCache.set(file, pending);
    }
    return pending;
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
      const ambient = await harnessAmbient(failure.file);
      const touched = pr.files?.some(f => f.path === failure.file) ? true : deps && ambient && pr.files?.length < 100 ? pr.files.some(f => deps.has(f.path) || ambient.has(f.path)) : null;
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
    if (group.action !== 'queue-master-fix' || !group.brief) continue;
    const retry = nextFixGeneration(existing, group.jobId);
    if (!retry) continue;
    const brief = retry.generation === 1 ? group.brief
      : `${group.brief} Stabilization attempt ${retry.generation}: earlier attempts for this test reached DONE and the failure is still observed on current evidence; queue id ${retry.jobId} — include ${retry.jobId} in the fix PR body.`;
    const line = `\n- READY ${retry.jobId} (P1, repo=${report.repo.split('/')[1]}, tier=work, needs=git|gh|node): ${brief}\n`;
    appendFileSync(queuePath, line, 'utf8'); existing += line; queued.push(retry.jobId);
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
