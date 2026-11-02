/**
 * dispatch-events-path.ts — the canonical candidate order for the dispatch
 * event log under a runs directory.
 *
 * WHY. Two writers append to `<runs>/queue/dispatch-events.log`
 * (core/fleet/planner-run.ts, cli/fleet-planner-tick.ts) while job-stop.ts
 * and mason-inbox.ts append to `<runs>/dispatch-events.log`; readers that
 * picked only one side missed the other half of the fleet's lane state and
 * a burning lane could report `unavailable`. Pure apart from path joins.
 */
import { join } from 'node:path';

/**
 * Relative candidate paths in preference order: the queue log first, the
 * runs-root log second. Evidence for this order: the existing dual readers
 * (cli/fleet-outcomes.ts, core/fleet/planner-failover.ts) already read queue
 * first with the root file as fallback, and the live log directory could not
 * be read to prove which side the launches reach first (macOS privacy denial
 * on ~/.ashlr-runs), so the established planner-failover.ts order stands.
 * Callers pick the first readable regular file; the two logs are never merged.
 */
export const DISPATCH_EVENTS_RELATIVE = ['queue/dispatch-events.log', 'dispatch-events.log'] as const;

/** Both candidates in preference order for one runs directory. */
export function dispatchEventsCandidates(runsDir: string): readonly [string, string] {
  return [join(runsDir, ...DISPATCH_EVENTS_RELATIVE[0].split('/')), join(runsDir, DISPATCH_EVENTS_RELATIVE[1])];
}
