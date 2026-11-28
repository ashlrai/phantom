/**
 * Scheduled outcome measurement — the missing third leg of the improve
 * outcome pipeline. Registration (backlog-sync.ts) and checkout-free
 * post-merge observation (observe-sync.ts) already run on the cloud
 * scheduler's hourly tick, but `phm improve measure` stayed a manual verb:
 * registered proposals with live PRs accumulated hypotheses the ledger could
 * never score, so scoreOutcomes, kindLeverage and the backlog's
 * area-leverage ranking starved for evidence — the 'unmeasured' signal in
 * proposal-outcome-backlog.ts stayed lit by construction.
 *
 * This pass picks the stalest registered proposals whose carrier PR can
 * still be measured, resolves the exact merge base and head inside the
 * fleet mirror (never an operator checkout — the autonomous lane works only
 * in mirrors), runs the declared metric at each needed commit through
 * measureAt — the same worktree, credential-free environment and standing
 * confinement the manual verb uses — and appends 'measured' events. It is
 * deliberately small: at most IMPROVE_MEASURE_MAX_PER_PASS proposals and
 * IMPROVE_MEASURE_MAX_LOOKUPS PR lookups per call, IMPROVE_MEASURE_REPEAT
 * samples per phase, so one slow `npm ci` can never flood the ledger, the
 * mirror or the host. It runs on its own scheduler job so a long measurement
 * never delays the launch pick.
 *
 * Honesty rules, same as the sibling syncs:
 *  - Total. An unreadable or broken ledger yields no writes; an unavailable
 *    checkout, a closed PR, a failed fetch or a failed measurement skips
 *    that candidate and never throws into the scheduler. An append failure
 *    stops the pass — the ledger is the evidence, a partial write is worse
 *    than none.
 *  - Idempotent. A phase is re-measured only when its recorded sha is not
 *    the commit being measured, or when its scored value is still unknown
 *    and the newest measurement is older than IMPROVE_MEASURE_RETRY_MS —
 *    a permanently broken metric costs one retry a day, not one an hour.
 *  - Unknown stays unknown. measureAt returns null with a reason on any
 *    failure; the event records exactly that and the scorecard keeps
 *    reporting 'unknown' rather than a guessed number.
 *  - Measurement is evidence, not promotion. This pass never touches
 *    evaluatePromotion or queueMerge — the promote gate stays a separate,
 *    higher-authority verb.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { credentialExecFileSync as execFileSync } from '../integrations/secrets.js';
import { mirrorPathFor } from '../fleet/mirrors.js';
import { runSafeGitSync } from '../sandbox/safe-git.js';
import { measureAt, standingMetricConfinement, type Measurement } from './measure.js';
import {
  appendLedger,
  readLedger,
  scoreOutcomes,
  type LedgerEvent,
  type LedgerRead,
  type LedgerRecord,
  type MetricSpec,
  type ProposalOutcome,
} from './outcomes.js';
import { assertOriginIs, defaultBranchOf, readPr, type PrSnapshot, type PromoteExec } from './promote.js';

/** Proposals fully measured per pass; each costs up to 2 phases x repeat measureAt runs. */
export const IMPROVE_MEASURE_MAX_PER_PASS = 2;
/** PR lookups (gh/git fact reads) per pass; bounds API and fetch churn. */
export const IMPROVE_MEASURE_MAX_LOOKUPS = 8;
/** Samples per phase per pass — the CLI measure default; disagreement scores 'unknown'. */
export const IMPROVE_MEASURE_REPEAT = 2;
/** A scored-unknown phase is retried at most this often (transient npm/runner outages). */
export const IMPROVE_MEASURE_RETRY_MS = 24 * 60 * 60 * 1000;
/** gh/git fact reads get a hard timeout so a stuck CLI cannot pin the job. */
const READ_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 120_000;
/** Same one-minute future-skew ceiling the sibling folds apply to ledger `at` stamps. */
const FUTURE_SKEW_MS = 60_000;
const SHA40 = /^[0-9a-f]{40}$/;

/** gh/git fact reads: same credential-scrubbed exec promote.ts uses, plus a timeout. */
const readExec: PromoteExec = (cmd, args, cwd) => execFileSync(cmd, args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: READ_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024,
});

interface MeasuredRec { phase: 'base' | 'head'; sha: string; value: number | null; atMs: number }
interface ProposalMeasureFold { registeredAtMs: number | null; measured: MeasuredRec[] }

/** Per-proposal fold of the two record kinds this pass orders and gates on. Records stamped past notAfterMs are corrupt or replayed evidence and never fold. */
function foldMeasurements(records: readonly LedgerRecord[], notAfterMs: number): Map<string, ProposalMeasureFold> {
  const folds = new Map<string, ProposalMeasureFold>();
  for (const r of records) {
    const atMs = Date.parse(r.at);
    if (Number.isNaN(atMs) || atMs > notAfterMs) continue;
    if (r.type !== 'registered' && r.type !== 'measured') continue;
    let f = folds.get(r.proposalId);
    if (f === undefined) { f = { registeredAtMs: null, measured: [] }; folds.set(r.proposalId, f); }
    if (r.type === 'registered') f.registeredAtMs = atMs;
    else f.measured.push({ phase: r.phase, sha: r.sha, value: r.value, atMs });
  }
  return folds;
}

export interface ImproveMeasureDeps {
  /** Outcome ledger read; defaults to readLedger. */
  ledger?: () => LedgerRead;
  /** Ledger append; defaults to appendLedger. */
  append?: (event: LedgerEvent) => unknown;
  /** Outcome scorer; defaults to scoreOutcomes. */
  outcomes?: (records: readonly LedgerRecord[]) => ProposalOutcome[];
  /** Local checkout for a proposal's repository; defaults to its fleet mirror, null when absent. */
  checkoutFor?: (repository: string) => string | null;
  /** PR facts; defaults to promote.ts readPr under the timeout exec. */
  readPr?: (repository: string, number: number, repoDir: string) => PrSnapshot;
  /** Repository default branch; defaults to promote.ts defaultBranchOf under the timeout exec. */
  defaultBranch?: (repository: string, repoDir: string) => string;
  /**
   * Exact merge base of the PR head with the current default branch, after
   * fetching both into the checkout. Defaults to fetchPrMergeBase under a
   * custody installation token (anonymous when custody is unavailable).
   */
  mergeBase?: (repoDir: string, repository: string, pr: PrSnapshot, defaultBranch: string) => Promise<string>;
  /** Custody token for the fetch; defaults to authority/custody-client githubToken, null on any failure. */
  tokenFor?: (repository: string) => Promise<string | null>;
  /** One metric measurement at one commit; defaults to measureAt under standing confinement. */
  measure?: (repoDir: string, sha: string, metric: MetricSpec) => Promise<Measurement>;
  /** Samples per phase (default IMPROVE_MEASURE_REPEAT). */
  repeat?: number;
  /** Proposals measured per pass (default IMPROVE_MEASURE_MAX_PER_PASS). */
  maxPerPass?: number;
  /** PR lookups per pass (default IMPROVE_MEASURE_MAX_LOOKUPS). */
  maxLookups?: number;
  /** Clock for staleness ordering and the retry window (default: now). */
  now?: () => Date;
}

export interface ImproveMeasureSync {
  /** False when the ledger could not be read intact; nothing was written. */
  intact: boolean;
  /** Digest-chain break reasons when intact is false. */
  reasons: string[];
  /** Proposals that got at least one measurement event appended this pass. */
  measured: number;
  /** 'measured' ledger events appended before any failure stopped the pass. */
  appended: number;
  /** Candidates that reached the PR-facts stage (gh/git reads) this pass. */
  looked: number;
  skipped: { noCheckout: number; closed: number; current: number; failed: number };
  /** Set when the pass stopped early; absent on a complete run. */
  reason?: 'source-unavailable' | 'append-failed';
}

/** The fleet mirror is the only checkout the autonomous lane may measure in. */
function defaultCheckoutFor(repository: string): string | null {
  try {
    const dir = mirrorPathFor(repository);
    return existsSync(join(dir, '.git')) ? dir : null;
  } catch {
    return null;
  }
}

/** A 1-hour single-repo installation token from the custody helper; anonymous (null) when unavailable — a private repo then fails the fetch honestly. */
async function defaultTokenFor(repository: string): Promise<string | null> {
  try {
    const { githubToken } = await import('../authority/custody-client.js');
    const minted = await githubToken(repository);
    return typeof minted?.token === 'string' && minted.token.length > 0 ? minted.token : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the PR head and the default branch into the checkout through
 * safe-git — verified .git layout, env built from nothing, https-only
 * transport, the custody token scoped to github.com via extraHeader so a
 * planted url.insteadOf cannot redirect it — then resolve the exact merge
 * base locally. Throws on any git failure; the caller counts the skip.
 */
export function fetchPrMergeBase(
  repoDir: string,
  pr: Pick<PrSnapshot, 'number' | 'headRefOid'>,
  defaultBranch: string,
  token: string | null,
  opts: { allowFileRemote?: boolean } = {},
): string {
  const target = { workTree: repoDir, gitDir: join(repoDir, '.git'), layout: 'repo' as const };
  const fetch = runSafeGitSync({
    ...target,
    args: ['fetch', '--no-tags', 'origin', `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`, `refs/pull/${pr.number}/head`],
    ...(token ? { auth: { token } } : {}),
    allowProtocols: opts.allowFileRemote ? ['file'] : [],
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (!fetch.ok) throw new Error(`git fetch failed: ${(fetch.stderr || `exit ${fetch.code}`).split('\n')[0]!.slice(0, 200)}`);
  const mb = runSafeGitSync({ ...target, args: ['merge-base', `refs/remotes/origin/${defaultBranch}`, pr.headRefOid], noOptionalLocks: true });
  if (!mb.ok) throw new Error(`git merge-base failed: ${(mb.stderr || `exit ${mb.code}`).split('\n')[0]!.slice(0, 200)}`);
  const base = mb.stdout.trim();
  if (!SHA40.test(base)) throw new Error('Could not resolve an exact merge base.');
  return base;
}

/**
 * Measure the stalest measurable registered proposals and append 'measured'
 * events — the same events `phm improve measure` writes, on a schedule. Safe
 * to run on a timer: never throws, appends nothing on a broken ledger, and a
 * second pass over unchanged evidence appends nothing.
 */
export async function syncImproveMeasurements(deps: ImproveMeasureDeps = {}): Promise<ImproveMeasureSync> {
  const out: ImproveMeasureSync = { intact: true, reasons: [], measured: 0, appended: 0, looked: 0,
    skipped: { noCheckout: 0, closed: 0, current: 0, failed: 0 } };
  const now = deps.now ?? (() => new Date());
  const nowMs = now().getTime();
  let read: LedgerRead;
  try {
    read = (deps.ledger ?? readLedger)();
  } catch {
    return { ...out, reason: 'source-unavailable' };
  }
  if (!read.intact) return { ...out, intact: false, reasons: read.reasons };
  let outcomes: ProposalOutcome[];
  let folds: Map<string, ProposalMeasureFold>;
  try {
    outcomes = (deps.outcomes ?? scoreOutcomes)(read.records);
    folds = foldMeasurements(read.records, nowMs + FUTURE_SKEW_MS);
  } catch {
    return { ...out, reason: 'source-unavailable' };
  }

  // Stalest evidence first: never-measured proposals order by registration,
  // measured ones by their newest measurement, so an actively updated PR
  // cannot starve the queue — it drops to the back after each pass.
  const candidates = outcomes
    .filter((o) => o.pr !== null && o.reverted === null)
    .map((o) => ({ outcome: o, fold: folds.get(o.proposalId) }))
    .filter((c): c is { outcome: ProposalOutcome; fold: ProposalMeasureFold } => c.fold !== undefined && c.fold.registeredAtMs !== null)
    .sort((a, b) => {
      const key = (f: ProposalMeasureFold) => f.measured.reduce((m, r) => Math.max(m, r.atMs), f.registeredAtMs ?? 0);
      return key(a.fold) - key(b.fold);
    });

  const checkoutFor = deps.checkoutFor ?? defaultCheckoutFor;
  const readPrFn = deps.readPr ?? ((repository: string, number: number, repoDir: string) => readPr(repository, number, repoDir, readExec));
  const branchFn = deps.defaultBranch ?? ((repository: string, repoDir: string) => defaultBranchOf(repository, repoDir, readExec));
  const tokenFor = deps.tokenFor ?? defaultTokenFor;
  const mergeBaseFn = deps.mergeBase ?? (async (repoDir: string, repository: string, pr: PrSnapshot, branch: string) =>
    fetchPrMergeBase(repoDir, pr, branch, await tokenFor(repository)));
  const measure = deps.measure ?? ((repoDir: string, sha: string, metric: MetricSpec) =>
    measureAt(repoDir, sha, metric, undefined, standingMetricConfinement));
  const append = deps.append ?? ((event: LedgerEvent) => appendLedger(event));
  const repeat = deps.repeat ?? IMPROVE_MEASURE_REPEAT;
  const maxPerPass = deps.maxPerPass ?? IMPROVE_MEASURE_MAX_PER_PASS;
  const maxLookups = deps.maxLookups ?? IMPROVE_MEASURE_MAX_LOOKUPS;
  const branches = new Map<string, string>();

  for (const { outcome, fold } of candidates) {
    if (out.measured >= maxPerPass || out.looked >= maxLookups) break;
    const pr = outcome.pr!;
    let repoDir: string | null;
    try {
      repoDir = checkoutFor(pr.repository);
    } catch {
      repoDir = null;
    }
    if (!repoDir) { out.skipped.noCheckout += 1; continue; }
    out.looked += 1;
    try {
      assertOriginIs(pr.repository, repoDir, readExec);
      const snap = readPrFn(pr.repository, pr.number, repoDir);
      // Only a PR that can still carry the work to a merge is worth measuring:
      // 'CLOSED' is dead evidence like a standing revert.
      if (snap.state !== 'OPEN' && snap.state !== 'MERGED') { out.skipped.closed += 1; continue; }
      if (!SHA40.test(snap.headRefOid)) { out.skipped.failed += 1; continue; }
      let branch = branches.get(pr.repository);
      if (branch === undefined) { branch = branchFn(pr.repository, repoDir); branches.set(pr.repository, branch); }
      const mergeBase = await mergeBaseFn(repoDir, pr.repository, snap, branch);
      // Per-phase plan: re-measure a phase only when its recorded sha is not
      // the commit now measured, or when it still scores unknown and the
      // newest measurement is past the retry window. An unchanged healthy
      // phase (e.g. base while only the head moved) is not re-run — npm ci
      // dominates the cost.
      const newestAt = fold.measured.reduce((m, r) => Math.max(m, r.atMs), 0);
      const stale = fold.measured.length > 0 && nowMs - newestAt >= IMPROVE_MEASURE_RETRY_MS;
      const lastFor = (phase: 'base' | 'head') => fold.measured.filter((m) => m.phase === phase).at(-1);
      const plan: Array<['base' | 'head', string]> = [];
      const baseLast = lastFor('base');
      if (!baseLast || baseLast.sha !== mergeBase || (outcome.base === null && stale)) plan.push(['base', mergeBase]);
      const headLast = lastFor('head');
      if (!headLast || headLast.sha !== snap.headRefOid || (outcome.head === null && stale)) plan.push(['head', snap.headRefOid]);
      if (plan.length === 0) { out.skipped.current += 1; continue; }
      out.measured += 1;
      for (const [phase, sha] of plan) {
        for (let i = 0; i < repeat; i++) {
          const m = await measure(repoDir, sha, outcome.metric);
          try {
            append({ type: 'measured', proposalId: outcome.proposalId, phase, sha, value: m.value, reason: m.reason });
          } catch {
            return { ...out, reason: 'append-failed' };
          }
          out.appended += 1;
          if (m.value === null) break;
        }
      }
    } catch {
      out.skipped.failed += 1;
    }
  }
  return out;
}
