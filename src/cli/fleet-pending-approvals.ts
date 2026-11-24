/** Read-only inventory of pending approvals: proposals, email drafts and team approvals waiting on a human. Lists requests only; approves, denies and sends nothing. */
import {
  formatPendingApprovals,
  readPendingApprovalsInventory,
  type PendingApprovalsReport,
} from '../core/fleet/pending-approvals-read.js';

const usage = 'Usage: phm fleet pending-approvals [--json]';

/** Injected at the store boundary so argument tests never read stores. */
export type PendingApprovalsReader = () => Promise<PendingApprovalsReport>;

export async function cmdFleetPendingApprovals(
  args: string[],
  read: PendingApprovalsReader = () => readPendingApprovalsInventory(),
): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nLists pending proposals, email drafts and team approvals. Read-only: nothing is approved, denied, sent or dispatched.\nExit 0 when the inventory was read; check "complete" in --json output or the Status line for truncation or degraded sources.`);
    return 0;
  }
  const json = args.length === 1 && args[0] === '--json';
  if (!json && args.length > 0) { console.error(usage); return 2; }
  let report: PendingApprovalsReport;
  try { report = await read(); } catch { console.error('error: pending approvals unavailable'); return 1; }
  console.log(json ? JSON.stringify(report) : formatPendingApprovals(report));
  return 0;
}
