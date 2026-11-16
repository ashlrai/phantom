import { homedir } from 'node:os';
import { join } from 'node:path';
import { planOrderBlockedNotices } from '../core/fleet/order-blocked-notice.js';
import { readOrderTrace } from '../core/fleet/order-trace.js';
import { planOrderMergeNotices, readOrderNoticeLedger, sendOrderMergeNotices,
  type OrderMergeNoticeSenders } from '../core/fleet/order-merge-notice.js';
import { readLaneTargets, type LaneTargetsV1 } from '../core/fleet/runs-lane-targets.js';

const usage = 'Usage: ashlr fleet order-notices [--apply] [--json] [--runs-dir DIR]';
export interface FleetOrderNoticesDeps {
  runsDir?: string;
  senders?: OrderMergeNoticeSenders;
  lanes?: () => Promise<LaneTargetsV1>;
  read?: typeof readOrderTrace;
  output?: (text: string) => void;
  error?: (text: string) => void;
  now?: () => number;
}
export async function cmdFleetOrderNotices(args: string[], deps: FleetOrderNoticesDeps = {}): Promise<number> {
  const output = deps.output ?? console.log;
  const error = deps.error ?? console.error;
  let root = deps.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  let apply = false;
  let json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') { output(usage); return 0; }
    if (seen.has(arg)) { error(usage); return 2; }
    seen.add(arg);
    if (arg === '--apply') apply = true;
    else if (arg === '--json') json = true;
    else if (arg === '--runs-dir' && args[i + 1] && !args[i + 1]!.startsWith('--')) root = args[++i]!;
    else { error(usage); return 2; }
  }
  let trace;
  try {
    trace = await (deps.read ?? readOrderTrace)({ runsDir: root, now: deps.now });
    if (Object.values(trace.sources).every(state => state === 'missing')) {
      error('fleet order-notices: trace cannot be read'); return 1;
    }
  } catch { error('fleet order-notices: trace cannot be read'); return 1; }
  let sent = new Set<string>();
  try { sent = readOrderNoticeLedger(root); }
  catch { /* The locked sender reports ledger failures without sending. */ }
  // Lane holds are read once per run, like order-state: a throw or a
  // non-healthy slots.json yields no blocker evidence, never a failure.
  let lanes: LaneTargetsV1 | undefined;
  try {
    const targets = await (deps.lanes ?? (() => readLaneTargets({ runsDir: root })))();
    if (targets.sourceState === 'healthy') lanes = targets;
  } catch { /* lanes stays undefined: no blocked notices */ }
  const notices = [...planOrderMergeNotices(trace, sent), ...planOrderBlockedNotices(trace, lanes, sent)];
  const counts = apply ? await sendOrderMergeNotices(root, notices, deps.senders) : undefined;
  if (json) output(JSON.stringify({ apply, notices, ...(counts ?? {}) }));
  else if (counts) output(`sent ${counts.sent}, skipped ${counts.skipped}, failed ${counts.failed}`);
  else {
    for (const notice of notices) output(`${notice.channel}: ${notice.text}`);
    output(`dry run: ${notices.length} notices; add --apply to send`);
  }
  return 0;
}
