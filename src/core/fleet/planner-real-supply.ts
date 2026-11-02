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
 * Two local signals run once per read, after the per-repo candidates: fleet
 * verbs registered in src/cli/fleet-subcommand-registry.ts that no document
 * under docs/ names, and `fleet <verb>` commands README.md names that the
 * registry lacks — doc drift is real, exact-target work, and issues alone
 * are too thin to fill a lane.
 *
 * READ-ONLY and pure: every remote call is a `gh api <path>` GET through an
 * injected reader or CloudGh, and every local call is a bounded readFile /
 * readdir under the checkout root, so tests never touch the network or the
 * real checkout. A repo whose reads fail — or a local source that cannot be
 * read — is reported `unknown` with the reason: never a crash and never an
 * empty success, so the planner can tell "nothing open" from "could not
 * look". No secret values are read: the endpoints return alert metadata, run
 * listings and issue titles only, and the local reads never leave the
 * checkout.
 */
import { open, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CloudGh } from '../cloud/pr-actions.js';
import { QUEUEGEN_REPOS } from '../drive/queuegen.js';

export type RealSupplyKind = 'dependabot-critical' | 'scheduled-red' | 'dependabot-high' | 'issue'
  | 'undocumented-verb' | 'readme-missing-command';

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

/**
 * The local checkout read: `ok` with fresh registry/docs/README signals,
 * `unknown` with the read failure's reason, or `skipped` when deps turned
 * the read off. An unread source is never reported as an empty success.
 */
export interface RealSupplyLocal {
  status: 'ok' | 'unknown' | 'skipped';
  reason?: string;
}

export interface RealSupplyV1 {
  v: 1;
  generatedAt: string;
  repos: RealSupplyRepo[];
  local: RealSupplyLocal;
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

/** One checkout's registry↔docs drift facts, before ranking. */
export interface RealSupplyLocalFacts {
  /** Registry verbs (src/cli/fleet-subcommand-registry.ts) no doc under docs/ names. */
  undocumentedVerbs: string[];
  /** `fleet <verb>` commands README.md names that the registry lacks. */
  readmeMissingCommands: string[];
}

export type RealSupplyLocalRead = { ok: true; facts: RealSupplyLocalFacts } | { ok: false; reason: string };
export type RealSupplyLocalReader = () => Promise<RealSupplyLocalRead>;

/**
 * The narrow file access the local signals need — injectable so a test can
 * run the real reader against a small fixture instead of the whole repo.
 */
export interface RealSupplyLocalIo {
  /** UTF-8 text of one regular file under the root; rejects when unreadable. */
  readFile(path: string): Promise<string>;
  /** Every *.md path under dir, recursive, sorted. */
  listMarkdown(dir: string): Promise<string[]>;
}

export interface RealSupplyDeps {
  /** Injected per-repo reader; wins over gh when both are given. */
  reader?: RealSupplyReader;
  /** Injected gh; used only when reader is absent. */
  gh?: CloudGh;
  /**
   * Injected local-signal reader. `false` skips the read (status 'skipped');
   * when absent, the fs reader scans the checkout at localRoot.
   */
  local?: RealSupplyLocalReader | false;
  /** Checkout root for the default local reader; defaults to this package root. */
  localRoot?: string;
  repos?: readonly string[];
  now?: () => Date;
}

const ALERTS_PER_REPO = 100;
const SCHEDULED_RUNS_PER_REPO = 50;
const ISSUES_PER_REPO = 20;
/** The most candidates of any one kind a single repo may contribute. */
const MAX_ISSUE_CANDIDATES_PER_REPO = 10;
export const REAL_SUPPLY_BRIEF_CAP = 15;

/** Local candidates name the checkout they were read from — this repo. */
const LOCAL_SUPPLY_REPO = 'ashlrai/phantom';
const LOCAL_REGISTRY_PATH = join('src', 'cli', 'fleet-subcommand-registry.ts');
const LOCAL_DOCS_DIR = 'docs';
const LOCAL_README_PATH = 'README.md';
const LOCAL_MAX_DEPTH = 8;
const LOCAL_MAX_DOC_FILES = 512;
const LOCAL_MAX_FILE_BYTES = 1024 * 1024;
const LOCAL_MAX_DOCS_BYTES = 8 * 1024 * 1024;
const LOCAL_READ_CONCURRENCY = 64;
/** The generated registry's shape: only `'verb': () => import(` keys count. */
const REGISTRY_VERB_RE = /'([a-z][a-z0-9]*(?:-[a-z0-9]+)*)'\s*:\s*\(\)\s*=>\s*import\(/g;
/**
 * A fleet command named in README: `phm|ashlr fleet <verb>` invocations or
 * a backticked `` `fleet <verb>` `` — never bare prose like "fleet server".
 */
const README_FLEET_COMMAND_RE = /(?:\b(?:phm|ashlr)\s+fleet\s+|`fleet\s+)([a-z][a-z0-9]*(?:-[a-z0-9]+)*)/g;

const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
const KIND_ORDER: Record<RealSupplyKind, number> = {
  'dependabot-critical': 0, 'scheduled-red': 1, 'dependabot-high': 2, 'issue': 3,
  'undocumented-verb': 4, 'readme-missing-command': 5,
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

/**
 * Production IO for the local signals: bounded reads under the checkout
 * root. A file over LOCAL_MAX_FILE_BYTES or a docs listing deeper than
 * LOCAL_MAX_DEPTH fails the read — the source is reported unknown rather
 * than searched partially, because a half-read docs/ tree can still hide
 * the one file that names a verb.
 */
export function fsRealSupplyLocalIo(): RealSupplyLocalIo {
  return {
    readFile: async (path) => {
      const handle = await open(path, 'r');
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > LOCAL_MAX_FILE_BYTES) {
          throw new Error(`not a regular file under ${LOCAL_MAX_FILE_BYTES} bytes`);
        }
        return await handle.readFile('utf8');
      } finally {
        await handle.close();
      }
    },
    listMarkdown: async (dir) => {
      const out: string[] = [];
      const walk = async (current: string, depth: number): Promise<void> => {
        if (depth > LOCAL_MAX_DEPTH) throw new Error(`docs tree deeper than ${LOCAL_MAX_DEPTH}`);
        for (const entry of await readdir(current, { withFileTypes: true })) {
          const path = join(current, entry.name);
          if (entry.isDirectory()) await walk(path, depth + 1);
          else if (entry.isFile() && entry.name.endsWith('.md')) out.push(path);
        }
      };
      await walk(dir, 0);
      if (out.length > LOCAL_MAX_DOC_FILES) throw new Error(`more than ${LOCAL_MAX_DOC_FILES} markdown files`);
      return out.sort();
    },
  };
}

/**
 * The local signals: registry verbs no doc under docs/ names, and `fleet
 * <verb>` commands README.md names that the registry lacks. Any unreadable
 * source — registry, docs tree or README — fails the whole read so a verb
 * is never flagged "undocumented" on a partial scan.
 */
export function realSupplyLocalReader(io: RealSupplyLocalIo, root: string): RealSupplyLocalReader {
  return async () => {
    let registry: string;
    try {
      registry = await io.readFile(join(root, LOCAL_REGISTRY_PATH));
    } catch (error) {
      return { ok: false, reason: `cannot read ${LOCAL_REGISTRY_PATH} (${errorText(error)})` };
    }
    const verbs = [...registry.matchAll(REGISTRY_VERB_RE)].map(match => match[1]!);
    if (verbs.length === 0) {
      return { ok: false, reason: `${LOCAL_REGISTRY_PATH} named no verbs — unexpected registry shape` };
    }
    let docPaths: string[];
    try {
      docPaths = await io.listMarkdown(join(root, LOCAL_DOCS_DIR));
    } catch (error) {
      return { ok: false, reason: `cannot list ${LOCAL_DOCS_DIR}/ (${errorText(error)})` };
    }
    const docsParts: string[] = [];
    let docsBytes = 0;
    // Bounded parallelism: sequential stat+read per file costs seconds on
    // slow or sandboxed filesystems; 64 open handles stay under fd limits.
    for (let i = 0; i < docPaths.length; i += LOCAL_READ_CONCURRENCY) {
      const batch = await Promise.all(
        docPaths.slice(i, i + LOCAL_READ_CONCURRENCY).map(async (path): Promise<string | { reason: string }> => {
          try {
            return await io.readFile(path);
          } catch (error) {
            return { reason: `cannot read ${relative(root, path)} (${errorText(error)})` };
          }
        }),
      );
      for (const part of batch) {
        if (typeof part !== 'string') return { ok: false, reason: part.reason };
        docsBytes += part.length;
        if (docsBytes > LOCAL_MAX_DOCS_BYTES) {
          return { ok: false, reason: `${LOCAL_DOCS_DIR}/ exceeds the ${LOCAL_MAX_DOCS_BYTES}-byte read window` };
        }
        docsParts.push(part);
      }
    }
    let readme: string;
    try {
      readme = await io.readFile(join(root, LOCAL_README_PATH));
    } catch (error) {
      return { ok: false, reason: `cannot read ${LOCAL_README_PATH} (${errorText(error)})` };
    }
    const blob = docsParts.join('\n');
    const registered = new Set(verbs);
    // One scan of the docs blob: verb names match [a-z0-9-]+ so no escaping
    // is needed, and a single alternation beats a regex compile per verb.
    const named = new Set(blob.match(new RegExp(`\\b(?:${verbs.join('|')})\\b`, 'g')) ?? []);
    const undocumentedVerbs = verbs.filter(verb => !named.has(verb));
    const readmeMissingCommands = [...new Set(
      [...readme.matchAll(README_FLEET_COMMAND_RE)].map(match => match[1]!),
    )].filter(command => !registered.has(command));
    return { ok: true, facts: { undocumentedVerbs, readmeMissingCommands } };
  };
}

/** The checkout this module ships in: src/core/fleet or dist/core/fleet → package root. */
const defaultLocalRoot = (): string => fileURLToPath(new URL('../../..', import.meta.url));

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

/**
 * Rank one repo's facts: critical alerts, its red suite, high alerts, then
 * issues — then the local signals, undocumented verbs before missing
 * README commands.
 */
export function rankRealSupply(
  perRepo: readonly { repo: string; facts: RealSupplyFacts }[],
  local?: RealSupplyLocalFacts,
): RealSupplyCandidate[] {
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
  if (local !== undefined) {
    for (const verb of local.undocumentedVerbs) {
      candidates.push({
        repo: LOCAL_SUPPLY_REPO, kind: 'undocumented-verb', target: verb,
        goal: `Document fleet verb "${verb}" — it is registered but no file under docs/ names it (add its docs/FLEET-VERBS.md row)`,
      });
    }
    for (const command of local.readmeMissingCommands) {
      candidates.push({
        repo: LOCAL_SUPPLY_REPO, kind: 'readme-missing-command', target: `fleet ${command}`,
        goal: `README.md names "fleet ${command}" but src/cli/fleet-subcommand-registry.ts lacks it — add the verb or fix the README line`,
      });
    }
  }
  return candidates.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || a.repo.localeCompare(b.repo) || a.target.localeCompare(b.target));
}

/**
 * Read every repo plus the local signals and rank the supply. A failed or
 * throwing read marks that repo — or the local source — `unknown`: never a
 * crash, and `repos`/`local` always report their status so an empty
 * candidate list is visibly "all clean" or "partly unread", not a silent
 * success.
 */
export async function collectRealSupply(deps: RealSupplyDeps): Promise<RealSupplyV1> {
  const reader = deps.reader ?? (deps.gh !== undefined ? ghRealSupplyReader(deps.gh) : undefined);
  if (reader === undefined) throw new Error('collectRealSupply needs an injected reader or gh');
  const now = (deps.now ?? (() => new Date()))();
  const repos = deps.repos ?? QUEUEGEN_REPOS;
  const localReader = deps.local === false ? null
    : (deps.local ?? realSupplyLocalReader(fsRealSupplyLocalIo(), deps.localRoot ?? defaultLocalRoot()));
  const [reads, local] = await Promise.all([
    Promise.all(repos.map(async (repo) => {
      try {
        const read = await reader(repo);
        return read.ok
          ? { repo, status: 'ok' as const, facts: read.facts }
          : { repo, status: 'unknown' as const, reason: read.reason };
      } catch (error) {
        return { repo, status: 'unknown' as const, reason: `reader threw: ${errorText(error)}` };
      }
    })),
    (async (): Promise<RealSupplyLocal & { facts?: RealSupplyLocalFacts }> => {
      if (localReader === null) return { status: 'skipped' };
      try {
        const read = await localReader();
        return read.ok
          ? { status: 'ok' as const, facts: read.facts }
          : { status: 'unknown' as const, reason: read.reason };
      } catch (error) {
        return { status: 'unknown' as const, reason: `local reader threw: ${errorText(error)}` };
      }
    })(),
  ]);
  return {
    v: 1, generatedAt: now.toISOString(),
    repos: reads.map(read => read.status === 'unknown'
      ? { repo: read.repo, status: 'unknown' as const, reason: read.reason }
      : { repo: read.repo, status: 'ok' as const }),
    local: local.status === 'unknown' ? { status: 'unknown', reason: local.reason } : { status: local.status },
    candidates: rankRealSupply(
      reads.flatMap(read => read.status === 'ok' ? [{ repo: read.repo, facts: read.facts }] : []),
      local.status === 'ok' ? local.facts : undefined,
    ),
  };
}

/**
 * The planner-brief section body: candidates in rank order, then unread
 * sources, capped so the section stays a glanceable list. The last line
 * names the hidden remainder rather than dropping it silently.
 */
export function realSupplyBriefLines(supply: RealSupplyV1, cap = REAL_SUPPLY_BRIEF_CAP): string[] {
  const lines = [
    ...supply.candidates.map(c => `${c.repo}: ${c.goal}`),
    ...supply.repos.flatMap(r => r.status === 'unknown' ? [`${r.repo}: supply unread (${r.reason ?? 'read failed'})`] : []),
    ...(supply.local.status === 'unknown'
      ? [`${LOCAL_SUPPLY_REPO} (local): supply unread (${supply.local.reason ?? 'read failed'})`]
      : []),
  ];
  if (lines.length === 0) {
    return ['(all sources read; no open alerts, red scheduled suites, issues or registry/doc drift)'];
  }
  if (lines.length <= cap) return lines;
  return [...lines.slice(0, cap - 1), `… ${lines.length - cap + 1} more`];
}
