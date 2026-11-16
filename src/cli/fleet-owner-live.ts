/**
 * `ashlr fleet owner-live` — plans (or, with --apply, sends) the
 * once-per-channel "Leader is live here, reply to talk to me." notice on
 * each enabled two-way owner channel that already carries an inbound and no
 * reply yet. The only send path is sendOwnerReply; KILL, pause, the owner
 * allowlist and confirmedByMason all stay enforced there. Desktop never
 * gets a notice.
 *
 * Recovered from PR #5124 @ 5945d7b297c8f872d7bdda8312eb54e05535bd1e
 * (RQ-PHX-OWNERLIVENOTICE09) for RQ-PHX-OWNERLIVENOTICERECOVER171.
 */
import { isAbsolute } from 'node:path';
import { sendOwnerLiveNotices } from '../core/comms/owner-live-notice.js';
import type { OwnerThreadOptions } from '../core/comms/owner-thread.js';
import { ownerThreadOptions } from './comms-owner-thread.js';

const usage = 'Usage: ashlr fleet owner-live [--apply] [--json] [--runs-dir DIR]';

export interface FleetOwnerLiveDeps {
  /** Full owner-thread options for tests; production defaults to ownerThreadOptions(). */
  options?: OwnerThreadOptions;
  output?: (text: string) => void;
  error?: (text: string) => void;
}

export async function cmdFleetOwnerLive(args: string[], deps: FleetOwnerLiveDeps = {}): Promise<number> {
  const output = deps.output ?? console.log;
  const error = deps.error ?? console.error;
  let apply = false;
  let json = false;
  let runsDir: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') { output(usage); return 0; }
    if (seen.has(arg)) { error(usage); return 2; }
    seen.add(arg);
    if (arg === '--apply') apply = true;
    else if (arg === '--json') json = true;
    else if (arg === '--runs-dir') {
      const value = args[++i];
      if (typeof value !== 'string' || !isAbsolute(value)) { error(usage); return 2; }
      runsDir = value;
    } else { error(usage); return 2; }
  }
  const options = deps.options ?? { ...ownerThreadOptions(), ...(runsDir === undefined ? {} : { runsDir }) };
  const report = await sendOwnerLiveNotices(options, { apply });
  if (json) {
    output(JSON.stringify(report));
  } else {
    output(`owner-live: sent=${report.sent.length} planned=${report.planned.length} failed=${report.failed.length} skipped=${report.skipped.length}${report.halted ? ' halted' : ''}`);
    for (const row of [...report.failed, ...report.skipped]) output(`  ${row.channel}: ${row.reason}`);
  }
  return apply && report.failed.length > 0 ? 1 : 0;
}
