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
import { loadConfigReadOnly } from '../core/config.js';
import { isPaused } from '../core/comms/pause.js';
import { killSwitchOn } from '../core/sandbox/policy.js';
import { readLeaderReplies } from '../core/fleet/mason-outbox.js';
import { readOwnerLiveStatus } from '../core/comms/owner-live-status.js';
import { sendOwnerLiveNotices } from '../core/comms/owner-live-notice.js';
import type { OwnerThreadOptions } from '../core/comms/owner-thread.js';
import { ownerThreadOptions } from './comms-owner-thread.js';

const usage = 'Usage: ashlr fleet owner-live [--apply] [--json] [--runs-dir DIR]\n       ashlr owner-live status [--json]';

export interface FleetOwnerLiveDeps {
  /** Full owner-thread options for tests; production defaults to ownerThreadOptions(). */
  options?: OwnerThreadOptions;
  output?: (text: string) => void;
  error?: (text: string) => void;
}

export async function cmdFleetOwnerLive(args: string[], deps: FleetOwnerLiveDeps = {}): Promise<number> {
  const output = deps.output ?? console.log;
  const error = deps.error ?? console.error;
  if (args[0] === 'status') return cmdOwnerLiveStatus(args.slice(1), deps);
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
  // The newest leader reply is what owner-live sends once a channel is on.
  const replies = await readLeaderReplies({ limit: 1, planLog: loadConfigReadOnly().comms?.leaderPlanLogPath }).then(r => r.replies, () => []);
  const report = await sendOwnerLiveNotices(options, { apply, replies });
  if (json) {
    output(JSON.stringify(report));
  } else {
    output(`owner-live: sent=${report.sent.length} planned=${report.planned.length} failed=${report.failed.length} skipped=${report.skipped.length}${report.halted ? ' halted' : ''}`);
    for (const row of [...report.failed, ...report.skipped]) output(`  ${row.channel}: ${row.detail ?? row.reason}`);
    if (report.reply) output(`  leader reply: ${report.reply.reason}${report.reply.sent.length ? ` (${report.reply.sent.join(', ')})` : ''}`);
  }
  return apply && report.failed.length > 0 ? 1 : 0;
}

/** `phm owner-live status [--json]`: per channel on / off / not-set-up, what decides it, and the one next step. */
export async function cmdOwnerLiveStatus(args: string[], deps: FleetOwnerLiveDeps = {}): Promise<number> {
  const output = deps.output ?? console.log;
  const error = deps.error ?? console.error;
  if (args.some(a => a === '--help' || a === '-h')) { output(usage); return 0; }
  if (args.some(a => a !== '--json') || args.length > 1) { error(usage); return 2; }
  const options = deps.options ?? ownerThreadOptions();
  const report = readOwnerLiveStatus(options.settings, { halted: options.halted === true || killSwitchOn(), paused: options.paused === true || isPaused() });
  if (args[0] === '--json') { output(JSON.stringify(report)); return 0; }
  output(report.line);
  for (const c of report.channels) {
    output(`  ${c.channel}: ${c.state} — ${c.reason}`);
    if (c.nextStep) output(`    next: ${c.nextStep}`);
  }
  return 0;
}
