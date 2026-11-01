/**
 * planner-real-supply.ts — real work for the fleet planner, read live.
 *
 * The fleet's planner fills lanes with batch-written filler because its brief
 * carries no real supply: open Dependabot alerts, scheduled suites gone red
 * and open issues across the seven approved repos never reach it. For each
 * repo this collector reads all three from GitHub and returns ranked
 * candidates — critical alerts, then a red scheduled suite, then high
 * alerts, then issues — each with the exact target (manifest + patched
 * version, workflow name or issue number) and a one-line goal.
 *
 * READ-ONLY and pure: every call is a `gh api <path>` GET through an injected
 * reader or CloudGh, so tests never touch the network. A repo whose reads
 * fail is reported `unknown` with the reason — never a crash and never an
 * empty success — so the planner can tell "nothing open" from "could not
 * look". No secret values are read: the endpoints return alert metadata, run
 * listings and issue titles only.
 */
import type { CloudGh } from '../cloud/pr-actions.js';
import { QUEUEGEN_REPOS } from '../drive/queuegen.js';

export type RealSupplyKind = 'dependabot-critical' | 'scheduled-red' | 'dependabot-high' | 'issue';

export interface RealSupplyCandidate {
  /** Repo in owner/name form, e.g. 'ashlrai/ashlr-plugin'. */
  repo: string;
  kind: RealSupplyKind;
  /** Exact target: '<manifest> (<pkg> -> <patched>)', the workflow name or '#<n>'. */
  target: string;
  /** One-line goal the planner can turn into a job file. */
  goal: string;
}

export interface RealSupplyRepo {
  repo: string;
  status: 'ok' | 'unknown';
  reason?: string;
}

export interface RealSupplyV1 {
  v: 1;
  generatedAt: string;
  repos: RealSupplyRepo[];
  candidates: RealSupplyCandidate[];
}

export interface RealSupplyAlert {
  package: string;
  manifest: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  patched: string | null;
}

/** One repo's raw reads, before ranking and dedupe. */
export interface RealSupplyFacts {
  alerts: RealSupplyAlert[];
  /** The most recently failing scheduled workflow on the default branch. */
  redSuite: { workflow: string; branch: string } | null;
  issues: { number: number; title: string }[];
}

export type RealSupplyRead = { ok: true; facts: RealSupplyFacts } | { ok: false; reason: string };
export type RealSupplyReader = (repo: string) => Promise<RealSupplyRead>;

export interface RealSupplyDeps {
  /** Injected per-repo reader; wins over gh when both are given. */
  reader?: RealSupplyReader;
  /** Injected gh; used only when reader is absent. */
  gh?: CloudGh;
  repos?: readonly string[];
  now?: () => Date;
}

const ALERTS_PER_REPO = 100;
const SCHEDULED_RUNS_PER_REPO = 50;
const ISSUES_PER_REPO = 20;
/** The most candidates of any one kind a single repo may contribute. */
const MAX_ISSUE_CANDIDATES_PER_REPO = 10;
export const REAL_SUPPLY_BRIEF_CAP = 15;

const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
const KIND_ORDER: Record<RealSupplyKind, number> = {
  'dependabot-critical': 0, 'scheduled-red': 1, 'dependabot-high': 2, 'issue': 3,
};

const record = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 200);

/** Single printable line, bounded — API text must not smuggle control chars into a prompt. */
const clean = (value: unknown, max: number): string =>
  // eslint-disable-next-line no-control-regex -- API text must not carry control characters.
  typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').slice(0, max) : '';

function parseAlerts(value: unknown): RealSupplyAlert[] | null {
  if (!Array.isArray(value)) return null;
  const out: RealSupplyAlert[] = [];
  for (const row of value) {
    if (!record(row)) return null;
    const dep = record(row['dependency']) ? row['dependency'] : {};
    const vuln = record(row['security_vulnerability']) ? row['security_vulnerability'] : {};
    const pkg = record(vuln['package']) ? vuln['package'] : (record(dep['package']) ? dep['package'] : {});
    const name = clean(pkg['name'], 100);
    const manifest = clean(dep['manifest_path'], 160);
    const severity = clean(vuln['severity'], 16).toLowerCase();
    const patched = record(vuln['first_patched_version']) ? clean(vuln['first_patched_version']['identifier'], 60) : '';
    if (name === '' || manifest === '' || !(SEVERITIES as readonly string[]).includes(severity)) return null;
    out.push({ package: name, manifest, severity: severity as RealSupplyAlert['severity'], patched: patched === '' ? null : patched });
  }
  return out;
}

/**
 * The most recently failing scheduled workflow. `runs` arrives newest-first;
 * the first row per workflow_id is that workflow's latest scheduled run, and
 * only a `completed`/`failure` latest run marks the suite red.
 */
function parseRedSuite(value: unknown, branch: string): { workflow: string; branch: string } | null | 'invalid' {
  if (!record(value) || !Array.isArray(value['workflow_runs'])) return 'invalid';
  const latest = new Map<number, Record<string, unknown>>();
  for (const run of value['workflow_runs']) {
    if (!record(run) || typeof run['workflow_id'] !== 'number') return 'invalid';
    if (!latest.has(run['workflow_id'])) latest.set(run['workflow_id'], run);
  }
  for (const run of latest.values()) {
    if (run['status'] !== 'completed' || run['conclusion'] !== 'failure') continue;
    const workflow = clean(run['name'], 120);
    return { workflow: workflow === '' ? `workflow #${run['workflow_id']}` : workflow, branch };
  }
  return null;
}

function parseIssues(value: unknown): { number: number; title: string }[] | null {
  if (!Array.isArray(value)) return null;
  const out: { number: number; title: string }[] = [];
  for (const row of value) {
    if (!record(row)) return null;
    if (row['pull_request'] !== undefined) continue; // the issues endpoint lists PRs too
    if (typeof row['number'] !== 'number' || !Number.isSafeInteger(row['number'])) return null;
    out.push({ number: row['number'], title: clean(row['title'], 160) });
  }
  return out;
}

/** One read-only `gh api <path>` GET returning parsed JSON. */
async function ghApiJson(gh: CloudGh, endpoint: string): Promise<{ ok: true; value: unknown } | { ok: false; reason: string }> {
  let result: { ok: boolean; stdout: string; stderr: string };
  try {
    result = await gh(['api', endpoint]);
  } catch (error) {
    return { ok: false, reason: `gh api ${endpoint} threw (${errorText(error)})` };
  }
  if (!result.ok) {
    const detail = result.stderr.split('\n').map(line => line.trim()).find(Boolean);
    return { ok: false, reason: `gh api ${endpoint} failed${detail ? ` (${detail.slice(0, 200)})` : ''}` };
  }
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch {
    return { ok: false, reason: `gh api ${endpoint} did not return JSON` };
  }
}

/**
 * The production reader: four read-only `gh api` GETs per repo — repo
 * metadata (default branch), open Dependabot alerts, the newest scheduled
 * runs on that branch and open issues (PRs filtered out).
 */
export function ghRealSupplyReader(gh: CloudGh): RealSupplyReader {
  return async (repo) => {
    const meta = await ghApiJson(gh, `repos/${repo}`);
    if (!meta.ok) return meta;
    const branch = (meta.value as { default_branch?: unknown }).default_branch;
    if (typeof branch !== 'string' || branch === '') {
      return { ok: false, reason: `gh api repos/${repo} did not name a default branch` };
    }
    const alertsJson = await ghApiJson(gh, `repos/${repo}/dependabot/alerts?state=open&per_page=${ALERTS_PER_REPO}`);
    if (!alertsJson.ok) return alertsJson;
    const alerts = parseAlerts(alertsJson.value);
    if (alerts === null) return { ok: false, reason: `gh api dependabot/alerts for ${repo} returned an invalid listing` };
    const runsJson = await ghApiJson(gh, `repos/${repo}/actions/runs?event=schedule&branch=${encodeURIComponent(branch)}&per_page=${SCHEDULED_RUNS_PER_REPO}`);
    if (!runsJson.ok) return runsJson;
    const redSuite = parseRedSuite(runsJson.value, branch);
    if (redSuite === 'invalid') return { ok: false, reason: `gh api actions/runs for ${repo} returned an invalid listing` };
    const issuesJson = await ghApiJson(gh, `repos/${repo}/issues?state=open&per_page=${ISSUES_PER_REPO}`);
    if (!issuesJson.ok) return issuesJson;
    const issues = parseIssues(issuesJson.value);
    if (issues === null) return { ok: false, reason: `gh api issues for ${repo} returned an invalid listing` };
    return { ok: true, facts: { alerts, redSuite, issues } };
  };
}

const severityRank = (severity: RealSupplyAlert['severity']): number => SEVERITIES.indexOf(severity);

/**
 * One candidate per package per repo: several alerts on the same package
 * (different manifests or advisories) collapse to the worst-severity row,
 * preferring a patched target, then the lexically-first manifest.
 */
function dedupeAlerts(alerts: RealSupplyAlert[]): RealSupplyAlert[] {
  const rank = (a: RealSupplyAlert): number => severityRank(a.severity) * 2 + (a.patched === null ? 1 : 0);
  const byPackage = new Map<string, RealSupplyAlert>();
  for (const alert of alerts) {
    const prev = byPackage.get(alert.package);
    if (prev === undefined || rank(alert) < rank(prev)
      || (rank(alert) === rank(prev) && alert.manifest < prev.manifest)) {
      byPackage.set(alert.package, alert);
    }
  }
  return [...byPackage.values()];
}

/** Rank one repo's facts: critical alerts, its red suite, high alerts, then issues. */
export function rankRealSupply(perRepo: readonly { repo: string; facts: RealSupplyFacts }[]): RealSupplyCandidate[] {
  const candidates: RealSupplyCandidate[] = [];
  for (const { repo, facts } of perRepo) {
    for (const alert of dedupeAlerts(facts.alerts)) {
      if (alert.severity !== 'critical' && alert.severity !== 'high') continue;
      candidates.push({
        repo,
        kind: alert.severity === 'critical' ? 'dependabot-critical' : 'dependabot-high',
        target: `${alert.manifest} (${alert.package}${alert.patched === null ? '' : ` -> ${alert.patched}`})`,
        goal: alert.patched === null
          ? `Investigate ${alert.severity} Dependabot alert: ${alert.package} in ${alert.manifest} has no patched release yet`
          : `Bump ${alert.package} to ${alert.patched} in ${alert.manifest} (${alert.severity} Dependabot alert)`,
      });
    }
    if (facts.redSuite !== null) {
      candidates.push({
        repo, kind: 'scheduled-red', target: facts.redSuite.workflow,
        goal: `Fix scheduled workflow "${facts.redSuite.workflow}" — its latest run on ${facts.redSuite.branch} failed`,
      });
    }
    for (const issue of facts.issues.slice(0, MAX_ISSUE_CANDIDATES_PER_REPO)) {
      candidates.push({ repo, kind: 'issue', target: `#${issue.number}`, goal: `Resolve issue #${issue.number}: ${issue.title}` });
    }
  }
  return candidates.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || a.repo.localeCompare(b.repo) || a.target.localeCompare(b.target));
}

/**
 * Read every repo and rank the supply. A failed or throwing read marks that
 * repo `unknown` — never a crash, and `repos` always lists every repo so an
 * empty candidate list is visibly "all clean" or "partly unread", not a
 * silent success.
 */
export async function collectRealSupply(deps: RealSupplyDeps): Promise<RealSupplyV1> {
  const reader = deps.reader ?? (deps.gh !== undefined ? ghRealSupplyReader(deps.gh) : undefined);
  if (reader === undefined) throw new Error('collectRealSupply needs an injected reader or gh');
  const now = (deps.now ?? (() => new Date()))();
  const repos = deps.repos ?? QUEUEGEN_REPOS;
  const reads = await Promise.all(repos.map(async (repo) => {
    try {
      const read = await reader(repo);
      return read.ok
        ? { repo, status: 'ok' as const, facts: read.facts }
        : { repo, status: 'unknown' as const, reason: read.reason };
    } catch (error) {
      return { repo, status: 'unknown' as const, reason: `reader threw: ${errorText(error)}` };
    }
  }));
  return {
    v: 1, generatedAt: now.toISOString(),
    repos: reads.map(read => read.status === 'unknown'
      ? { repo: read.repo, status: 'unknown' as const, reason: read.reason }
      : { repo: read.repo, status: 'ok' as const }),
    candidates: rankRealSupply(reads.flatMap(read => read.status === 'ok' ? [{ repo: read.repo, facts: read.facts }] : [])),
  };
}

/**
 * The planner-brief section body: candidates in rank order, then unread
 * repos, capped so the section stays a glanceable list. The last line names
 * the hidden remainder rather than dropping it silently.
 */
export function realSupplyBriefLines(supply: RealSupplyV1, cap = REAL_SUPPLY_BRIEF_CAP): string[] {
  const lines = [
    ...supply.candidates.map(c => `${c.repo}: ${c.goal}`),
    ...supply.repos.flatMap(r => r.status === 'unknown' ? [`${r.repo}: supply unread (${r.reason ?? 'read failed'})`] : []),
  ];
  if (lines.length === 0) return ['(all repos read; no open alerts, red scheduled suites or issues)'];
  if (lines.length <= cap) return lines;
  return [...lines.slice(0, cap - 1), `… ${lines.length - cap + 1} more`];
}
