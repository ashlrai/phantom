/** `ashlr fleet returns-check` — second reader for RESULT receipts: each
 * VERIFIED return naming a PR is re-read from GitHub and labeled
 * merged-at-head / merged-other-head / open / closed-unmerged / unknown, so a
 * receipt stops being only the returning agent's word. Read-only: nothing is
 * written, commented, merged or dispatched, and the verdict grants no
 * authority. Exit 0 only with current receipts merged at their claimed heads;
 * 1 when coverage is truncated, return messages are unparsed, or any did not or could not be read (including an unreadable ledger);
 * 2 on bad arguments. */
import type { Gh } from '../core/autopilot/github.js';
import { readFleetBoard, type FleetBoard } from '../core/fleet/coordination.js';
import { projectCoordinationReturns } from '../core/fleet/coordination-returns-view.js';
import { checkReturnPrs, RETURN_PR_CHECK_MAX_LIMIT } from '../core/fleet/return-pr-check.js';

const usage = `Usage: ashlr fleet returns-check [--limit <1..${RETURN_PR_CHECK_MAX_LIMIT}>] [--json]
Reads VERIFIED pr receipts from the coordination ledger and asks GitHub
whether each PR merged at the claimed head. One line per checked row:
<verdict>  <repo>#<pr>  claimed <head7> observed <head7|-> (<claimId>).
Receipt lines label temporal currency at as-of; GitHub verifies only the PR.
Exit 0 when all PR receipts are current and checked rows merged-at-head; 1 otherwise; 2 on bad
arguments. Projection omissions, unparsed returns and limit-truncated checks
have incomplete coverage and cannot succeed.
Read-only; the verdict grants no authority.`;

const head7 = (head: string | null): string => head === null ? '-' : head.slice(0, 7);

export async function cmdFleetReturnsCheck(args: string[], deps: { gh?: Gh; now?: () => number } = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  let limit: number | undefined, json = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--json' && !json) { json = true; continue; }
    if (key !== '--limit' || limit !== undefined) { console.error(usage); return 2; }
    const value = args[++i];
    if (!value || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > RETURN_PR_CHECK_MAX_LIMIT) {
      console.error(usage); return 2;
    }
    limit = Number(value);
  }
  const now = deps.now ?? Date.now;
  const observedAt = now();
  // Read retained return intents at the observation clock without reaping;
  // expired ordinary messages and ownership are not part of return history.
  let board: FleetBoard | null;
  try { board = readFleetBoard({ now: observedAt, reap: false, includeExpiredReturns: true }); } catch { board = null; }
  const view = projectCoordinationReturns(board, observedAt);
  const receipts = view.returns.filter(row => row.result === 'VERIFIED' && row.evidenceKind === 'pr');
  const check = await checkReturnPrs(view.returns, { gh: deps.gh, now, limit });
  if (json) {
    console.log(JSON.stringify({ ...check, asOf: view.asOf, receipts, returnsState: view.state, unparsed: view.unparsed,
      projectionCoverage: view.coverage,
      ...(view.state === 'unknown' ? { returnsReason: view.reason } : {}) }));
  } else {
    if (view.state === 'unknown') console.log(`returns: unknown (${view.reason})`);
    const coverage = view.coverage;
    console.log(`projection coverage: parsed-total=${coverage.parsedTotal ?? 'unknown'} omitted=${coverage.omitted ?? 'unknown'} unparsed=${coverage.unparsed ?? 'unknown'}`);
    if (coverage.omitted) console.log('incomplete coverage: the returns projection omitted parsed return evidence');
    if (coverage.unparsed) console.log('incomplete coverage: return-prefixed messages could not be parsed');
    if (view.state === 'known' && check.checked.length === 0) console.log('no VERIFIED pr returns to check');
    for (const row of check.checked) {
      console.log(`${row.verdict}  ${row.repo}#${row.pr}  claimed ${head7(row.head)} observed ${head7(row.observedHead)} (${row.claimId})`);
    }
    for (const row of receipts) console.log(`receipt temporal=${row.temporal}  ${row.repo}#${row.pr} (${row.claimId})`);
    console.log(`checked=${check.checked.length} skipped=${check.skipped} truncated=${check.truncated ? 'yes' : 'no'} as-of=${view.asOf}`);
    if (view.unparsed > 0) console.log(`incomplete coverage: ${view.unparsed} unparsed return message(s)`);
    if (check.truncated) console.log('incomplete coverage: the limit prevented checking all eligible PR returns');
  }
  if (view.state === 'unknown') return 1;
  return view.coverage.omitted === 0 && view.coverage.unparsed === 0
    && !check.truncated && receipts.every(row => row.temporal === 'current')
    && check.checked.every(row => row.verdict === 'merged-at-head') ? 0 : 1;
}
