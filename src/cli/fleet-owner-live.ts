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
import { ensureOwnerAdaptersFile, setImessageBridge } from '../core/comms/owner-adapters-file.js';
import { fixedOwnerConfigDir } from '../core/comms/owner-channel.js';
import { sendOwnerLiveNotices } from '../core/comms/owner-live-notice.js';
import type { OwnerThreadOptions } from '../core/comms/owner-thread.js';
import { ownerThreadOptions } from './comms-owner-thread.js';
import { loadConfigAt } from '../core/config.js';
import { loopbackPairBridge, pairTick, readOwnerPairStatus, type PairDeps, type PairTickReport } from '../core/comms/owner-pair.js';

const usage = 'Usage: ashlr fleet owner-live [--apply] [--json] [--runs-dir DIR]\n       ashlr owner-live status [--json]\n       ashlr owner-live enable|disable imessage [--json]';

export interface FleetOwnerLiveDeps {
  /** Full owner-thread options for tests; production defaults to ownerThreadOptions(). */
  options?: OwnerThreadOptions;
  output?: (text: string) => void;
  error?: (text: string) => void;
  /** Config directory (the folder holding comms/owner-adapters.toml); tests pass a temp dir. */
  configDir?: string;
  /** iMessage pairing for tests (temp config dir, fake bridge). Production pairs through the real loopback bridge. */
  pair?: PairDeps;
}

export async function cmdFleetOwnerLive(args: string[], deps: FleetOwnerLiveDeps = {}): Promise<number> {
  const output = deps.output ?? console.log;
  const error = deps.error ?? console.error;
  if (args[0] === 'status') return cmdOwnerLiveStatus(args.slice(1), deps);
  if (args[0] === 'enable' || args[0] === 'disable') return cmdOwnerLiveSwitch(args, deps);
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
  // No config file yet: write the starter (iMessage on, no secrets) so no human step is needed.
  if (apply && deps.options === undefined) ensureOwnerAdaptersFile(deps.configDir ?? fixedOwnerConfigDir());
  const options = deps.options ?? { ...ownerThreadOptions(), ...(runsDir === undefined ? {} : { runsDir }) };
  // The newest leader reply is what owner-live sends once a channel is on.
  const replies = await readLeaderReplies({ limit: 1, planLog: loadConfigReadOnly().comms?.leaderPlanLogPath }).then(r => r.replies, () => []);
  // Apply mode: pair Mason's iMessage handle (one text, then wait for YES) before the hourly send looks for a binding.
  let pairing: PairTickReport | undefined;
  const held = options.halted === true || options.paused === true || killSwitchOn() || isPaused();
  if (apply && !held && options.settings.imessageBridge === 'loopback' && (deps.pair !== undefined || deps.options === undefined)) {
    const pairDeps = deps.pair ?? { configDir: fixedOwnerConfigDir(), bridge: loopbackPairBridge(loadConfigAt(fixedOwnerConfigDir())) };
    pairing = await pairTick(pairDeps).catch(() => ({ action: 'none', detail: 'pairing check failed' } as PairTickReport));
    // A fresh binding is on disk now; the hourly send in this same tick should see it.
    if (pairing.action === 'bound' && deps.options === undefined) options.settings = ownerThreadOptions().settings;
  }
  const report = await sendOwnerLiveNotices(options, { apply, replies });
  if (json) {
    output(JSON.stringify(pairing ? { ...report, pair: pairing } : report));
  } else {
    output(`owner-live: sent=${report.sent.length} planned=${report.planned.length} failed=${report.failed.length} skipped=${report.skipped.length}${report.halted ? ' halted' : ''}`);
    for (const row of [...report.failed, ...report.skipped]) output(`  ${row.channel}: ${row.detail ?? row.reason}`);
    if (pairing && pairing.action !== 'none') output(`  imessage pairing: ${pairing.detail}`);
    if (report.reply) output(`  leader reply: ${report.reply.reason}${report.reply.sent.length ? ` (${report.reply.sent.join(', ')})` : ''}`);
  }
  return apply && report.failed.length > 0 ? 1 : 0;
}

/** `phm owner-live enable|disable imessage [--json]`: flips only `[imessage] bridge` in owner-adapters.toml. */
export async function cmdOwnerLiveSwitch(args: string[], deps: FleetOwnerLiveDeps = {}): Promise<number> {
  const output = deps.output ?? console.log;
  const error = deps.error ?? console.error;
  if (args.some(a => a === '--help' || a === '-h')) { output(usage); return 0; }
  const json = args.includes('--json');
  const rest = args.slice(1).filter(a => a !== '--json');
  if (rest.length !== 1 || rest[0] !== 'imessage' || args.length - rest.length > 2) { error('Only iMessage can be switched here: the other channels need a secret handle. ' + usage); return 2; }
  const on = args[0] === 'enable';
  const result = setImessageBridge(deps.configDir ?? fixedOwnerConfigDir(), on);
  const line = `iMessage ${on ? 'on' : 'off'}${result.changed ? '' : ' (already)'}. Check: phm owner-live status`;
  output(json ? JSON.stringify({ schema: 'owner-live.switch.v1', channel: 'imessage', bridge: result.bridge, changed: result.changed }) : line);
  return 0;
}

/** `phm owner-live status [--json]`: per channel on / off / not-set-up, what decides it, and the one next step. */
export async function cmdOwnerLiveStatus(args: string[], deps: FleetOwnerLiveDeps = {}): Promise<number> {
  const output = deps.output ?? console.log;
  const error = deps.error ?? console.error;
  if (args.some(a => a === '--help' || a === '-h')) { output(usage); return 0; }
  if (args.some(a => a !== '--json') || args.length > 1) { error(usage); return 2; }
  const options = deps.options ?? ownerThreadOptions();
  // Injected test options never read the real owner home for the pairing line.
  const pairDir = deps.pair?.configDir ?? deps.configDir ?? (deps.options === undefined ? fixedOwnerConfigDir() : undefined);
  const report = readOwnerLiveStatus(options.settings, { halted: options.halted === true || killSwitchOn(), paused: options.paused === true || isPaused() },
    pairDir === undefined ? undefined : readOwnerPairStatus(pairDir));
  if (args[0] === '--json') { output(JSON.stringify(report)); return 0; }
  output(report.line);
  for (const c of report.channels) {
    output(`  ${c.channel}: ${c.state} — ${c.reason}${c.nextStep && !c.reason.includes(c.nextStep) ? ` Next: ${c.nextStep}` : ''}`);
  }
  return 0;
}
