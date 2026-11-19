/**
 * Finished work that never became a pull request (RQ-STRANDEDN19NQ8).
 *
 * A kept worktree is stranded when its job finished with changes and the publish step ended
 * without a PR. `findStrandedWork` is pure: it sees each kept job's publish result text, its
 * finish event and the later job that recovered it, and says why it stopped and what to do next.
 * `readStrandedWork` gathers that from the fleet runs folder with the existing bounded readers.
 * `verifyAgainstMain` is the optional "still needed?" check: local, read-only git, no network.
 * Anything not on record stays null or "unknown"; nothing here writes.
 */
import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ledgerRows, readText } from './empty-cause.js';
import { parseStatusEvidence } from './wt-audit.js';

export const STRANDED_WORK_SCHEMA = 'fleet.stranded.work.v1';
export const STRANDED_DEFAULT_DAYS = 3;
export const STRANDED_MAX_DAYS = 90;
export const STRANDED_CAUSES = ['abort_after_push', 'gate_stop', 'abort_other', 'unknown'] as const;
export type StrandedCause = (typeof STRANDED_CAUSES)[number];
export type StrandedVerify = 'already_on_main' | 'still_needed' | 'unknown';

/** One kept worktree and what is on record about its job. */
export interface StrandedCandidate {
  job: string;
  /** Repository name; null when not on record. */
  repo: string | null;
  /** The publish result text (`<runs>/<job>.publish`); null when missing. */
  publish: string | null;
  /** The newest finish event; null when the ledger has none. Unrecorded fields are null. */
  finish: { at: number | null; lane: string | null; diff_files: number | null; diff_lines: number | null } | null;
  /** Fallback finish time (the publish result's file time); null when unknown. */
  publishedAt?: number | null;
  /** The later job that names this one as recovered; null when none does. */
  recoveredBy: string | null;
}

export interface StrandedItem {
  job: string;
  /** "unknown" when not on record. */
  repo: string;
  lane: string;
  /** ISO time; null when unknown. */
  finished_at: string | null;
  /** Null when the finish event is missing: unknown, not zero. */
  diff_files: number | null;
  diff_lines: number | null;
  cause: StrandedCause;
  /** The branch the publish step pushed; null when no push is on record. */
  pushed_branch: string | null;
  recovered_by: string | null;
  /** Null until `--verify` runs; then whether the pushed branch still differs from main. */
  verify: StrandedVerify | null;
  /** One plain sentence. */
  next_step: string;
}

export interface StrandedWorkReport {
  schema: typeof STRANDED_WORK_SCHEMA;
  readOnly: true;
  days: number;
  /** False when the kept worktree list could not be read; `items` is then empty, not "none". */
  known: boolean;
  verified: boolean;
  /** Kept worktrees looked at. */
  kept: number;
  items: StrandedItem[];
  /** Plain notes on what could not be read. */
  gaps: string[];
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RESULT_LINE = /^(?:RESULT\s|ABORT\b)/;
const ABORTED = /^(?:RESULT )?ABORT(?:\s|$)/;
/** Publish safety gates, by the name publish.sh prints. Checked before the push hint: a gate outranks a pushed branch. */
const GATES: ReadonlyArray<readonly [RegExp, string]> = [
  [/secret-shape/, 'secret-shape'], [/git-unsafe/, 'git-unsafe'], [/\bg1-/, 'g1'],
  [/fork-target-invalid/, 'fork-target'], [/dependency-directory-link/, 'dependency-link'],
];
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const escapeRe = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Pure: the branch a publish result shows as pushed, from git's pull-request hint or a ref update line. */
export function pushedBranch(job: string, publish: string): string | null {
  const branch = `codex-bridge/${job}`;
  const hint = new RegExp(`(?:pull request for '|/pull/new/|-> )${escapeRe(branch)}(?=['\\s]|$)`, 'm');
  return hint.test(publish) ? branch : null;
}

function classify(job: string, publish: string | null): { cause: StrandedCause; pushed: string | null; gate: string | null; made: boolean } {
  const result = publish?.split(/\r?\n/).filter(line => RESULT_LINE.test(line)).at(-1) ?? '';
  const pushed = publish ? pushedBranch(job, publish) : null;
  // RESULT PR became a pull request and RESULT EMPTY had nothing to publish: neither is stranded.
  if (/^RESULT (?:PR|EMPTY)(?:\s|$)/.test(result)) return { cause: 'unknown', pushed, gate: null, made: true };
  const gate = GATES.find(([pattern]) => pattern.test(result))?.[1] ?? null;
  if (gate) return { cause: 'gate_stop', pushed, gate, made: false };
  if (!ABORTED.test(result)) return { cause: 'unknown', pushed, gate: null, made: false };
  return { cause: pushed ? 'abort_after_push' : 'abort_other', pushed, gate: null, made: false };
}

/** Pure: the one-sentence next step for an item. */
export function strandedNextStep(item: Pick<StrandedItem, 'cause' | 'pushed_branch' | 'recovered_by' | 'verify'>, gate: string | null = null): string {
  if (item.recovered_by) return `Nothing to do: ${item.recovered_by} recovered this work.`;
  if (item.verify === 'already_on_main') return 'Nothing to do: this work is already on the main branch.';
  if (item.cause === 'abort_after_push') return `Recover the pushed branch ${item.pushed_branch}: run phm fleet republish for the ready-made recovery job.`;
  if (item.cause === 'gate_stop') {
    return gate === 'secret-shape' || gate === null ? 'Re-run the job with plain-word fixtures: a safety gate stopped the publish.'
      : `Re-run the job once the ${gate} safety gate is cleared.`;
  }
  if (item.cause === 'abort_other') return 'Re-run the job: the publish stopped before any branch was pushed.';
  return 'Open the publish result by hand: the cause is unknown.';
}

/**
 * Pure: the stranded items among kept worktrees, oldest finish first (unknown times last).
 * Not stranded: a PR or empty publish result, a finish with zero changed files, a job with
 * neither a finish event nor a publish result (no sign it finished), or a finish before `since`.
 */
export function findStrandedWork(candidates: readonly StrandedCandidate[], since = Number.NEGATIVE_INFINITY): StrandedItem[] {
  const items: (StrandedItem & { at: number })[] = [];
  for (const c of candidates) {
    if (!c.finish && c.publish === null) continue;
    if (c.finish?.diff_files === 0) continue;
    const { cause, pushed, gate, made } = classify(c.job, c.publish);
    if (made) continue;
    const at = c.finish?.at ?? c.publishedAt ?? null;
    if (at !== null && at < since) continue;
    const item: StrandedItem = {
      job: c.job, repo: c.repo ?? 'unknown', lane: c.finish?.lane ?? 'unknown',
      finished_at: at === null ? null : new Date(at).toISOString(),
      diff_files: c.finish?.diff_files ?? null, diff_lines: c.finish?.diff_lines ?? null,
      cause, pushed_branch: pushed, recovered_by: c.recoveredBy, verify: null, next_step: '',
    };
    item.next_step = strandedNextStep(item, gate);
    items.push({ ...item, at: at ?? Number.POSITIVE_INFINITY });
  }
  return items.sort((a, b) => a.at - b.at || a.job.localeCompare(b.job)).map(({ at: _at, ...item }) => item);
}

/** Pure: the first later job that names `job` as recovered, by id or by its queue text. */
export function recoveredBy(job: string, finishedAt: number | null, others: ReadonlyArray<{ id: string; text: string; firstSeen: number | null }>): string | null {
  const named = new RegExp(`(?<![A-Za-z0-9._-])${escapeRe(job)}(?![A-Za-z0-9_-])`);
  const inId = new RegExp(`(?:^|[-_.])${escapeRe(job)}(?:$|[-_.])`);
  const recovery = /recover|republish|recut|restor|rescue|cherry-pick|preserve/i;
  return others.find(other => other.id !== job
    && (finishedAt === null || other.firstSeen === null || other.firstSeen >= finishedAt)
    && (inId.test(other.id) || (named.test(other.text) && recovery.test(`${other.id} ${other.text}`))))?.id ?? null;
}

type Git = (dir: string, args: string[]) => Promise<{ code: number; out: string }>;

/** Read-only local git: no optional locks, no prompts, no lazy fetch from a remote. */
const git: Git = (dir, args) => new Promise(resolve => {
  execFile('git', ['--no-optional-locks', '-C', dir, ...args], {
    timeout: 20_000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_OPTIONAL_LOCKS: '0' },
  }, (error, out) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, out }));
});

/**
 * Compare the paths a branch changed with the local main branch. `already_on_main` means those
 * paths have the same content on both; `unknown` means the branch, main or a common base is
 * missing in this checkout. The local main ref is used as it is: this never fetches.
 */
export async function verifyAgainstMain(dir: string, branch: string, run: Git = git): Promise<StrandedVerify> {
  const ref = `refs/heads/${branch}`;
  if ((await run(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).code !== 0) return 'unknown';
  const head = (await run(dir, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])).out.trim();
  let main: string | null = null;
  for (const name of [head, 'refs/remotes/origin/master', 'refs/remotes/origin/main', 'refs/heads/master', 'refs/heads/main']) {
    if (name && name !== ref && (await run(dir, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`])).code === 0) { main = name; break; }
  }
  if (!main) return 'unknown';
  const base = await run(dir, ['merge-base', main, ref]);
  if (base.code !== 0 || !base.out.trim()) return 'unknown';
  const names = ['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--no-textconv'];
  const changed = await run(dir, [...names, base.out.trim(), ref]);
  // No changed paths (for example a local branch that was reset to its base) is nothing to compare, not proof the work landed.
  if (changed.code !== 0 || !changed.out) return 'unknown';
  const differs = await run(dir, [...names, main, ref]);
  if (differs.code !== 0) return 'unknown';
  const offMain = new Set(differs.out.split('\0'));
  return changed.out.split('\0').some(path => path && offMain.has(path)) ? 'still_needed' : 'already_on_main';
}

export interface ReadStrandedWorkOptions {
  days?: number;
  verify?: boolean;
  now?: number;
  /** Fleet runs folder; default `ASHLR_RUNS_DIR` or `~/.ashlr-runs`. */
  runsDir?: string;
  /** Folder holding the repo clones and `wt/<job>` worktrees; default `~/Projects/ashlrai`. */
  checkoutRoot?: string;
}

const LEDGER_MAX_BYTES = 32 * 1024 * 1024;
const PUBLISH_MAX_BYTES = 2 * 1024 * 1024;
const LINE_MAX_BYTES = 64 * 1024;
const LINE_FILES_MAX = 5000;

/** Read-only: every kept worktree whose finished work never became a PR. Never throws on missing files. */
export async function readStrandedWork(opts: ReadStrandedWorkOptions = {}): Promise<StrandedWorkReport> {
  const now = opts.now ?? Date.now(), days = opts.days ?? STRANDED_DEFAULT_DAYS;
  const root = opts.runsDir ?? (process.env.ASHLR_RUNS_DIR?.trim() || join(homedir(), '.ashlr-runs'));
  const report: StrandedWorkReport = { schema: STRANDED_WORK_SCHEMA, readOnly: true, days, known: false, verified: false, kept: 0, items: [], gaps: [] };
  const statusText = await readText(join(root, 'queue', 'status.json'), LEDGER_MAX_BYTES);
  let listed = false;
  try { listed = Array.isArray((JSON.parse(statusText ?? '') as { kept_worktrees?: unknown } | null)?.kept_worktrees); } catch { /* unreadable */ }
  if (!listed) { report.gaps.push('The kept worktree list (queue/status.json) could not be read.'); return report; }
  const kept = [...parseStatusEvidence(statusText).kept].sort();
  report.known = true; report.kept = kept.length;
  if (!kept.length) return report;

  const ledger = await readText(join(root, 'metrics', 'jobs.jsonl'), LEDGER_MAX_BYTES);
  if (ledger === null) report.gaps.push('The job metrics file could not be read, so finish times and sizes are unknown.');
  const rows = ledgerRows(ledger ?? '', now, STRANDED_MAX_DAYS * 24).rows.sort((a, b) => a.at - b.at);
  const firstSeen = new Map<string, number>();
  const finishes = new Map<string, NonNullable<StrandedCandidate['finish']>>();
  for (const { id, row, lane, at } of rows) {
    if (!firstSeen.has(id)) firstSeen.set(id, at);
    if (row.event === 'finish') finishes.set(id, { at, lane: lane === 'unknown' ? null : lane, diff_files: row.empty === true ? 0 : count(row.diff_files), diff_lines: count(row.diff_lines) });
  }
  // Queue records name each job's repo (second tab field) and carry the task text a recovery job would quote.
  const runDir = join(root, 'queue', 'run');
  const lineNames = (await readdir(runDir).catch(() => [] as string[])).filter(name => name.endsWith('.line') && SAFE_ID.test(name.slice(0, -5))).slice(0, LINE_FILES_MAX);
  const lines = new Map<string, string>();
  for (let i = 0; i < lineNames.length; i += 32) {
    await Promise.all(lineNames.slice(i, i + 32).map(async name => lines.set(name.slice(0, -5), await readText(join(runDir, name), LINE_MAX_BYTES) ?? '')));
  }
  const others = [...new Set([...firstSeen.keys(), ...lines.keys()])].sort()
    .map(id => ({ id, text: lines.get(id) ?? '', firstSeen: firstSeen.get(id) ?? null }));

  const candidates: StrandedCandidate[] = [];
  for (let i = 0; i < kept.length; i += 16) {
    candidates.push(...await Promise.all(kept.slice(i, i + 16).map(async job => {
      const path = join(root, `${job}.publish`);
      const publish = await readText(path, PUBLISH_MAX_BYTES);
      const publishedAt = publish === null ? null : await stat(path).then(info => info.mtimeMs, () => null);
      const finish = finishes.get(job) ?? null;
      const fromLine = lines.get(job)?.split('\t')[1]?.trim() ?? '';
      const fromHint = publish?.match(new RegExp(`https://github\\.com/[A-Za-z0-9-]+/([A-Za-z0-9._-]+)/pull/new/codex-bridge/${escapeRe(job)}(?=\\s|$)`, 'm'))?.[1] ?? '';
      const repo = [fromLine, fromHint].find(name => SAFE_ID.test(name)) ?? null;
      return { job, repo, publish, finish, publishedAt, recoveredBy: recoveredBy(job, finish?.at ?? publishedAt, others) };
    })));
  }
  report.items = findStrandedWork(candidates, now - days * 86_400_000);
  if (opts.verify) {
    report.verified = true;
    const checkouts = opts.checkoutRoot ?? join(homedir(), 'Projects', 'ashlrai');
    // One item at a time: each check is a few local git reads.
    for (const item of report.items) {
      if (!item.pushed_branch) continue;
      item.verify = 'unknown';
      for (const dir of [join(checkouts, 'wt', item.job), ...(item.repo === 'unknown' ? [] : [join(checkouts, item.repo)])]) {
        if (!await stat(dir).then(info => info.isDirectory(), () => false)) continue;
        item.verify = await verifyAgainstMain(dir, item.pushed_branch);
        if (item.verify !== 'unknown') break;
      }
      if (item.verify === 'already_on_main' && !item.recovered_by) item.next_step = strandedNextStep(item);
    }
    if (report.items.some(item => item.verify === 'unknown')) report.gaps.push('Some pushed branches could not be compared with the local main branch.');
  }
  return report;
}

const size = (item: StrandedItem): string => item.diff_files === null ? 'size unknown'
  : `${item.diff_files} files, ${item.diff_lines === null ? 'lines unknown' : `${item.diff_lines} lines`}`;

/** Pure: the plain-words view, one line per item with its next step under it. */
export function strandedWorkText(report: StrandedWorkReport): string[] {
  if (!report.known) return ['Finished work without a pull request: unknown, the kept worktree list could not be read.'];
  const lines = report.items.length ? [`Finished work without a pull request (last ${report.days} days): ${report.items.length}`]
    : [`No finished work without a pull request in the last ${report.days} days.`];
  for (const item of report.items) {
    const facts = [item.repo, item.lane, item.finished_at ?? 'finish time unknown', size(item), item.cause.replaceAll('_', ' ')];
    if (item.verify) facts.push(item.verify.replaceAll('_', ' '));
    lines.push(`${item.job}: ${facts.join(', ')}`, `  ${item.next_step}`);
  }
  return [...lines, ...report.gaps.map(gap => `Gap: ${gap}`)];
}
