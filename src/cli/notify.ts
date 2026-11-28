/**
 * `ashlr notify` — notification routing and opt-in delivery commands.
 *
 * Usage:
 *   ashlr notify test [--json]
 *
 * Sends a test ping to configured webhook(s) (cfg.notify.slackWebhook /
 * cfg.notify.discordWebhook). Informative no-op (exit 0) when none configured —
 * explains how to set one up. Never posts without a configured webhook.
 *
 * Exit codes:
 *   0  test ping sent (or no webhook configured — informative)
 *   1  test ping failed
 *   2  bad usage
 */

import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { makeColors, isTty } from './ui.js';
import { loadConfig } from '../core/config.js';
import { parseJsonRecord } from '../core/integrations/dep-parser.js';
import { editorDeepLink } from './open.js';
import type { AshlrConfig } from '../core/types.js';

const { bold, dim, red, green, yellow, cyan } = makeColors(isTty());

// ---------------------------------------------------------------------------
// Lazy import — integrations built by another agent; degrade gracefully
// ---------------------------------------------------------------------------

async function importNotify() {
  return import('../core/integrations/notify.js') as Promise<
    typeof import('../core/integrations/notify.js')
  >;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printNotifyHelp(): void {
  console.log('');
  console.log(bold('  ashlr notify') + dim(' — routing previews and opt-in notifications'));
  console.log('');
  console.log('  ' + bold('Subcommands:'));
  console.log('');
  console.log(`    ${cyan('test [--json]')}     Send a test ping to configured webhook(s).`);
  console.log(`    ${cyan('session [opts]')}    Notify on a Claude Code Stop/Notification hook.`);
  console.log(`    ${cyan('route <update.json> [--json]')} Plan where one update goes, by your rules; never sends.`);
  console.log(`    ${cyan('rules [--json]')}    Show which channel each update type goes to.`);
  console.log(`    ${cyan('rules set <type> <channel>')} Change one rule (channels: imessage, email, desktop).`);
  console.log(`    ${cyan('route <type> [opts]')} Preview an owner update route; never sends.`);
  console.log(`    ${dim('Types: decision, approval, digest, incident, merged, status')}`);
  console.log(`    ${dim('Route options: --text | --json (default), --dry-run (default),')}`);
  console.log(`    ${dim('  --available <imessage|email|desktop>, --unavailable <channel> (repeatable)')}`);
  console.log('');
  console.log('  ' + bold('session options:'));
  console.log('');
  console.log(`    ${dim('--event <stop|notification>   what happened (default: stop)')}`);
  console.log(`    ${dim('--cwd <path>                  project dir (default: payload cwd / cwd)')}`);
  console.log(`    ${dim('--message <text>              body for the notification event')}`);
  console.log(`    ${dim('--editor <vscode|cursor>      editor the toast click opens (default: cfg.editor)')}`);
  console.log('');
  console.log('  ' + bold('How to configure:'));
  console.log('');
  console.log(`    Add ${bold('notify')} to your ${dim('~/.ashlr/config.json')}:`);
  console.log('');
  console.log(`    ${dim('"notify": {')}`);
  console.log(`    ${dim('  "slackWebhook":   "https://hooks.slack.com/services/..."')}`);
  console.log(`    ${dim('  "discordWebhook": "https://discord.com/api/webhooks/..."')}`);
  console.log(`    ${dim('}')}`);
  console.log('');
  console.log('  ' + bold('Notes:'));
  console.log('');
  console.log(`    ${dim('• No-op (safe, informative exit 0) when no webhook is configured.')}`);
  console.log(`    ${dim('• Posts concise summaries only — no secrets, no raw tokens.')}`);
  console.log(`    ${dim('• Automatic posting only happens when a run/swarm completes and')}`);
  console.log(`    ${dim('  notify is called explicitly from that flow — never from reads.')}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// Subcommand: notify test
// ---------------------------------------------------------------------------

async function cmdNotifyTest(args: string[]): Promise<number> {
  const jsonMode = args.includes('--json');

  // Load config — degrade gracefully if unavailable
  let cfg: Awaited<ReturnType<typeof loadConfig>>;
  try {
    cfg = loadConfig();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ sent: false, detail: `config load failed: ${msg}` }, null, 2) + '\n');
    } else {
      process.stderr.write(red('error: ') + `Could not load config: ${msg}\n`);
    }
    return 1;
  }

  // M32: opt-in desktop ping (macOS) — fired alongside the webhook test.
  let desktopSent = false;
  try {
    const { desktopNotify, desktopNotifyEnabled } = await import('../core/integrations/desktop-notify.js');
    if (desktopNotifyEnabled(cfg)) {
      desktopSent = await desktopNotify('ashlr', 'notify test — desktop notifications are working', cfg);
      if (!jsonMode && desktopSent) {
        process.stdout.write('desktop notification sent ✓\n');
      }
    }
  } catch { /* desktop ping is best-effort */ }

  // No webhook configured → informative no-op
  const hasSlack   = Boolean(cfg.notify?.slackWebhook);
  const hasDiscord = Boolean(cfg.notify?.discordWebhook);

  if (!hasSlack && !hasDiscord) {
    if (jsonMode) {
      process.stdout.write(JSON.stringify({
        sent: false,
        configured: false,
        detail: 'no webhook configured',
        hint: 'Add notify.slackWebhook or notify.discordWebhook to ~/.ashlr/config.json',
      }, null, 2) + '\n');
    } else {
      console.log('');
      console.log(yellow('  No notification webhook configured.'));
      console.log('');
      console.log('  To enable notifications, add to ' + dim('~/.ashlr/config.json') + ':');
      console.log('');
      console.log(`    ${dim('"notify": {')}`);
      console.log(`    ${dim('  "slackWebhook":   "https://hooks.slack.com/services/..."')}`);
      console.log(`    ${dim('  "discordWebhook": "https://discord.com/api/webhooks/..."')}`);
      console.log(`    ${dim('}')}`);
      console.log('');
      console.log(dim('  Run `ashlr notify test` again once a webhook is configured.'));
      console.log('');
    }
    return 0;
  }

  // Load the notify module
  let mod: Awaited<ReturnType<typeof importNotify>>;
  try {
    mod = await importNotify();
  } catch {
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ sent: false, detail: 'notify module not yet available' }, null, 2) + '\n');
    } else {
      process.stderr.write(red('error: ') + 'Notify integration module not yet available.\n');
    }
    return 1;
  }

  const targets: string[] = [];
  if (hasSlack)   targets.push('Slack');
  if (hasDiscord) targets.push('Discord');

  if (!jsonMode) {
    console.log('');
    console.log(bold('  ashlr notify test'));
    console.log('');
    console.log(`  Sending test ping to: ${targets.map(t => cyan(t)).join(', ')}`);
    console.log('');
  }

  const text = `ashlr notify test — connection check from ashlr-hub (${new Date().toISOString()})`;

  let ok: boolean;
  try {
    ok = await mod.notify(text, cfg);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ sent: false, detail: msg }, null, 2) + '\n');
    } else {
      console.log(red(`  ✗ Failed: ${msg}`));
      console.log('');
    }
    return 1;
  }

  if (jsonMode) {
    process.stdout.write(JSON.stringify({ sent: ok, targets, detail: ok ? 'ping sent' : 'post failed' }, null, 2) + '\n');
    return ok ? 0 : 1;
  }

  if (ok) {
    console.log(green(`  ✓ Test ping sent to: ${targets.join(', ')}`));
  } else {
    console.log(red('  ✗ Failed to send test ping — check webhook URL and network.'));
  }
  console.log('');
  return ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Subcommand: notify session  (called by the Claude Code Stop/Notification hook)
// ---------------------------------------------------------------------------

/** Read a `--flag value` pair from args; returns undefined when absent/dangling. */
function readFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length && !args[i + 1]!.startsWith('--')) {
    return args[i + 1];
  }
  return undefined;
}

/**
 * Read a hook JSON payload from stdin. Claude Code pipes a JSON context (with
 * `cwd`, `message`, …) to hook commands.
 *
 * Reads with a BOUNDED async read that ALWAYS settles — resolving on stream
 * `end` (the normal hook case: Claude writes the JSON then closes stdin) or
 * after a short safety timeout, whichever is first. A synchronous fd-0 read was
 * tried and rejected: it BLOCKS FOREVER when stdin is an open pipe with no EOF
 * (some hook runners leave it open), which would hang the hook and stall Claude
 * after every turn. Only reads when stdin is not a TTY; interactive use returns
 * null immediately. Returns null on any error / non-object / timeout-with-no-data.
 */
function readStdinPayload(): Promise<Record<string, unknown> | null> {
  if (process.stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    let buf = '';
    let settled = false;
    const finish = (v: Record<string, unknown> | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        process.stdin.removeAllListeners('data');
        process.stdin.removeAllListeners('end');
        process.stdin.removeAllListeners('error');
        process.stdin.pause();
      } catch {
        /* ignore */
      }
      resolve(v);
    };
    // Safety net: never wait more than this for a payload that never EOFs.
    const timer = setTimeout(() => finish(parseJsonRecord(buf)), 800);
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c: string) => {
        buf += c;
        if (buf.length > 65_536) finish(parseJsonRecord(buf));
      });
      process.stdin.on('end', () => finish(parseJsonRecord(buf)));
      process.stdin.on('error', () => finish(null));
      process.stdin.resume();
    } catch {
      finish(null);
    }
  });
}

/**
 * `ashlr notify session` — raise a desktop notification (and post to any
 * configured webhook) when a Claude Code session finishes or needs input.
 *
 * Designed to be invoked from the Claude Code Stop / Notification hooks:
 *   ashlr notify session --event stop --editor vscode
 *
 * Flags (all optional):
 *   --event <stop|notification>  what happened (default: stop)
 *   --cwd <path>                 project dir (default: hook payload cwd / process.cwd())
 *   --message <text>             body override for the notification event
 *   --editor <vscode|cursor>     editor to deep-link the click to (default: cfg.editor)
 *   --json                       emit a machine-readable result
 *
 * Best-effort by contract: ALWAYS returns 0 so a notification failure never
 * fails the hook (and never blocks Claude). Desktop toast is opt-in via
 * cfg.notify.desktop; webhook post is opt-in via cfg.notify.{slack,discord}Webhook.
 */
async function cmdNotifySession(args: string[]): Promise<number> {
  const jsonMode = args.includes('--json');
  const wasPiped = !process.stdin.isTTY;

  const rawEvent = readFlag(args, '--event') ?? 'stop';
  const event = rawEvent === 'notification' ? 'notification' : 'stop';
  const cwdFlag = readFlag(args, '--cwd');
  const msgFlag = readFlag(args, '--message');
  const editorFlag = readFlag(args, '--editor');

  const payload = await readStdinPayload();
  const cwd =
    cwdFlag ||
    (typeof payload?.['cwd'] === 'string' ? (payload['cwd'] as string) : '') ||
    process.cwd();
  const message =
    msgFlag ||
    (typeof payload?.['message'] === 'string' ? (payload['message'] as string) : '');

  const project = basename(cwd) || 'Claude Code';

  const title =
    event === 'notification'
      ? `Claude needs input — ${project}`
      : `Claude finished — ${project}`;
  const body =
    event === 'notification'
      ? message || 'Waiting for your response'
      : 'Ready for your next instruction';

  // Config — degrade gracefully if it cannot be loaded.
  let cfg: AshlrConfig | null = null;
  try {
    cfg = loadConfig();
  } catch {
    cfg = null;
  }

  // Deep link the click back to the project's editor window. Prefer the
  // explicit --editor flag (the hook pins this to 'vscode' where Claude runs),
  // else fall back to the configured editor.
  let launchUri: string | undefined;
  if (cfg) {
    const editor: AshlrConfig['editor'] =
      editorFlag === 'vscode' || editorFlag === 'cursor' ? editorFlag : cfg.editor;
    try {
      launchUri = editorDeepLink(cwd, editor);
    } catch {
      launchUri = undefined;
    }
  }

  // Desktop toast (opt-in via cfg.notify.desktop).
  let desktopSent = false;
  if (cfg) {
    try {
      const { desktopNotify } = await import('../core/integrations/desktop-notify.js');
      desktopSent = await desktopNotify(title, body, cfg, {
        launchUri,
        openLabel: `Open ${project}`,
      });
    } catch {
      /* best-effort */
    }
  }

  // Webhook post (opt-in; strict no-op when no webhook configured).
  let webhookSent = false;
  if (cfg) {
    try {
      const mod = await importNotify();
      webhookSent = await mod.notify(`${title} — ${body}`, cfg);
    } catch {
      /* best-effort */
    }
  }

  if (jsonMode) {
    process.stdout.write(
      JSON.stringify({ event, project, desktopSent, webhookSent }, null, 2) + '\n',
    );
  } else if (!wasPiped) {
    // Interactive run — print a one-liner. In hook context (piped) stay silent.
    console.log(
      dim(
        `notify session: ${event} · ${project} · desktop=${desktopSent} webhook=${webhookSent}`,
      ),
    );
  }

  return 0;
}

// ---------------------------------------------------------------------------
// cmdNotify — main entry point
// ---------------------------------------------------------------------------

async function cmdNotifyRoute(args: string[]): Promise<number> {
  const { NOTIFY_ROUTES, NOTIFY_CHANNELS, planNotifyRoute } = await import('../core/comms/owner-channel.js');
  type Channel = import('../core/comms/owner-channel.js').NotifyChannel;
  type Update = import('../core/comms/owner-channel.js').NotifyUpdateType;
  const usage = 'usage: phm notify route <update.json> [--json] | <decision|approval|digest|incident|merged|status> [--text|--json] [--dry-run] [--available <channel>] [--unavailable <channel>]';
  const invalid = (why?: string): number => { process.stderr.write((why ? why + '\n' : '') + usage + '\n'); return 2; };
  const [type, ...flags] = args;
  if (!type || type.startsWith('--')) return invalid();
  const availability: Partial<Record<Channel, 'available' | 'unavailable'>> = {};
  let text = false;
  let json = false;
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === '--text') text = true;
    else if (flag === '--json') json = true;
    else if (flag === '--dry-run') continue;
    else if (flag === '--available' || flag === '--unavailable') {
      const channel = flags[++i] as Channel;
      if (!NOTIFY_CHANNELS.includes(channel) || Object.hasOwn(availability, channel)) return invalid();
      availability[channel] = flag === '--available' ? 'available' : 'unavailable';
    } else return invalid();
  }
  if (text && json) return invalid();
  if (!Object.hasOwn(NOTIFY_ROUTES, type)) {
    // An update file: classify it, apply the owner's rules, print the delivery plan. Never sends.
    let update: unknown;
    try {
      if (statSync(type).size > 64 * 1024) return invalid(`${type} is larger than 64 KB.`);
      update = JSON.parse(readFileSync(type, 'utf8'));
    } catch { return invalid(`Could not read a JSON update from ${type}.`); }
    if (update === null || typeof update !== 'object' || Array.isArray(update)) return invalid('The update must be a JSON object.');
    const { planUpdateDelivery, readNotifyRules } = await import('../core/comms/notify-rules.js');
    const { fixedOwnerConfigDir, loadOwnerThreadSettings } = await import('../core/comms/owner-channel.js');
    const plan = planUpdateDelivery(update, { rules: readNotifyRules(), settings: loadOwnerThreadSettings(fixedOwnerConfigDir()), availability });
    if (json) { process.stdout.write(JSON.stringify(plan, null, 2) + '\n'); return 0; }
    console.log(`${plan.type}${plan.status ? ` (${plan.status})` : ''} → ${plan.deliveries.map(step => `${step.channel} (${step.action}, ${step.delivery === 'now' ? 'now' : 'next digest'})`).join(', ') || 'no channel'}. Nothing sent.`);
    console.log(plan.reason);
    console.log(`Thread: ${plan.threadId}.${plan.replyFormat ? ` Reply with one word: ${plan.replyFormat}.` : ''}`);
    return 0;
  }
  const plan = planNotifyRoute(type as Update, availability);
  if (!text) process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
  else {
    const timing = plan.delivery === 'next-digest' ? 'next digest' : plan.delivery;
    console.log(`Dry run: ${plan.updateType} → ${plan.channel ?? 'no available channel'} (${timing}). Nothing sent.`);
    console.log(`Fallback: ${plan.fallbackChannel}. Availability: ${plan.availability}. Would send now: ${plan.wouldSendNow}.`);
    console.log(plan.reason);
    console.log(`Owner thread: ${plan.threadId}. Verified sender check: ${plan.verifiedSenderCheck}.`);
    if (plan.replyFormat) console.log(`Reply with one word: ${plan.replyFormat}.`);
  }
  return 0;
}

/** `phm notify rules [--json]` reads the rules; `phm notify rules set <type> <channel> [--json]` changes one. */
async function cmdNotifyRules(args: string[]): Promise<number> {
  const { isNotifyChannel, isNotifyRuleType, readNotifyRules, setNotifyRule } = await import('../core/comms/notify-rules.js');
  const json = args.includes('--json');
  const words = args.filter(arg => arg !== '--json');
  let view: ReturnType<typeof readNotifyRules>;
  if (words.length === 0) view = readNotifyRules();
  else if (words.length === 3 && words[0] === 'set' && isNotifyRuleType(words[1]) && isNotifyChannel(words[2])) view = setNotifyRule(words[1], words[2]);
  else {
    const now = readNotifyRules();
    process.stderr.write(`usage: phm notify rules [--json] | phm notify rules set <${now.rules.map(row => row.type).join('|')}> <${now.channels.map(c => c.id).join('|')}> [--json]\n`);
    return 2;
  }
  if (json) { process.stdout.write(JSON.stringify(view, null, 2) + '\n'); return 0; }
  for (const row of view.rules) console.log(`${row.label} → ${view.channels.find(c => c.id === row.channel)?.label ?? row.channel}. ${row.note}${row.isDefault ? '' : ' (your rule)'}`);
  console.log('Everything is also shown in the desktop app.');
  if (view.problem) console.log(view.problem);
  console.log(`Change one: phm notify rules set <type> <channel>   (types: ${view.rules.map(row => row.type).join(', ')})`);
  return 0;
}

/**
 * `ashlr notify test` — send a test ping to configured webhook(s).
 * Informative no-op when no webhook is configured. Returns a process exit code.
 */
export async function cmdNotify(args: string[]): Promise<number> {
  const sub = args[0];

  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    printNotifyHelp();
    return 0;
  }

  // `notify <verb> --help` prints usage and never runs the verb: `notify test`
  // posts to the configured webhooks and `notify session` raises a desktop
  // notification.
  const rest = args.slice(1);
  if (rest.includes('--help') || rest.includes('-h')) {
    printNotifyHelp();
    return 0;
  }

  if (sub === 'route') return cmdNotifyRoute(rest);
  if (sub === 'rules') return cmdNotifyRules(rest);

  if (sub === 'test') {
    const unknown = rest.find((a) => a !== '--json');
    if (unknown !== undefined) {
      process.stderr.write(red('error: ') + `unknown notify test option: ${bold(unknown)}\n`);
      process.stderr.write(dim('Run `ashlr notify help` for usage.\n'));
      return 2;
    }
    return cmdNotifyTest(rest);
  }

  if (sub === 'session') {
    return cmdNotifySession(rest);
  }

  process.stderr.write(red('error: ') + `unknown notify subcommand: ${bold(sub)}\n`);
  process.stderr.write(dim('Run `ashlr notify help` for usage.\n'));
  return 2;
}
