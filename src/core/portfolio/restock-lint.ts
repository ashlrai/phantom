/**
 * Restock/queuegen admission lint for the markdown router queue.
 *
 * The bridge's restocker and queue generator must not admit a candidate line
 * that the dispatcher cannot safely run. Every rejected candidate produces a
 * structured drop record with machine-readable reasons — a drop is always
 * logged, never silent. Queue text is untrusted task data: this module only
 * reads it and never executes or interpolates it.
 *
 * Line grammar (mirrors the host restocker):
 *   - READY <job-id> [r<recut>] (<attrs>): <task text>
 * Attributes are comma-separated key=value pairs and bare tokens (P0, EO 13:50).
 * `after <deps>` / `depends[ =]<deps>` declare job or PR dependencies;
 * `esc=<pool> after <N> failed` is an escalation spec, never a dependency.
 */
import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The seven fleet repositories restock may route to, as ~/Projects/ashlrai/<name>. */
export const FLEET_REPOS = ['phantom', 'phantom-secrets', 'locus', 'lexicon', 'ashlr-stack', 'ashlr-plugin', 'ashlr-md'] as const;
export type FleetRepo = typeof FLEET_REPOS[number];

export type LintReason =
  | 'unparseable'         // `- READY` line that fails the candidate grammar
  | 'bad-id'              // job id does not start with an uppercase letter or has bad characters
  | 'dup-line'            // the same job id appears on an earlier candidate line
  | 'no-repo'             // no repo= attribute and no LAND-<repo>-<n> id fallback
  | 'bad-repo'            // repo= is not one of the seven fleet repositories
  | 'repo-folder-missing' // ~/Projects/ashlrai/<repo> is not a directory
  | 'github-protected'    // task touches .github/ outside an explicit negation
  | 'no-file-path'        // task text names no concrete file path
  | 'no-test-command'     // task text names no test/verification or acceptance
  | 'bad-dep'             // a dependency token is malformed
  | 'unlanded-dep'        // a job/PR dependency has no landed/merged evidence
  | 'unknown-pool';       // pool= is outside the caller-supplied pool set

export interface RestockEscalation {
  /** Escalation target pool from esc=<pool>; null when only `after N failed` is present. */
  pool: string | null;
  /** Failed-attempt threshold from `after <N> failed`; null for a bare esc=. */
  afterFailed: number | null;
}

export interface RestockCandidate {
  /** 1-based line number in the source document. */
  line: number;
  /** The unmodified source line; untrusted task data, never shell input. */
  raw: string;
  jobId: string;
  repo: FleetRepo;
  attrs: string;
  task: string;
  deps: string[];
  escalation: RestockEscalation | null;
}

export interface RestockDrop {
  /** 1-based line number in the source document. */
  line: number;
  /** Job id when the line parsed far enough to carry one. */
  jobId: string | null;
  reasons: LintReason[];
  /** SHA-256 of the raw line for correlation; task text is never logged. */
  sha: string;
}

export interface RestockLintReport {
  /** Every line starting with `- READY`, including unparseable ones. */
  candidates: number;
  accepted: RestockCandidate[];
  drops: RestockDrop[];
}

export interface RestockLintOptions {
  /** Root containing one folder per repo. Default: ~/Projects/ashlrai. */
  reposRoot?: string;
  /**
   * Landed evidence: job ids and PR references known to be merged/landed.
   * PR entries may be `https://github.com/ashlrai/<repo>/pull/<n>`,
   * `ashlrai/<repo>/pull/<n>`, `<repo>#<n>` or `#<n>` (any repo).
   * Job dependencies also count as landed when the same document marks
   * their id DONE, MERGED or LANDED.
   */
  landed?: ReadonlySet<string>;
  /** Deployment lane allowlist for pool=. Omitted means pool is not checked. */
  pools?: ReadonlySet<string>;
  /** Directory probe; injectable. Defaults to a real isDirectory stat. */
  isDir?(path: string): boolean;
}

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]+$/;
const DEP_ID = /^[A-Za-z0-9._-]+$/;
const READY_LINE = /^- READY ([A-Za-z0-9][A-Za-z0-9._-]+)(?: r\d+)? \((.*?)\):\s*(.*)$/;
const READY_PREFIX = /^- READY\s/;
const STATUS_LINE = /^- ([A-Z][A-Z-]*)\s+(.*)$/;
const STATUS_ID = /^(?:RQ|RADAR|LAND|G\d|FIX)[A-Za-z0-9._-]*[A-Za-z0-9]$/;
const LANDED_STATUSES = new Set(['DONE', 'MERGED', 'LANDED']);
const REPO_ATTR = /\brepo=(?:ashlrai\/)?([a-z0-9-]+)/;
const LAND_ID = /^LAND-(?:RECUT-)?([a-z][a-z-]*?)-\d+$/;
const POOL_ATTR = /\bpool=([a-z0-9-]+)/;
const ESC_ATTR = /\besc=([a-z0-9-]+)/;
const ESCALATION_TIMING = /^\d+\s+failed(?:\s+attempts?)?$/;
const DEP_CLAUSE = /\b(?:after|depends(?:\s+on)?)\s*=?\s*([^,]*[^,\s])/g;
const DEP_SPLIT = /\s+and\s+|,\s*/;
const SUFFIX_DEP = /^-[A-Z]$/;
const JOB_SUFFIX = /^(.*)-[A-Z]$/;
const PR_URL = /^https:\/\/github\.com\/ashlrai\/([a-z0-9-]+)\/pull\/(\d+)$/;
const PR_SHORT = /^ashlrai\/([a-z0-9-]+)\/pull\/(\d+)$/;
const PR_REPO_NUM = /^([a-z0-9-]+)#(\d+)$/;
const PR_MARKED = /^(?:PR#|#|pull\/)(\d+)$/i;

// A concrete file path: slash-separated segments ending in name.ext (any ext)
// or a known extensionless basename; a bare name.ext needs a common source
// extension or a :line suffix so schema handles like `queue.v1` do not count.
const KNOWN_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'py', 'sh', 'bash', 'zsh',
  'md', 'mdx', 'txt', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'xml', 'html', 'htm',
  'css', 'scss', 'rs', 'go', 'rb', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'm', 'mm',
  'java', 'kt', 'kts', 'sql', 'lua', 'pl', 'pm', 'r', 'php', 'ex', 'exs', 'erl',
  'hrl', 'zig', 'fs', 'fsx', 'cs', 'ps1', 'bat', 'cmd', 'ini', 'cfg', 'conf',
  'plist', 'csv', 'tsv', 'lock', 'patch', 'diff', 'snap', 'proto', 'graphql',
]);
const KNOWN_BASENAME = new Set([
  'Makefile', 'Dockerfile', 'Containerfile', 'LICENSE', 'LICENCE', 'CODEOWNERS',
  'Rakefile', 'Gemfile', 'Podfile', 'BUILD', 'WORKSPACE', 'Justfile', 'Taskfile',
  'Procfile', 'Brewfile', 'Vagrantfile', 'Jenkinsfile', 'Package.swift', 'gradlew',
]);
const PATH_TOKEN = /[~./\w@-]*[\w@.-]+\.([A-Za-z0-9]{1,10})(?::\d+(?:-\d+)?)?/g;
const BASENAME_TOKEN = new RegExp(`\\b(?:${[...KNOWN_BASENAME].map((n) => n.replace('.', '\\.')).join('|')})\\b`);
const NEGATED_GITHUB = /(?:no|not|never|do not touch|without|avoid(?:ing)?|outside)[^.;,]{0,25}\.github\/?\*{0,2}/gi;

const PACKAGE_SCRIPT = /\b(?:npm|pnpm|yarn|bun|deno)\s+(?:run\s+)?([a-z][\w:-]*)/gi;
const VERIFY_SCRIPT_NAME = /test|spec|check|lint|gate|verify|typecheck|accept|build|ci/i;
const DIRECT_TEST_RUNNER = /\b(?:npx|bunx)\s+[\w@./-]+|\b(?:vitest|jest|mocha|pytest|nextest|ctest|rspec|phpunit|go test|cargo\s+(?:test|check|clippy|nextest|build)|mvn\s+\w*test\w*|gradle\w*\s+test|dotnet\s+test|swift\s+test|xcodebuild\s+test)\b/i;
const VERIFY_SCRIPT_FILE = /\b(?:bash|sh|python3?|python|node|ruby|tsx|perl|php|\.\/)\s*[\w./~-]*(?:test|check|verify|accept|lint|gate)[\w./~-]*/i;
const MAKE_TARGET = /\bmake\s+(?:-[\w=.]+\s+)*[a-z][\w-]*(?:test|check|verify|gate|lint|ci|all)\b/i;
const TEST_FILE_REF = /[\w./~-]*\.(?:test|spec)\.[a-z0-9]+\b|\b(?:test|tests|testdata)\/[\w./~-]+|[\w./~-]*test_[\w.-]+\.[a-z0-9]+\b/i;
const ACCEPTANCE_LABEL = /\baccept(?:ance)?\s*:|\btest\s+plan\b|\btests?\s*:\s|\bverif(?:y|ing|ication)\s*:/i;
const VERIFY_TOOL = /\btypecheck\b|\btsc\s+--noEmit\b|\beslint\b|\bcheck-documentation\b|\bcheck:docs\b/i;

export const restockReposRoot = (): string => join(homedir(), 'Projects', 'ashlrai');
const defaultIsDir = (path: string): boolean => {
  try { return statSync(path).isDirectory(); } catch { return false; }
};
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

type ParsedLine =
  | { kind: 'other' }
  | { kind: 'malformed'; jobId: string | null }
  | { kind: 'ready'; jobId: string; attrs: string; task: string };

function parseLine(line: string): ParsedLine {
  if (!READY_PREFIX.test(line)) return { kind: 'other' };
  const match = READY_LINE.exec(line);
  if (match) return { kind: 'ready', jobId: match[1]!, attrs: match[2]!, task: match[3]! };
  const id = /^- READY ([A-Za-z0-9][A-Za-z0-9._-]+)/.exec(line)?.[1] ?? null;
  return { kind: 'malformed', jobId: id };
}

/** Per-line status evidence: first restocker-class job id token per status line wins. */
function documentStatuses(text: string): Map<string, string> {
  const status = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = STATUS_LINE.exec(line);
    if (!match) continue;
    const id = match[2]!.slice(0, 200).split(/\s+/).find((token) => STATUS_ID.test(token));
    if (id && !status.has(id)) status.set(id, match[1]!);
  }
  return status;
}

interface DepRef { kind: 'job' | 'pr'; key: string }

function prKey(repo: string, num: string): string { return `pr:${repo}#${num}`; }

function depRef(token: string, jobId: string, repo: string | null): DepRef | null {
  if (SUFFIX_DEP.test(token)) {
    const base = JOB_SUFFIX.exec(jobId)?.[1];
    return base ? { kind: 'job', key: base + token } : null;
  }
  let match = PR_URL.exec(token) ?? PR_SHORT.exec(token);
  if (match) return { kind: 'pr', key: prKey(match[1]!, match[2]!) };
  match = PR_REPO_NUM.exec(token);
  if (match) return { kind: 'pr', key: prKey(match[1]!, match[2]!) };
  match = PR_MARKED.exec(token);
  if (match) return repo ? { kind: 'pr', key: prKey(repo, match[1]!) } : null;
  return DEP_ID.test(token) ? { kind: 'job', key: token } : null;
}

/** Canonical landed keys: job ids pass through, PR references become pr:<repo>#<n>. */
function landedKeys(landed: ReadonlySet<string>): Set<string> {
  const keys = new Set<string>();
  for (const entry of landed) {
    const token = entry.trim();
    if (!token) continue;
    let match = PR_URL.exec(token) ?? PR_SHORT.exec(token) ?? PR_REPO_NUM.exec(token);
    if (match) { keys.add(prKey(match[1]!, match[2]!)); continue; }
    match = PR_MARKED.exec(token);
    if (match) { keys.add(prKey('*', match[1]!)); continue; }
    keys.add(token);
  }
  return keys;
}

interface AttrParse { deps: DepRef[] | 'bad'; escalation: RestockEscalation | null }

function parseDepsAndEscalation(attrs: string, jobId: string, repo: string | null): AttrParse {
  let escalation: RestockEscalation | null = null;
  const esc = ESC_ATTR.exec(attrs)?.[1];
  const deps: DepRef[] = [];
  let bad = false;
  for (const clause of attrs.matchAll(DEP_CLAUSE)) {
    const body = clause[1]!;
    const timing = /^\d+/.exec(body);
    if (timing && ESCALATION_TIMING.test(body)) {
      escalation = { pool: esc ?? null, afterFailed: Number(timing[0]) };
      continue;
    }
    for (const piece of body.split(DEP_SPLIT)) {
      const token = piece.trim();
      if (!token || ['none', '-', 'n/a'].includes(token.toLowerCase())) continue;
      const ref = depRef(token, jobId, repo);
      if (ref === null) { bad = true; continue; }
      deps.push(ref);
    }
  }
  if (esc !== undefined && escalation === null) escalation = { pool: esc, afterFailed: null };
  return { deps: bad ? 'bad' : deps, escalation };
}

function hasFilePath(task: string): boolean {
  if (BASENAME_TOKEN.test(task)) return true;
  for (const match of task.matchAll(PATH_TOKEN)) {
    const token = match[0];
    if (token.includes('://')) continue;
    const before = task.slice(Math.max(0, (match.index ?? 0) - 3), match.index);
    if (/[a-z]+:\/\/?$/.test(before)) continue; // URL scheme tail, e.g. https://x
    const ext = match[1]!;
    if (token.includes('/') || KNOWN_EXT.has(ext.toLowerCase()) || /:\d+/.test(token)) return true;
  }
  return false;
}

function hasTestOrAcceptance(task: string): boolean {
  for (const match of task.matchAll(PACKAGE_SCRIPT)) {
    if (VERIFY_SCRIPT_NAME.test(match[1]!)) return true;
  }
  return DIRECT_TEST_RUNNER.test(task) || VERIFY_SCRIPT_FILE.test(task) ||
    MAKE_TARGET.test(task) || TEST_FILE_REF.test(task) ||
    ACCEPTANCE_LABEL.test(task) || VERIFY_TOOL.test(task);
}

function repoOf(attrs: string, jobId: string): string | null {
  const attr = REPO_ATTR.exec(attrs)?.[1];
  if (attr) return attr;
  return LAND_ID.exec(jobId)?.[1] ?? null;
}

/**
 * Lint one line. Lines that do not begin `- READY ` are not restock
 * candidates and return null; the document-level lint counts them as ignored.
 */
export function lintRestockLine(line: string, lineNumber: number, options: RestockLintOptions = {},
  context: { statuses?: Map<string, string>; seen?: Set<string> } = {}): { candidate: RestockCandidate } | { drop: RestockDrop } | null {
  const parsed = parseLine(line);
  if (parsed.kind === 'other') return null;
  const drop = (jobId: string | null, reasons: LintReason[]): { drop: RestockDrop } =>
    ({ drop: { line: lineNumber, jobId, reasons, sha: digest(line) } });
  if (parsed.kind === 'malformed') return drop(parsed.jobId, ['unparseable']);
  const { jobId, attrs, task } = parsed;
  const repo = repoOf(attrs, jobId);
  const { deps, escalation } = parseDepsAndEscalation(attrs, jobId, repo);
  const reasons: LintReason[] = [];
  const isDir = options.isDir ?? defaultIsDir;
  const landed = landedKeys(options.landed ?? new Set());
  const statuses = context.statuses ?? new Map();

  if (!/^[A-Z]/.test(jobId) || !JOB_ID.test(jobId)) reasons.push('bad-id');
  if (context.seen?.has(jobId)) reasons.push('dup-line');
  if (repo === null) reasons.push('no-repo');
  else if (!(FLEET_REPOS as readonly string[]).includes(repo)) reasons.push('bad-repo');
  else if (!isDir(join(options.reposRoot ?? restockReposRoot(), repo))) reasons.push('repo-folder-missing');
  if (task.replace(NEGATED_GITHUB, '').includes('.github/')) reasons.push('github-protected');
  if (!hasFilePath(task)) reasons.push('no-file-path');
  if (!hasTestOrAcceptance(task)) reasons.push('no-test-command');
  if (deps === 'bad') reasons.push('bad-dep');
  else {
    for (const dep of deps) {
      const landedDep = dep.kind === 'job'
        ? landed.has(dep.key) || LANDED_STATUSES.has(statuses.get(dep.key) ?? '')
        : landed.has(dep.key) || landed.has(prKey('*', dep.key.split('#')[1]!));
      if (!landedDep) { reasons.push('unlanded-dep'); break; }
    }
  }
  const pool = POOL_ATTR.exec(attrs)?.[1];
  if (options.pools && pool && pool !== 'any' && !options.pools.has(pool)) reasons.push('unknown-pool');
  if (reasons.length > 0) return drop(jobId, reasons);
  return {
    candidate: {
      line: lineNumber, raw: line, jobId, repo: repo as FleetRepo, attrs, task,
      deps: (deps === 'bad' ? [] : deps).map((dep) => dep.key), escalation,
    },
  };
}

/**
 * Lint a whole router-queue document. Only `- READY` lines are candidates;
 * every rejected candidate is recorded as a drop with reasons so callers can
 * log one event per drop instead of dropping silently.
 */
export function lintRestockDocument(text: string, options: RestockLintOptions = {}): RestockLintReport {
  const statuses = documentStatuses(text);
  const seen = new Set<string>();
  const report: RestockLintReport = { candidates: 0, accepted: [], drops: [] };
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    const verdict = lintRestockLine(line, index + 1, options, { statuses, seen });
    if (verdict === null) continue;
    report.candidates++;
    if ('drop' in verdict) report.drops.push(verdict.drop);
    else {
      report.accepted.push(verdict.candidate);
      seen.add(verdict.candidate.jobId);
    }
  }
  return report;
}
