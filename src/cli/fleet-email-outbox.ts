import { homedir } from 'node:os';
import { join } from 'node:path';
import { readEmailDropConfig } from '../core/comms/email-drop-config.js';
import { macMailTransport, readEmailOutbox, sendEmailOutbox, type EmailTransport } from '../core/comms/email-outbox.js';
import { rejectUnknownOptions } from './args.js';

const USAGE = 'Usage: ashlr fleet email-outbox [--dir <dir>] [--send] [--json]';

export interface FleetEmailOutboxDeps {
  /** Email-drop config root; default ~/.ashlr-runs (test seam). */
  runsDir?: string;
  /** Send transport; default macMailTransport() (test seam — fakes never spawn). */
  transport?: EmailTransport;
}

/**
 * `ashlr fleet email-outbox` — the reply outbox `phm comms email-drop` fills.
 * The default is a read-only listing of queued / sent / stuck `*.reply.eml`
 * files; `--send` drains the queue through Mail.app, gated on the saved
 * email-drop config's `from` senders. Missing allowlist or invalid config
 * exits 2 and sends nothing. A reply body is never printed.
 */
export async function cmdFleetEmailOutbox(args: string[], deps: FleetEmailOutboxDeps = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`${USAGE}\nLists *.reply.eml in the email-drop outbox (queued, sent, stuck). --send delivers\nqueued replies via Mail.app when To is exactly one --from sender in the saved\nemail-drop config. A claim left by a crashed pass stays stuck, never resent.`);
    return 0;
  }
  const badUsage = (message?: string): number => {
    if (message) console.error(message);
    console.error(USAGE);
    return 2;
  };
  const bad = rejectUnknownOptions(args, { flags: ['--send', '--json'], values: ['--dir'] });
  if (bad) return badUsage(bad.message);
  let dir: string | undefined;
  let send = false;
  let json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) return badUsage(`duplicate option: ${arg}`);
    seen.add(arg);
    if (arg === '--dir') {
      dir = args[++i];
      if (!dir || dir.startsWith('--')) return badUsage();
    } else if (arg === '--send') {
      send = true;
    } else if (arg === '--json') {
      json = true;
    } else {
      return badUsage(`unexpected argument: ${arg}`);
    }
  }

  const config = await readEmailDropConfig(deps.runsDir ?? join(homedir(), '.ashlr-runs'));
  if (config.state === 'invalid') {
    if (json) console.log(JSON.stringify({ error: `invalid email-drop config at ${config.path}` }));
    else console.error(`email-outbox: invalid email-drop config at ${config.path}`);
    return 2;
  }
  const allowed = config.config?.from ?? [];
  if (send && allowed.length === 0) {
    return badUsage('no allowlist — save `phm comms email-drop … --save-config` first; nothing was sent');
  }
  const outboxDir = dir ?? config.config?.outboxDir ??
    (config.config ? join(config.config.inboxDir, '..', 'outbox') : undefined);
  if (!outboxDir) {
    return badUsage('no outbox configured — save `phm comms email-drop … --save-config` first or pass --dir <dir>');
  }

  if (!send) {
    const listing = readEmailOutbox(outboxDir);
    if (json) console.log(JSON.stringify(listing));
    else {
      console.log(`email-outbox: queued=${listing.counts.queued} sent=${listing.counts.sent} stuck=${listing.counts.stuck}`);
      for (const entry of listing.entries) {
        console.log(`  ${entry.state} ${entry.name}${entry.to ? ` -> ${entry.to}` : ''}${entry.reason ? ` (${entry.reason})` : ''}`);
      }
    }
    return 0;
  }

  let result;
  try {
    result = await sendEmailOutbox({
      dir: outboxDir,
      allowedRecipients: new Set(allowed),
      transport: deps.transport ?? macMailTransport(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) console.log(JSON.stringify({ dir: outboxDir, error: message }));
    else console.error(`email-outbox: send failed: ${message}`);
    return 1;
  }
  if (json) console.log(JSON.stringify({ dir: outboxDir, ...result }));
  else console.log(`email-outbox: queued=${result.queued} sent=${result.sent} refused=${result.refused} failed=${result.failed} stuck=${result.stuck}`);
  return 0;
}
