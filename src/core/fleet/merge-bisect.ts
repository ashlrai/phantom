/**
 * core/fleet/merge-bisect.ts: bisect planners for the merge pipeline
 * (RQ-MERGE-THROUGHPUT-2 items b and g). Pure and probe-injected: the caller
 * decides how a probe runs (fast gate in a throwaway worktree, a CI lookup);
 * this module only decides WHICH revisions or subsets to probe.
 *
 *  - bisectBatch: a merge group is probed once as a whole; only on failure is
 *    it split (group testing). Members that fail alone are culprits, the
 *    rest are cleared and may re-form a group. A set that fails together but
 *    whose halves each pass is an `interaction`: reported, never guessed.
 *  - bisectFirstBad: red-master. Given the merge window oldest to newest
 *    with a known-good lower bound, binary-search the first bad commit in
 *    ceil(log2 n) probes. `skip` probes (unbuildable commits) are stepped
 *    over, not treated as good or bad.
 *  - planRedMasterFix: turns a culprit into a normal PR action (a revert PR
 *    through the queue; never a force push, tag move or direct push).
 *    Merges are not blocked unless master does not build.
 *  - gateTimeRow / redMasterRow: JSONL rows for the metrics files, ET stamped.
 */

export type BatchProbe<T> = (members: readonly T[]) => Promise<boolean>;

export interface BatchBisectResult<T> {
  /** Members that failed when probed alone. */
  culprits: T[];
  /** Members proven good (alone or in a passing group). */
  cleared: T[];
  /** Sets that fail together though no strict subset probed fails. */
  interactions: T[][];
  probes: number;
}

/**
 * Group-test `members`. `probe(set)` resolves true when the set passes.
 * Worst case 2k*log2(n) probes for k bad members; one probe when all pass.
 */
export async function bisectBatch<T>(
  members: readonly T[],
  probe: BatchProbe<T>,
  opts: { maxProbes?: number } = {},
): Promise<BatchBisectResult<T>> {
  const maxProbes = opts.maxProbes ?? 64;
  const result: BatchBisectResult<T> = { culprits: [], cleared: [], interactions: [], probes: 0 };
  const run = async (set: readonly T[]): Promise<boolean | null> => {
    if (result.probes >= maxProbes) return null;
    result.probes++;
    return probe(set);
  };
  // `knownBad` means the caller already saw `set` fail; skip re-probing it.
  const walk = async (set: readonly T[], knownBad: boolean): Promise<void> => {
    if (set.length === 0) return;
    if (!knownBad) {
      const ok = await run(set);
      if (ok === null) { result.interactions.push([...set]); return; }
      if (ok) { result.cleared.push(...set); return; }
    }
    if (set.length === 1) { result.culprits.push(set[0]!); return; }
    const mid = Math.ceil(set.length / 2);
    const left = set.slice(0, mid);
    const right = set.slice(mid);
    const before = result.culprits.length + result.interactions.length;
    // Probing the left half first lets a passing left imply nothing about right.
    await walk(left, false);
    const leftBad = result.culprits.length + result.interactions.length > before;
    const rightOk = await run(right);
    if (rightOk === null) { result.interactions.push([...right]); return; }
    if (rightOk) result.cleared.push(...right);
    else await walk(right, true);
    if (!leftBad && rightOk) {
      // Both halves pass alone yet the set failed: an interaction, not a culprit.
      for (const m of left) result.cleared.splice(result.cleared.indexOf(m), 1);
      for (const m of right) result.cleared.splice(result.cleared.indexOf(m), 1);
      result.interactions.push([...set]);
    }
  };
  await walk(members, false);
  return result;
}

export type RevProbe = 'good' | 'bad' | 'skip';

export interface FirstBadResult {
  /** First bad commit, or null when none could be proven. */
  culprit: string | null;
  /** Why no culprit: `all-good`, `all-skipped`, `window-empty`. */
  reason: string | null;
  probes: number;
  /** Commits that could not be probed and sit next to the boundary. */
  skipped: string[];
}

/**
 * `window` is oldest to newest and excludes the known-good boundary; its
 * newest commit is the red head. Assumes the break is monotonic (once bad,
 * stays bad), which is exactly the red-master question.
 */
export async function bisectFirstBad(
  window: readonly string[],
  probe: (sha: string) => Promise<RevProbe>,
  opts: { maxProbes?: number } = {},
): Promise<FirstBadResult> {
  const out: FirstBadResult = { culprit: null, reason: null, probes: 0, skipped: [] };
  if (window.length === 0) return { ...out, reason: 'window-empty' };
  const maxProbes = opts.maxProbes ?? 40;
  let lo = 0; // first index that may be bad
  let hi = window.length - 1; // window[hi] is bad by assumption
  let hiConfirmed = false;
  while (lo < hi && out.probes < maxProbes) {
    let mid = lo + Math.floor((hi - lo) / 2);
    let verdict: RevProbe = 'skip';
    // Step over unbuildable commits, widening toward the older side then newer.
    const order: number[] = [];
    for (let d = 0; mid - d >= lo || mid + d < hi; d++) {
      if (mid - d >= lo) order.push(mid - d);
      if (d > 0 && mid + d < hi) order.push(mid + d);
    }
    for (const idx of order) {
      if (out.probes >= maxProbes) break;
      out.probes++;
      verdict = await probe(window[idx]!);
      if (verdict === 'skip') { out.skipped.push(window[idx]!); continue; }
      mid = idx;
      break;
    }
    // Everything between the boundary and a confirmed bad head is unbuildable:
    // the confirmed head is the first bad commit that can be proven.
    if (verdict === 'skip') {
      if (hiConfirmed) break;
      return { ...out, reason: 'all-skipped' };
    }
    if (verdict === 'good') lo = mid + 1;
    else { hi = mid; hiConfirmed = true; }
  }
  if (!hiConfirmed && out.probes < maxProbes) {
    out.probes++;
    const verdict = await probe(window[hi]!);
    if (verdict === 'good') return { ...out, reason: 'all-good' };
    if (verdict === 'skip') return { ...out, reason: 'all-skipped' };
  }
  return { ...out, culprit: window[hi]! };
}

// ---------------------------------------------------------------------------
// Red-master fix-forward
// ---------------------------------------------------------------------------

export interface RedMasterInput {
  /** Latest fast-gate verdict on the default branch head. */
  masterRed: boolean;
  /** True when master does not build; the only case that pauses merging. */
  buildBroken: boolean;
  culpritSha: string | null;
  culpritPr: number | null;
  /** Another open PR already reverts or fixes the culprit. */
  existingFixPr: number | null;
}

export type RedMasterAction =
  | { kind: 'none'; reason: string }
  | { kind: 'wait'; reason: string }
  | { kind: 'open-revert-pr'; culpritSha: string; culpritPr: number | null; pauseMerges: boolean }
  | { kind: 'bisect'; pauseMerges: boolean };

/** Decide the next red-master step. A revert always goes out as a normal PR. */
export function planRedMasterFix(input: RedMasterInput): RedMasterAction {
  if (!input.masterRed) return { kind: 'none', reason: 'master-green' };
  if (input.existingFixPr !== null) return { kind: 'wait', reason: `fix-pr-open:${input.existingFixPr}` };
  if (!input.culpritSha || !/^[0-9a-f]{40}$/i.test(input.culpritSha)) {
    return { kind: 'bisect', pauseMerges: input.buildBroken };
  }
  return { kind: 'open-revert-pr', culpritSha: input.culpritSha, culpritPr: input.culpritPr, pauseMerges: input.buildBroken };
}

const ET_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short',
});

/** `2026-11-16 01:36:00 EST` style stamp; no locale drift, no offset math by hand. */
export function etStamp(ms: number): string {
  const p: Record<string, string> = {};
  for (const part of ET_FORMAT.formatToParts(new Date(ms))) p[part.type] = part.value;
  return `${p['year']}-${p['month']}-${p['day']} ${p['hour']}:${p['minute']}:${p['second']} ${p['timeZoneName']}`;
}

/** One line for ~/.ashlr-runs/metrics/gate-times.jsonl. */
export function gateTimeRow(input: { atMs: number; pr: number; seconds: number }): string {
  if (!Number.isSafeInteger(input.pr) || input.pr < 0 || !Number.isFinite(input.seconds) || input.seconds < 0) {
    throw new Error('invalid gate time row');
  }
  return JSON.stringify({ et: etStamp(input.atMs), pr: input.pr, seconds: Math.round(input.seconds * 10) / 10 }) + '\n';
}

/** One line for ~/.ashlr-runs/metrics/red-master.jsonl. Unfixed events carry nulls. */
export function redMasterRow(input: {
  detectedMs: number; culpritSha: string | null; culpritPr: number | null;
  fixPr: number | null; fixedMs: number | null;
}): string {
  const minutes = input.fixedMs === null ? null : Math.max(0, Math.round(((input.fixedMs - input.detectedMs) / 60_000) * 10) / 10);
  return JSON.stringify({
    detected_et: etStamp(input.detectedMs),
    culprit_sha: input.culpritSha,
    culprit_pr: input.culpritPr,
    fix_pr: input.fixPr,
    fixed_et: input.fixedMs === null ? null : etStamp(input.fixedMs),
    minutes_to_fix: minutes,
  }) + '\n';
}
