/**
 * Report-only line families — RQ-MR-PARK-VERIFY-PR.
 *
 * A dispatchd line rule, applied where the driver settles queue lines: a line
 * whose id belongs to the VERIFY-PR family routes to the non-publishing
 * report step, never to a worker lane and never through publish.sh.
 *
 * Verification produces no diff by design (`phm verify-pr` verifies an
 * explicitly reviewed maintainer PR through the host-owned App check; it has
 * nothing to publish). Every VERIFY-PR run therefore completed with nothing
 * to show — six runs, six empties — and each one was counted EMPTY_DONE. The
 * family is parked here: the line still resolves, but as a durable report
 * record (native REPORTED), so a verification run can never again be booked
 * as an empty publishing run.
 *
 * Line family convention: the family's token pair leads the job id after an
 * optional `RQ-` prefix, and a serial (optionally separated) may follow —
 * `RQ-VERIFY-PR985`, `RQ-VERIFY-PR-1088`, `VERIFY-PR1095` are all VERIFY-PR.
 * `RQ-VERIFY-PROD` is not (`PROD` is a different token), and neither is a
 * bare `VERIFY` kind. Lowercase or malformed ids carry no family marker and
 * keep their normal route, matching the kind convention in dispatchd.
 *
 * PURE: no clock reads, no I/O.
 */

/** The parked family: maintainer-PR verification lines. */
export const VERIFY_PR_FAMILY = 'VERIFY-PR';

const REPORT_ONLY: readonly RegExp[] = Object.freeze([
  /^(?:RQ-)?VERIFY-PR(?:[-_]?\d|$)/,
]);

/**
 * True when the line belongs to a report-only family. Such a line may settle
 * through the bridge's `report` step (READY or cleanly FINISHED), but it is
 * never a launch candidate and never a publication candidate.
 */
export function isReportOnlyLine(jobId: string): boolean {
  return REPORT_ONLY.some((re) => re.test(jobId));
}
