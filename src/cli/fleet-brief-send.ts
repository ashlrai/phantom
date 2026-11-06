import { homedir } from 'node:os';
import { join } from 'node:path';
import { applyDailyBriefPlan, DAILY_BRIEF_CHANNELS, DAILY_BRIEF_SLOTS, defaultDailyBriefSenders,
  planDailyBrief, readDailyBriefStamp,
  type DailyBriefChannel, type DailyBriefSlot, type DailyBriefPlanDeps, type DailyBriefSenders } from '../core/comms/daily-brief-send.js';

const usage = 'Usage: ashlr fleet brief-send [--json] [--apply] [--channel email|telegram]\n  [--slot morning|overnight] [--morning-at HH:MM] [--overnight-at HH:MM] [--runs-dir DIR]';

export interface FleetBriefSendDeps {
  runsDir?: string;
  now?: () => Date;
  senders?: DailyBriefSenders;
  planDeps?: Pick<DailyBriefPlanDeps, 'isConfigured' | 'composeStatus' | 'needsYou' | 'readers' | 'drafts'>;
  output?: (text: string) => void;
  error?: (text: string) => void;
}

/**
 * `ashlr fleet brief-send` — Mason's Nov 1 00:08 order: the day summary on
 * every surface he uses, without asking a chat bot. At most one message per
 * local day per channel per slot: morning (7:30 ET) and overnight (22:30 ET),
 * times set with --morning-at / --overnight-at or ASHLR_BRIEF_MORNING_AT /
 * ASHLR_BRIEF_OVERNIGHT_AT. Without --slot the latest slot already due today
 * is used. Each brief opens with at most 5 needs-you items (queue/daily-brief-last.json under the runs dir).
 * Without --apply it prints the plan and sends nothing. Config state is only
 * ever reported as 'configured' / 'not-configured' — never a token, chat id
 * or address.
 */
export async function cmdFleetBriefSend(args: string[], deps: FleetBriefSendDeps = {}): Promise<number> {
  const output = deps.output ?? console.log;
  const error = deps.error ?? console.error;
  let root = deps.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  let apply = false;
  let json = false;
  let channel: DailyBriefChannel | undefined;
  let slot: DailyBriefSlot | undefined;
  const slotTimes: Partial<Record<DailyBriefSlot, string>> = {};
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') { output(usage); return 0; }
    if (seen.has(arg)) { error(usage); return 2; }
    seen.add(arg);
    const value = args[i + 1];
    if (arg === '--apply') apply = true;
    else if (arg === '--json') json = true;
    else if (arg === '--channel' && value && !value.startsWith('--')) {
      if (value !== 'email' && value !== 'telegram') { error(usage); return 2; }
      channel = value;
      i++;
    } else if (arg === '--slot' && value && !value.startsWith('--')) {
      if (!(DAILY_BRIEF_SLOTS as readonly string[]).includes(value)) { error(usage); return 2; }
      slot = value as DailyBriefSlot;
      i++;
    } else if ((arg === '--morning-at' || arg === '--overnight-at') && value && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
      slotTimes[arg === '--morning-at' ? 'morning' : 'overnight'] = value;
      i++;
    } else if (arg === '--runs-dir' && value && !value.startsWith('--')) root = args[++i]!;
    else { error(usage); return 2; }
  }
  const channels = channel ? [channel] : [...DAILY_BRIEF_CHANNELS];
  const plan = await planDailyBrief({
    runsDir: root, now: deps.now, lastSent: readDailyBriefStamp(root), channels, slot, slotTimes, ...deps.planDeps,
  });
  const results = apply
    ? await applyDailyBriefPlan(root, plan, deps.senders ?? await defaultDailyBriefSenders(root, plan.day, plan.slot))
    : undefined;
  if (json) {
    output(JSON.stringify({ apply, slot: plan.slot, day: plan.day, entries: plan.entries, ...(results ? { results } : {}) }));
    return 0;
  }
  if (!results) {
    for (const entry of plan.entries) {
      output(entry.send ? `${entry.channel}: configured — would send\n${entry.text}` : `${entry.channel}: skipped — ${entry.reason}`);
    }
    output(`dry run: ${plan.entries.filter(entry => entry.send).length} channel(s) would send; add --apply to send`);
    return 0;
  }
  for (const result of results) {
    output(result.outcome === 'skipped'
      ? `${result.channel}: skipped — ${result.reason}`
      : `${result.channel}: ${result.outcome}`);
  }
  return 0;
}
