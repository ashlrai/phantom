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
 * new lines per cycle; lines for PRs touching .github, publish.sh, dispatchd,
 * git-safe, scrub or reap carry "Security pin required".
 *
 * All I/O is injected through RefixIo so the cycle is unit-testable and the
 * host adapter (scripts/refix-loop.mjs) stays thin.
 */

export const REFIX_CYCLE_CAP = 20;
export const REFIX_PR_WINDOW_CAP = 3;
export const REFIX_WINDOW_MS = 24 * 60 * 60 * 1000;
export const FLEET_AUTHOR = 'ashlr-fleet[bot]';
export const SECURITY_PIN = 'Security pin required';

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
}

const shortName = (repo: string): string => repo.split('/').pop() ?? repo;

/** `.github` segment, publish.sh basename, or a segment containing the token. */
export function securityPinnedPath(path: string): boolean {
  return path.split('/').some((segment) => {
    const s = segment.toLowerCase();
    return s === '.github' || s === 'publish.sh' ||
      /dispatchd|git[-_]safe|scrub|reap/.test(s);
  });
}

function emptyState(): RefixState {
  return { v: 1, appended: {}, giveup: {} };
}

export function normalizeState(value: unknown): RefixState {
  const state = emptyState();
  const row = (value ?? {}) as Record<string, unknown>;
  for (const [key, entry] of Object.entries((row['appended'] ?? {}) as Record<string, unknown>)) {
    const e = (entry ?? {}) as Record<string, unknown>;
    if (typeof e['pr'] === 'string' && Number.isSafeInteger(e['at'])) {
      state.appended[key] = { pr: e['pr'], at: e['at'] as number };
    }
  }
  for (const [key, at] of Object.entries((row['giveup'] ?? {}) as Record<string, unknown>)) {
    if (Number.isSafeInteger(at)) state.giveup[key] = at as number;
  }
  return state;
}

/** Bound durable state; oldest entries are evicted first. */
function prune(state: RefixState, cap = 8_192): void {
  const keys = Object.keys(state.appended);
  if (keys.length > cap) {
    keys.sort((a, b) => state.appended[a]!.at - state.appended[b]!.at)
      .slice(0, keys.length - cap).forEach((k) => delete state.appended[k]);
  }
  const given = Object.keys(state.giveup);
  if (given.length > cap) {
    given.sort((a, b) => state.giveup[a]! - state.giveup[b]!)
      .slice(0, given.length - cap).forEach((k) => delete state.giveup[k]);
  }
}

function drainRow(repo: string, pr: RefixPr, key: string, reason: string, pinned: boolean): string {
  const short = shortName(repo);
  const url = `https://github.com/${repo}/pull/${pr.number}`;
  const prompt = [
    ...(pinned ? [SECURITY_PIN] : []),
    `${url} (head ${pr.headSha.slice(0, 7)}): ${reason}.`,
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
  const summary: RefixSummary = { updated: 0, drains: 0, giveups: 0, capped: false };
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
  const eligible = (repo: string, pr: RefixPr): boolean =>
    !hold.has(`${shortName(repo)}#${pr.number}`) && authors.includes(pr.author);
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
      for (const pr of prs) {
        if (!eligible(repo, pr) || pr.mergeState !== 'BEHIND' || pr.inMergeQueue) continue;
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
        const key = `RQ-DRAIN-${shortName(repo)}-${pr.number}-${pr.headSha.slice(0, 7)}`;
        if (queueIds.has(key) || key in state.appended || key in state.giveup) continue;
        if (summary.drains >= cycleCap) { summary.capped = true; continue; }
        const prTag = `${shortName(repo)}#${pr.number}`;
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
        const pinned = pr.filesTruncated || pr.files.some(securityPinnedPath);
        io.appendQueueLine(drainRow(repo, pr, key,
          pr.mergeState === 'DIRTY' ? 'merge conflict (DIRTY)' : 'required check red', pinned));
        state.appended[key] = { pr: prTag, at: now };
        queueIds.add(key);
        summary.drains++;
        io.log(`REFIX_DRAIN ${key}`);
      }
    }
    io.log(`REFIX_CYCLE updated=${summary.updated} drains=${summary.drains} giveups=${summary.giveups} capped=${summary.capped ? 1 : 0}`);
    return summary;
  } finally {
    prune(state);
    io.saveState(state);
  }
}
