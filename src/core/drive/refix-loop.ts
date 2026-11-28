/**
 * RQ-MR-REFIX-LOOP — one dispatchd cycle (Mac bridge, every ~15 min).
 *
 * Two passes over the open fleet-authored PRs of the seven approved repos:
 *  1. `gh pr update-branch` (default merge method) on every PR whose
 *     mergeStateStatus is BEHIND, unless it is in the merge queue or held.
 *  2. One fix-forward drain line per DIRTY or required-check-red PR, keyed
 *     RQ-DRAIN-<repo>-<pr>-<headsha7>, appended to the RQ JSONL queue.
 *
 * Amendments in force: no --rebase/force-push/--admin/auto-merge/check
 * skipping anywhere; hold list is read from its canonical file and held PRs
 * are never touched; only the seven GS_REPOS and `ashlr-fleet[bot]` authors;
 * at most 3 drain lines per PR per 24h window, then REFIX_GIVEUP is logged
 * once for that key; any gh error aborts the cycle with no retry; at most 20
 * new lines and 20 branch updates per cycle; update attempts are durably
 * reserved, spaced at least 15 minutes apart and capped at 3 per PR per 24h
 * (including failed calls). Recovery wait starts at first observation; lines for PRs touching .github, publish.sh, dispatchd,
 * git-safe, scrub or reap carry "Security pin required".
 *
 * All I/O is injected through RefixIo so the cycle is unit-testable and the
 * host adapter (scripts/refix-loop.mjs) stays thin.
 */

import { asDriveRecord, isNonNegativeSafeInt } from './pool-routing.js';

export const REFIX_CYCLE_CAP = 20;
export const REFIX_PR_WINDOW_CAP = 3;
export const REFIX_RETRY_MS = 15 * 60 * 1000;
export const REFIX_WINDOW_MS = 24 * 60 * 60 * 1000;
export const FLEET_AUTHOR = 'ashlr-fleet[bot]';
const SECURITY_PIN = 'Security pin required';

/** The seven approved GS_REPOS; no discovery or expansion. */
export const REFIX_REPOS = [
  'ashlrai/phantom', 'ashlrai/phantom-secrets', 'ashlrai/locus',
  'ashlrai/lexicon', 'ashlrai/ashlr-md', 'ashlrai/ashlr-stack',
  'ashlrai/ashlr-plugin',
] as const;

export interface RefixPr {
  number: number;
  headSha: string;
  mergeState: string;
  inMergeQueue: boolean;
  author: string;
  files: string[];
  /** True when the file listing was truncated and protection is unproven. */
  filesTruncated: boolean;
}

export interface RefixState {
  v: 1;
  /** First observed recovery wait, retained across head changes. */
  waiting?: Record<string, number>;
  /** Reserved before update-branch; failed calls consume the same retry budget. */
  updates?: Record<string, { pr: string; at: number }>;
  /** key -> {pr: "<short>#<n>", at: epochMs} for every appended drain line. */
  appended: Record<string, { pr: string; at: number }>;
  /** key -> epochMs the REFIX_GIVEUP line was logged. Permanent suppression. */
  giveup: Record<string, number>;
}

export interface RefixIo {
  /** gh read; throws on any gh error. */
  listPullRequests(repo: string): RefixPr[];
  /** `gh pr update-branch` merge method only; throws on any gh error. */
  updateBranch(repo: string, pr: number): void;
  /** `gh pr checks --required`; true when any required check is red. */
  requiredCheckRed(repo: string, pr: number): boolean;
  /** Existing queue row ids; a malformed line must throw (fail closed). */
  readQueueIds(): Set<string>;
  appendQueueLine(line: string): void;
  /** Canonical hold list as "<short>#<n>" entries; must throw if unreadable. */
  readHoldList(): Set<string>;
  /** Raw persisted state (or undefined); normalized inside the cycle. */
  loadState(): unknown;
  saveState(state: RefixState): void;
  log(line: string): void;
  now(): number;
}

export interface RefixOptions {
  repos?: readonly string[];
  cycleCap?: number;
  prWindowCap?: number;
  windowMs?: number;
  fleetAuthors?: readonly string[];
}

export interface RefixSummary {
  updated: number;
  drains: number;
  giveups: number;
  capped: boolean;
  /** Longest currently observed recovery wait (not PR age). */
  maxWaitMs: number;
}

// ---------------------------------------------------------------------------
// Shared PR-loop and durable-state helpers (reused by queuegen & merge-queue-loop)
// ---------------------------------------------------------------------------

/** Short repository name (`org/repo` -> `repo`). */
export function repoShortName(repo: string): string {
  return repo.split('/').pop() ?? repo;
}

/** Canonical short PR tag (`org/repo`, 42 -> `repo#42`). */
export function prShortTag(repo: string, prNumber: number): string {
  return `${repoShortName(repo)}#${prNumber}`;
}

/** `.github` segment, publish.sh basename, or a segment containing the token. */
export function securityPinnedPath(path: string): boolean {
  return path.split('/').some((segment) => {
    const s = segment.toLowerCase();
    return s === '.github' || s === 'publish.sh' ||
      /dispatchd|git[-_]safe|scrub|reap/.test(s);
  });
}

/** Fail closed when the file list was truncated or touches any security-pinned path. */
export function isPrSecurityPinned(pr: { files: readonly string[]; filesTruncated: boolean }): boolean {
  return pr.filesTruncated || pr.files.some(securityPinnedPath);
}

/** Tolerant read of `{ [key]: safeInt }` durable state maps. */
export function normalizeTimestampMap(raw: unknown, opts?: { nonNegative?: boolean }): Record<string, number> {
  const out: Record<string, number> = {};
  const nonNegative = opts?.nonNegative === true;
  for (const [key, at] of Object.entries(asDriveRecord(raw))) {
    if (nonNegative) {
      if (isNonNegativeSafeInt(at)) out[key] = at;
    } else if (typeof at === 'number' && Number.isSafeInteger(at)) {
      out[key] = at;
    }
  }
  return out;
}

/** Tolerant read of `{ [key]: { pr, at } }` durable state maps. */
function normalizePrTimestampMap(raw: unknown): Record<string, { pr: string; at: number }> {
  const out: Record<string, { pr: string; at: number }> = {};
  for (const [key, entry] of Object.entries(asDriveRecord(raw))) {
    const e = asDriveRecord(entry);
    if (typeof e['pr'] === 'string' && typeof e['at'] === 'number' && Number.isSafeInteger(e['at'])) {
      out[key] = { pr: e['pr'], at: e['at'] };
    }
  }
  return out;
}

/** Bound a durable state map by evicting oldest-timestamp entries first. */
export function pruneOldestEntries<T>(
  map: Record<string, T>,
  getTimestamp: (entry: T) => number,
  cap = 8_192,
): void {
  const keys = Object.keys(map);
  if (keys.length <= cap) return;
  keys.sort((a, b) => getTimestamp(map[a]!) - getTimestamp(map[b]!))
    .slice(0, keys.length - cap)
    .forEach((key) => delete map[key]);
}

/** Delete entries whose recorded timestamp is at least `windowMs` old. */
export function pruneExpiredEntries<T>(
  map: Record<string, T>,
  getTimestamp: (entry: T) => number,
  now: number,
  windowMs: number,
): void {
  for (const [key, entry] of Object.entries(map)) {
    if (now - getTimestamp(entry) >= windowMs) delete map[key];
  }
}

/** Delete map entries for `prefix` that are no longer in `present`. */
export function pruneAbsentPrefixKeys(
  map: Record<string, unknown> | undefined,
  prefix: string,
  present: ReadonlySet<string>,
): void {
  if (!map) return;
  for (const key of Object.keys(map)) {
    if (key.startsWith(prefix) && !present.has(key)) delete map[key];
  }
}

/** Rolling per-PR retry budget: bounded attempts in window and minimum cooldown between calls. */
export function prRetryBudgetAllows(
  attempts: ReadonlyArray<{ at: number }>,
  now: number,
  windowCap: number,
  retryMs: number,
): boolean {
  return attempts.length < windowCap && !attempts.some((entry) => now - entry.at < retryMs);
}

export function normalizeState(value: unknown): RefixState {
  const row = asDriveRecord(value);
  return {
    v: 1,
    appended: normalizePrTimestampMap(row['appended']),
    updates: normalizePrTimestampMap(row['updates']),
    waiting: normalizeTimestampMap(row['waiting'], { nonNegative: true }),
    giveup: normalizeTimestampMap(row['giveup']),
  };
}

/** Bound durable state; oldest entries are evicted first. */
function prune(state: RefixState, cap = 8_192): void {
  pruneOldestEntries(state.appended, (entry) => entry.at, cap);
  pruneOldestEntries(state.giveup, (at) => at, cap);
}

/** Queue id shared by every producer of a fix-forward line for one PR head. */
export function drainKey(repo: string, number: number, headSha: string): string {
  return `RQ-DRAIN-${repoShortName(repo)}-${number}-${headSha.slice(0, 7)}`;
}

export function drainRow(repo: string, pr: RefixPr, key: string, reason: string, pinned: boolean): string {
  const short = repoShortName(repo);
  const url = `https://github.com/${repo}/pull/${pr.number}`;
  const prompt = [
    ...(pinned ? [SECURITY_PIN] : []),
    `${url} (head ${pr.headSha.slice(0, 7)}): ${reason}.`,
    `For conflicts, first run phm pr resolve-conflicts --repo ${repo} --pr ${pr.number} --json; use --apply for proven append unions. Follow ready-supersede bundle plans through publish.sh; needs-agent names the files and hunks to resolve.`,
    'Check out the PR head, reproduce the failure or resolve the conflict, and push one fix-forward commit to the PR branch.',
    'Never force-push to the default branch; no --admin merge, no auto-merge, no check skipping.',
  ].join('\n');
  return JSON.stringify({
    v: 1, id: key, repo, status: 'READY', source: 'scan',
    sourceId: `refix:pr:${short}#${pr.number}`,
    title: `Fix-forward ${short}#${pr.number} (${pr.headSha.slice(0, 7)})`,
    prompt,
  }) + '\n';
}

/** One cycle. Any gh error aborts immediately; state is still saved. */
export function runRefixCycle(io: RefixIo, options: RefixOptions = {}): RefixSummary {
  const repos = options.repos ?? REFIX_REPOS;
  const cycleCap = options.cycleCap ?? REFIX_CYCLE_CAP;
  const prWindowCap = options.prWindowCap ?? REFIX_PR_WINDOW_CAP;
  const windowMs = options.windowMs ?? REFIX_WINDOW_MS;
  const authors = options.fleetAuthors ?? [FLEET_AUTHOR];
  const now = io.now();
  const summary: RefixSummary = { updated: 0, drains: 0, giveups: 0, capped: false, maxWaitMs: 0 };
  let hold: Set<string>;
  try {
    hold = io.readHoldList();
  } catch (error) {
    io.log('REFIX_HOLD_UNAVAILABLE');
    throw error;
  }
  const state = normalizeState(io.loadState());
  let queueIds: Set<string>;
  try {
    queueIds = io.readQueueIds();
  } catch (error) {
    io.log('REFIX_QUEUE_INVALID');
    throw error;
  }
  const waiting = state.waiting!;
  const updates = state.updates!;
  // Expired reservations no longer affect the rolling retry budget.
  pruneExpiredEntries(updates, (entry) => entry.at, now, windowMs);
  const eligible = (repo: string, pr: RefixPr): boolean =>
    !hold.has(prShortTag(repo, pr.number)) && authors.includes(pr.author);
  const drains24h = (prTag: string): number =>
    Object.values(state.appended).filter((e) => e.pr === prTag && now - e.at < windowMs).length;
  try {
    for (const repo of repos) {
      let prs: RefixPr[];
      try {
        prs = io.listPullRequests(repo).slice().sort((a, b) => a.number - b.number);
      } catch (error) {
        io.log(`REFIX_GH_ERROR list ${repo}`);
        throw error;
      }
      const present = new Set(prs.map((pr) => prShortTag(repo, pr.number)));
      pruneAbsentPrefixKeys(waiting, `${repoShortName(repo)}#`, present);
      const seen = new Set<string>();
      for (const pr of prs) {
        const tag = prShortTag(repo, pr.number);
        if (!eligible(repo, pr)) continue;
        if (pr.inMergeQueue || ['BEHIND', 'DIRTY'].includes(pr.mergeState)) {
          waiting[tag] ??= now;
          const waitMs = Math.max(0, now - waiting[tag]!);
          summary.maxWaitMs = Math.max(summary.maxWaitMs, waitMs);
          io.log(`REFIX_WAIT ${repo}#${pr.number} waitMs=${waitMs}`);
        } else if (pr.mergeState === 'CLEAN') delete waiting[tag];
        if (seen.has(tag)) continue;
        seen.add(tag);
        if (pr.mergeState !== 'BEHIND' || pr.inMergeQueue) continue;
        const attempts = Object.values(updates).filter((e) => e.pr === tag);
        if (!prRetryBudgetAllows(attempts, now, prWindowCap, REFIX_RETRY_MS)) continue;
        if (summary.updated >= cycleCap) { summary.capped = true; continue; }
        // Write ahead: a crash or ambiguous gh failure must not create a tight retry loop.
        updates[`${tag}:${now}`] = { pr: tag, at: now };
        io.saveState(state);
        try {
          io.updateBranch(repo, pr.number);
        } catch (error) {
          io.log(`REFIX_GH_ERROR update-branch ${repo}#${pr.number}`);
          throw error;
        }
        summary.updated++;
        io.log(`REFIX_UPDATE ${repo}#${pr.number}`);
      }
      for (const pr of prs) {
        if (!eligible(repo, pr) || pr.headSha.length < 7) continue;
        const key = drainKey(repo, pr.number, pr.headSha);
        if (queueIds.has(key) || key in state.appended || key in state.giveup) continue;
        if (summary.drains >= cycleCap) { summary.capped = true; continue; }
        const prTag = prShortTag(repo, pr.number);
        if (drains24h(prTag) >= prWindowCap) {
          state.giveup[key] = now;
          summary.giveups++;
          io.log(`REFIX_GIVEUP ${key}`);
          continue;
        }
        let drain = pr.mergeState === 'DIRTY';
        if (!drain) {
          try {
            drain = io.requiredCheckRed(repo, pr.number);
          } catch (error) {
            io.log(`REFIX_GH_ERROR checks ${repo}#${pr.number}`);
            throw error;
          }
        }
        if (!drain) continue;
        const pinned = isPrSecurityPinned(pr);
        io.appendQueueLine(drainRow(repo, pr, key,
          pr.mergeState === 'DIRTY' ? 'merge conflict (DIRTY)' : 'required check red', pinned));
        state.appended[key] = { pr: prTag, at: now };
        queueIds.add(key);
        summary.drains++;
        io.log(`REFIX_DRAIN ${key}`);
      }
    }
    io.log(`REFIX_CYCLE updated=${summary.updated} drains=${summary.drains} giveups=${summary.giveups} capped=${summary.capped ? 1 : 0} maxWaitMs=${summary.maxWaitMs}`);
    return summary;
  } finally {
    prune(state);
    io.saveState(state);
  }
}
