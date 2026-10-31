/**
 * RQ-MR-GEN-SHAPE-V2 — merge-request queue generator ("queuegen"), one
 * dispatchd cycle over the open fleet PRs of the seven approved repos.
 *
 * Every emitted line is a Markdown router-queue row,
 * `- READY <ID> (<attrs>): <text>`, that carries the full fix brief:
 *   PR number · head branch · first failing required check · first error
 *   line · the file from that error (or the first changed file) · an
 *   acceptance command the worker can run locally to prove the fix.
 *
 *   FIXUP  — a required check is red: `check="…" err="…" file=…`
 *   REBASE — mergeStateStatus is DIRTY: `check=merge-tree conflicts="…"`
 *            with the conflicting paths from `git merge-tree --write-tree
 *            --name-only <baseSha> <headSha>` instead of a generic FIXUP.
 *
 * Dedupe is one line per PR per 24h (`state.emitted[<repo>#<n>]`); the same
 * key suppresses both kinds. Queue ids already present are never re-appended.
 * Lines touching a pinned surface (.github, publish.sh, dispatchd, git-safe,
 * scrub, reap) carry `[Security pin required]`; a truncated file listing is
 * unproven and pins conservatively.
 *
 * Amendments in force: no --rebase/force-push/--admin/auto-merge/check
 * skipping anywhere; hold list read from its canonical file and held PRs are
 * never touched; only the seven repos and fleet-authored PRs; any gh error
 * aborts the cycle with no retry (a local git or log-tail failure skips only
 * that PR); at most `cycleCap` new lines per cycle.
 *
 * All I/O is injected through QueuegenIo so the cycle is unit-testable; the
 * host adapter (scripts/queuegen.mjs) stays thin.
 */

export const QUEUEGEN_CYCLE_CAP = 20;
export const QUEUEGEN_PR_WINDOW_MS = 24 * 60 * 60 * 1000;
export const QUEUEGEN_FLEET_AUTHOR = 'ashlr-fleet[bot]';
export const QUEUEGEN_SECURITY_PIN = '[Security pin required]';
export const QUEUEGEN_TEXT_CAP = 560;

/** The seven approved repos; no discovery or expansion. */
export const QUEUEGEN_REPOS = [
  'ashlrai/phantom', 'ashlrai/phantom-secrets', 'ashlrai/locus',
  'ashlrai/lexicon', 'ashlrai/ashlr-md', 'ashlrai/ashlr-stack',
  'ashlrai/ashlr-plugin',
] as const;

export interface QueuegenPr {
  number: number;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  mergeState: string;
  inMergeQueue: boolean;
  author: string;
  files: string[];
  /** True when the file listing was truncated and protection is unproven. */
  filesTruncated: boolean;
}

export interface QueuegenCheck {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  /** True when branch protection requires this check context. */
  required: boolean;
}

export interface QueuegenState {
  v: 1;
  /** "<owner>/<repo>#<n>" -> {id, at} for the last line emitted for that PR. */
  emitted: Record<string, { id: string; at: number }>;
}

export interface QueuegenIo {
  /** gh read; throws on any gh error. Open PRs only. */
  listPullRequests(repo: string): QueuegenPr[];
  /** Checks on the PR head, in reported order; throws on gh error. */
  checks(repo: string, pr: QueuegenPr): QueuegenCheck[];
  /** Scrubbed log tail of one failing check ('' when unavailable); throws on gh error. */
  checkLogTail(repo: string, pr: QueuegenPr, check: QueuegenCheck): string;
  /**
   * Conflicted paths for the PR from `git merge-tree` on the local mirror,
   * or [] for a clean merge; throws when the merge cannot be computed.
   */
  conflictFiles(repo: string, pr: QueuegenPr): string[];
  /** Existing queue job ids; a malformed line must throw (fail closed). */
  readQueueIds(): Set<string>;
  appendQueueLine(line: string): void;
  /** Canonical hold list as "<short>#<n>" entries; must throw if unreadable. */
  readHoldList(): Set<string>;
  /** Raw persisted state (or undefined); normalized inside the cycle. */
  loadState(): unknown;
  saveState(state: QueuegenState): void;
  log(line: string): void;
  now(): number;
}

export interface QueuegenOptions {
  repos?: readonly string[];
  cycleCap?: number;
  windowMs?: number;
  fleetAuthors?: readonly string[];
  fixupPriority?: string;
  rebasePriority?: string;
  pool?: string;
  tier?: string;
}

export interface QueuegenSummary {
  emitted: number;
  deduped: number;
  skipped: number;
  capped: boolean;
}

const FAILING = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure', 'stale']);
const shortName = (repo: string): string => repo.split('/').pop() ?? repo;
export const isFailing = (check: QueuegenCheck): boolean =>
  check.status === 'completed' && check.conclusion !== null && FAILING.has(check.conclusion);

/** `.github` segment, publish.sh basename, or a segment containing the token. */
export function securityPinnedPath(path: string): boolean {
  return path.split('/').some((segment) => {
    const s = segment.toLowerCase();
    return s === '.github' || s === 'publish.sh' ||
      /dispatchd|git[-_]safe|scrub|reap/.test(s);
  });
}

/* First error line — the dispatchd ERRLINE contract: a narrow primary set,
 * then common failure markers as fallback; usage/rollup noise never counts. */
const PRIMARY_ERROR = /^\s*(ERROR|Error|API Error|stream error|\[[0-9T:.-]+Z?\]\s*ERROR)\b[: ]/;
const FALLBACK_ERROR = /^\s*(?:\[?(?:FAIL(?:ED|URE)?|FATAL|fatal|panic|Traceback)\b|npm ERR!|error TS\d+|AssertionError|\[ERROR\]|\bERROR\b)/;
const ERROR_NOISE = /^\s*(?:error: usage:|\d+ errors? (?:found|detected)|0 errors?\b)/i;

/** First error line in scrubbed log text, or undefined when it shows none. */
export function firstErrorLine(text: string): string | undefined {
  let fallback: string | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim() || ERROR_NOISE.test(line)) continue;
    if (PRIMARY_ERROR.test(line)) return line.trim();
    if (fallback === undefined && FALLBACK_ERROR.test(line)) fallback = line.trim();
  }
  return fallback;
}

const validPath = (path: string): boolean =>
  path.length > 0 && path.length <= 240 && !path.startsWith('/') &&
  !path.includes('..') && !/^[a-z]+:\/\//i.test(path) && !path.includes('\\');

/** Repo-relative path candidates anchored to an error report, in order. */
const ERROR_PATHS: RegExp[] = [
  // path:line or path(line,col) — tsc, eslint, vitest, jest
  /(?:^|[\s("'`:])((?:[\w@.-]+\/)*[\w@.+-]+\.[A-Za-z0-9]{1,12})[:(]\d+/,
  // vitest/jest FAIL banner
  /\bFAIL(?:ED)?\s+((?:[\w@.-]+\/)*[\w@.+-]+\.[A-Za-z0-9]{1,12})\b/,
  // python traceback
  /\bFile "((?:[\w@.-]+\/)*[\w@.+-]+\.[A-Za-z0-9]{1,12})"/,
];

/**
 * The file the first error line points at. Anchored matches only; a bare
 * path-shaped token counts when it is directory-qualified. Undefined when the
 * error names no file — the caller falls back to the first changed file.
 */
export function errorFile(line: string): string | undefined {
  for (const pattern of ERROR_PATHS) {
    const match = pattern.exec(line);
    if (match && validPath(match[1]!)) return match[1]!;
  }
  const loose = /(?:^|\s)((?:[\w@.-]+\/)+[\w@.+-]*\.[A-Za-z0-9]{1,12})\b/.exec(line);
  return loose && validPath(loose[1]!) ? loose[1]! : undefined;
}

/** The local command that proves a fix on the named file. */
export function acceptanceCommand(file: string): string {
  if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) return `npx vitest run ${file}`;
  if (/\.tsx?$/.test(file)) return 'npm run typecheck';
  if (/\.py$/.test(file)) return `python3 -m py_compile ${file}`;
  if (/\.sh$/.test(file)) return `bash -n ${file}`;
  if (/\.[cm]?js$/.test(file)) return `node --check ${file}`;
  return 'npm test';
}

/* Line grammar sanitizers: a queue line is one physical line, and unquoted
 * fields may contain no whitespace; quoted fields collapse it and swap their
 * double quotes so a crafted branch/check/error can never open a second line. */
const noWs = (value: string, max: number): string =>
  value.replace(/[^\w@.+/~-]/g, '').slice(0, max);
const quoted = (value: string, max: number): string =>
  value.replace(/["“”]/g, "'").replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trimEnd();
const singleLine = (text: string): string =>
  text.replace(/[^\x20-\x7E]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, QUEUEGEN_TEXT_CAP).trimEnd();

const hhmm = (now: number): string => {
  const stamp = new Date(now);
  return `${String(stamp.getHours()).padStart(2, '0')}:${String(stamp.getMinutes()).padStart(2, '0')}`;
};

export function fixupId(repo: string, pr: QueuegenPr): string {
  return `RQ-FIXUP-${shortName(repo)}-${pr.number}-${pr.headSha.slice(0, 7)}`;
}
export function rebaseId(repo: string, pr: QueuegenPr): string {
  return `RQ-REBASE-${shortName(repo)}-${pr.number}-${pr.headSha.slice(0, 7)}`;
}

export function fixupLine(repo: string, pr: QueuegenPr, check: QueuegenCheck, file: string, err: string, pinned: boolean, stamp: string, opts: Required<Pick<QueuegenOptions, 'fixupPriority' | 'pool' | 'tier'>>): string {
  const short = shortName(repo);
  const text = `FIXUP ${short}#${pr.number} branch=${noWs(pr.headRef, 120)} head=${noWs(pr.headSha.slice(0, 7), 12)} file=${noWs(file, 200)} check="${quoted(check.name, 120)}" acceptance="${quoted(acceptanceCommand(file), 200)}" err="${quoted(err, 180)}": fix the failing required check in the named file and push to the head branch. https://github.com/${repo}/pull/${pr.number}`;
  // The pin leads the truncated body so the 560-char cap can never cut it.
  return `- READY ${fixupId(repo, pr)} (${opts.fixupPriority}, pool=${opts.pool}, tier=${opts.tier}, repo=${short}, after none, queuegen ${stamp}): ${pinned ? `${QUEUEGEN_SECURITY_PIN} ` : ''}${singleLine(text)}`;
}

export function rebaseLine(repo: string, pr: QueuegenPr, conflicts: readonly string[], pinned: boolean, stamp: string, opts: Required<Pick<QueuegenOptions, 'rebasePriority' | 'pool' | 'tier'>>): string {
  const short = shortName(repo);
  const shown = conflicts.slice(0, 8);
  const suffix = conflicts.length > shown.length ? ` +${conflicts.length - shown.length} more` : '';
  const file = shown[0] ?? '';
  const text = `REBASE ${short}#${pr.number} branch=${noWs(pr.headRef, 120)} head=${noWs(pr.headSha.slice(0, 7), 12)} file=${noWs(file, 200)} check="merge-tree" acceptance="git merge-tree --write-tree ${noWs(pr.baseSha, 40)} ${noWs(pr.headSha, 40)}" conflicts="${quoted(shown.join(', '), 400)}${suffix}": resolve every listed conflict against the base and push to the head branch. https://github.com/${repo}/pull/${pr.number}`;
  return `- READY ${rebaseId(repo, pr)} (${opts.rebasePriority}, pool=${opts.pool}, tier=${opts.tier}, repo=${short}, after none, queuegen ${stamp}): ${pinned ? `${QUEUEGEN_SECURITY_PIN} ` : ''}${singleLine(text)}`;
}

function emptyState(): QueuegenState {
  return { v: 1, emitted: {} };
}

export function normalizeState(value: unknown): QueuegenState {
  const state = emptyState();
  const row = (value ?? {}) as Record<string, unknown>;
  for (const [key, entry] of Object.entries((row['emitted'] ?? {}) as Record<string, unknown>)) {
    const e = (entry ?? {}) as Record<string, unknown>;
    if (typeof e['id'] === 'string' && Number.isSafeInteger(e['at'])) {
      state.emitted[key] = { id: e['id'], at: e['at'] as number };
    }
  }
  return state;
}

/** Bound durable state; oldest entries are evicted first. */
function prune(state: QueuegenState, cap = 8_192): void {
  const keys = Object.keys(state.emitted);
  if (keys.length > cap) {
    keys.sort((a, b) => state.emitted[a]!.at - state.emitted[b]!.at)
      .slice(0, keys.length - cap).forEach((k) => delete state.emitted[k]);
  }
}

/**
 * One cycle. Hold-file or queue-parse failure aborts before any emission;
 * any gh error aborts the whole cycle with no retry; a conflictFiles or
 * checkLogTail failure skips only its PR. State is still saved.
 */
export function runQueuegenCycle(io: QueuegenIo, options: QueuegenOptions = {}): QueuegenSummary {
  const repos = options.repos ?? QUEUEGEN_REPOS;
  const cycleCap = options.cycleCap ?? QUEUEGEN_CYCLE_CAP;
  const windowMs = options.windowMs ?? QUEUEGEN_PR_WINDOW_MS;
  const authors = options.fleetAuthors ?? [QUEUEGEN_FLEET_AUTHOR];
  const emit = {
    fixupPriority: options.fixupPriority ?? 'P1',
    rebasePriority: options.rebasePriority ?? 'P0',
    pool: options.pool ?? 'any',
    tier: options.tier ?? 'work',
  };
  const now = io.now();
  const stamp = hhmm(now);
  const summary: QueuegenSummary = { emitted: 0, deduped: 0, skipped: 0, capped: false };
  let hold: Set<string>;
  try {
    hold = io.readHoldList();
  } catch (error) {
    io.log('QUEUEGEN_HOLD_UNAVAILABLE');
    throw error;
  }
  const state = normalizeState(io.loadState());
  let queueIds: Set<string>;
  try {
    queueIds = io.readQueueIds();
  } catch (error) {
    io.log('QUEUEGEN_QUEUE_INVALID');
    throw error;
  }
  try {
    outer:
    for (const repo of repos) {
      let prs: QueuegenPr[];
      try {
        prs = io.listPullRequests(repo).slice().sort((a, b) => a.number - b.number);
      } catch (error) {
        io.log(`QUEUEGEN_GH_ERROR list ${repo}`);
        throw error;
      }
      const short = shortName(repo);
      for (const pr of prs) {
        if (summary.emitted >= cycleCap) { summary.capped = true; break outer; }
        if (!authors.includes(pr.author) || pr.inMergeQueue ||
            hold.has(`${short}#${pr.number}`) || hold.has(`${repo}#${pr.number}`)) continue;
        if (!/^[0-9a-f]{7,40}$/i.test(pr.headSha) || !/^[0-9a-f]{7,40}$/i.test(pr.baseSha) || !pr.headRef) continue;
        const key = `${repo}#${pr.number}`;
        const last = state.emitted[key];
        if (last !== undefined && now - last.at < windowMs) {
          summary.deduped++;
          io.log(`QUEUEGEN_DEDUP ${key}`);
          continue;
        }
        const pinned = pr.filesTruncated || pr.files.some(securityPinnedPath);
        let line: string;
        let id: string;
        if (pr.mergeState === 'DIRTY') {
          id = rebaseId(repo, pr);
          if (queueIds.has(id)) { summary.deduped++; continue; }
          let conflicts: string[];
          try {
            conflicts = io.conflictFiles(repo, pr);
          } catch {
            io.log(`QUEUEGEN_GIT_ERROR ${key}`);
            summary.skipped++;
            continue;
          }
          if (conflicts.length === 0) { summary.skipped++; continue; }
          line = rebaseLine(repo, pr, conflicts, pinned, stamp, emit);
        } else {
          id = fixupId(repo, pr);
          if (queueIds.has(id)) { summary.deduped++; continue; }
          let checks: QueuegenCheck[];
          try {
            checks = io.checks(repo, pr);
          } catch (error) {
            io.log(`QUEUEGEN_GH_ERROR checks ${key}`);
            throw error;
          }
          const failing = checks.find((check) => check.required && isFailing(check));
          if (!failing) continue;
          let tail: string;
          try {
            tail = io.checkLogTail(repo, pr, failing);
          } catch {
            io.log(`QUEUEGEN_LOG_ERROR ${key} ${quoted(failing.name, 60)}`);
            summary.skipped++;
            continue;
          }
          const err = firstErrorLine(tail) ?? `${failing.name} failed (no error line captured)`;
          const file = errorFile(err) ?? pr.files[0];
          if (!file) {
            io.log(`QUEUEGEN_NOFILE ${key}`);
            summary.skipped++;
            continue;
          }
          line = fixupLine(repo, pr, failing, file, err, pinned, stamp, emit);
        }
        io.appendQueueLine(line);
        state.emitted[key] = { id, at: now };
        queueIds.add(id);
        summary.emitted++;
        io.log(`QUEUEGEN_${pr.mergeState === 'DIRTY' ? 'REBASE' : 'FIXUP'} ${id}`);
      }
    }
    io.log(`QUEUEGEN_CYCLE emitted=${summary.emitted} deduped=${summary.deduped} skipped=${summary.skipped} capped=${summary.capped ? 1 : 0}`);
    return summary;
  } finally {
    prune(state);
    io.saveState(state);
  }
}
