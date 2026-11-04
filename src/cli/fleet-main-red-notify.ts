/**
 * `ashlr fleet main-red-notify [--dry-run] [--json]` — Mason's Nov 1 orders:
 * tell him when main turns red and when it recovers; he should never have to
 * look. For each planned notice this writes one email to the operator outbox
 * (writeSignificantEmail) and, when Telegram is configured, one Telegram
 * message. The state file is saved only after every send was attempted, so a
 * failed send is counted in sent.failed and never throws out of the verb;
 * exit stays 0. --dry-run prints the notices and writes and sends nothing.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfigReadOnly } from '../core/config.js';
import {
  MAIN_RED_NOTIFY_SCHEMA, planMainRedNotices, readMainRedNotifyState, writeMainRedNotifyState,
  type MainRedNotifyState,
} from '../core/fleet/main-red-notify.js';
import { readFleetMainHealth } from '../core/fleet/main-health.js';
import { writeSignificantEmail } from '../core/fleet/operator-glance-read.js';
import { sendTelegramMessage, telegramEnabled } from '../core/integrations/telegram.js';
import type { AshlrConfig } from '../core/types.js';

const usage = 'Usage: ashlr fleet main-red-notify [--dry-run] [--json]';

/** One notice send on one channel; a throw or an {ok:false} result is a failure. */
export type MainRedNotifySender = (text: string) => Promise<unknown>;
export interface MainRedNotifySenders {
  email?: MainRedNotifySender;
  telegram?: MainRedNotifySender;
}

export interface FleetMainRedNotifyDeps {
  runsDir?: string;
  now?: () => number;
  readHealth?: typeof readFleetMainHealth;
  readState?: (runsDir: string) => MainRedNotifyState;
  saveState?: (runsDir: string, state: MainRedNotifyState) => void;
  /** Test seam: replace the senders the real config would build. */
  senders?: MainRedNotifySenders;
  loadConfig?: () => AshlrConfig;
  output?: (text: string) => void;
  error?: (text: string) => void;
}

/** Email is unconditional (the outbox decides); Telegram rides telegramEnabled. */
function defaultSenders(runsDir: string, loadCfg: () => AshlrConfig): MainRedNotifySenders {
  const senders: MainRedNotifySenders = { email: text => writeSignificantEmail(text, runsDir) };
  try {
    const cfg = loadCfg();
    if (telegramEnabled(cfg)) senders.telegram = text => sendTelegramMessage(text, undefined, cfg);
  } catch { /* no usable config: Telegram stays off */ }
  return senders;
}

async function attempt(send: MainRedNotifySender | undefined, text: string, sent: { attempted: number; ok: number; failed: number }): Promise<void> {
  if (!send) return;
  sent.attempted++;
  try {
    const result = await send(text);
    if (result && typeof result === 'object' && (result as { ok?: unknown }).ok === false) sent.failed++;
    else sent.ok++;
  } catch {
    sent.failed++;
  }
}

export async function cmdFleetMainRedNotify(args: string[], deps: FleetMainRedNotifyDeps = {}): Promise<number> {
  const output = deps.output ?? console.log;
  const error = deps.error ?? console.error;
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { output(usage); return 0; }
  let dryRun = false;
  let json = false;
  for (const arg of args) {
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--json') json = true;
    else { error(usage); return 2; }
  }
  const runsDir = deps.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const prev = (deps.readState ?? readMainRedNotifyState)(runsDir);
  const health = await (deps.readHealth ?? readFleetMainHealth)({ runsDir, now: deps.now });
  const { notices, next } = planMainRedNotices(prev, health, (deps.now ?? Date.now)());
  const sent = { attempted: 0, ok: 0, failed: 0 };
  let stateSaved = false;
  if (!dryRun) {
    const senders = deps.senders ?? defaultSenders(runsDir, deps.loadConfig ?? loadConfigReadOnly);
    for (const notice of notices) {
      await attempt(senders.email, notice.text, sent);
      await attempt(senders.telegram, notice.text, sent);
    }
    try {
      (deps.saveState ?? writeMainRedNotifyState)(runsDir, next);
      stateSaved = true;
    } catch {
      error('main-red-notify: state file could not be written; notices may repeat');
    }
  }
  if (json) {
    output(JSON.stringify({ schema: MAIN_RED_NOTIFY_SCHEMA, dryRun, notices, sent, stateSaved }));
  } else {
    for (const notice of notices) output(`${dryRun ? 'would send: ' : ''}${notice.text}`);
    if (!notices.length) output('main-red-notify: no transitions');
    else if (dryRun) output('main-red-notify: dry run — nothing sent');
  }
  return 0;
}
