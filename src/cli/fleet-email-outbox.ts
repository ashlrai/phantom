import { homedir } from 'node:os';
import { join } from 'node:path';
import { probeOutboxDir } from '../core/comms/email-diagnosis.js';
import { readEmailDropConfig } from '../core/comms/email-drop-config.js';
import { macMailTransport, readEmailOutbox, sendEmailOutbox, type EmailTransport } from '../core/comms/email-outbox.js';
import {
  MAX_FLEET_EMAIL_OUTBOX_ENTRIES, parseFleetEmailOutboxArgs, readFleetEmailOutbox,
  type FleetEmailOutboxReport, type FleetEmailOutboxSourceState,
} from '../mcp/fleet-email-outbox.js';
import { rejectUnknownOptions } from './args.js';

const USAGE = 'Usage: ashlr fleet email-outbox [--dir <dir>] [--send] [--json]\n'
  + '       ashlr fleet email-outbox --metadata-only [--limit <1-200>] [--json]';

export interface FleetEmailOutboxDeps {
  /** Email-drop config root; default ~/.ashlr-runs (test seam). */
  runsDir?: string;
  /** Send transport; default macMailTransport() (test seam — fakes never spawn). */
  transport?: EmailTransport;
}

/**
 * `ashlr fleet email-outbox` — the reply outbox `phm comms email-drop` fills.
 * The default is a read-only listing of queued / drafted / sent / stuck `*.reply.eml`
 * files; `--send` drains the queue through Mail.app, gated on the saved
 * email-drop config's `from` senders. Missing allowlist or invalid config
 * exits 2 and sends nothing. A reply body is never printed.
 *
 * `--metadata-only` is the shell twin of the `fleet_email_outbox` MCP tool: it
 * resolves only the saved config, never sends, and prints the reader's
 * metadata-only report (no recipients, subjects, bodies, paths or transport errors).
 */
export async function cmdFleetEmailOutbox(args: string[], deps: FleetEmailOutboxDeps = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`${USAGE}\nLists *.reply.eml in the email-drop outbox (queued, drafted, sent, stuck). --send delivers\nqueued replies via Mail.app when To is exactly one --from sender in the saved\nemail-drop config. A claim left by a crashed pass stays stuck, never resent.\n\n--metadata-only is read-only and privacy-preserving: it reads only the saved email-drop config\n(--dir and --send are rejected) and prints counts plus up to --limit rows (default 50, 1-200)\nof artifact name, state and fixed stuck reason. No recipients, subjects, bodies or paths.\nExit 0 when the outbox is readable (even if empty); 2 when the saved config is missing or\ninvalid; 1 when the outbox is missing or unreadable. --limit is valid only with --metadata-only.`);
    return 0;
  }
  const badUsage = (message?: string): number => {
    if (message) console.error(message);
    console.error(USAGE);
    return 2;
  };
  const bad = rejectUnknownOptions(args, { flags: ['--send', '--json', '--metadata-only'], values: ['--dir', '--limit'] });
  if (bad) return badUsage(bad.message);
  let dir: string | undefined;
  let send = false;
  let json = false;
  let metadataOnly = false;
  let limit: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) return badUsage(`duplicate option: ${arg}`);
    seen.add(arg);
    if (arg === '--dir') {
      dir = args[++i];
      if (!dir || dir.startsWith('--')) return badUsage();
    } else if (arg === '--limit') {
      limit = args[++i];
      if (!limit || limit.startsWith('--')) return badUsage(`--limit requires an integer from 1 to ${MAX_FLEET_EMAIL_OUTBOX_ENTRIES}`);
    } else if (arg === '--send') {
      send = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--metadata-only') {
      metadataOnly = true;
    } else {
      return badUsage(`unexpected argument: ${arg}`);
    }
  }

  if (metadataOnly) {
    // Rejected before any config read or transport so a metadata call cannot reach either.
    if (send || dir !== undefined) return badUsage('--metadata-only reads the saved config only; it cannot be combined with --send or --dir');
    // Numeric strings pass through as numbers; anything else reaches the parser as a string and is rejected there.
    const parsed = parseFleetEmailOutboxArgs(limit === undefined ? {} : { limit: /^\d+$/.test(limit) ? Number(limit) : limit });
    if (!parsed) return badUsage(`--limit requires an integer from 1 to ${MAX_FLEET_EMAIL_OUTBOX_ENTRIES}`);
    const report = await readFleetEmailOutbox(parsed, { runsDir: deps.runsDir ?? join(homedir(), '.ashlr-runs') });
    printMetadataReport(report, json);
    return metadataExitCode(report.sourceState);
  }
  if (limit !== undefined) return badUsage('--limit requires --metadata-only');

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
    // readEmailOutbox degrades missing dirs to zero counts, so establish the source first (never creating it).
    // Only fixed state codes are printed: no paths, raw errors, subjects or bodies.
    let sourceState: string = 'unreadable';
    let listing: ReturnType<typeof readEmailOutbox> | undefined;
    try {
      sourceState = probeOutboxDir(outboxDir);
      if (sourceState === 'ok') listing = readEmailOutbox(outboxDir);
    } catch {
      sourceState = 'unreadable';
    }
    if (!listing) {
      if (json) console.log(JSON.stringify({ error: 'email-outbox-source-unavailable', sourceState }));
      else console.error(`email-outbox: source=${sourceState} (outbox unavailable; no counts)`);
      return 1;
    }
    if (json) console.log(JSON.stringify(listing));
    else {
      console.log(`email-outbox: queued=${listing.counts.queued} drafted=${listing.counts.drafted} sent=${listing.counts.sent} stuck=${listing.counts.stuck}`);
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
      draftsRunsDir: deps.runsDir ?? join(homedir(), '.ashlr-runs'),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) console.log(JSON.stringify({ dir: outboxDir, error: message }));
    else console.error(`email-outbox: send failed: ${message}`);
    return 1;
  }
  if (json) console.log(JSON.stringify({ dir: outboxDir, ...result }));
  else console.log(`email-outbox: queued=${result.queued} sent=${result.sent} refused=${result.refused} failed=${result.failed} stuck=${result.stuck}${result.drafted ? ` drafted=${result.drafted}` : ''}`);
  return result.failed > 0 || result.stuck > 0 || result.refused > 0 ? 1 : 0;
}

/** Config problems exit 2 (like the listing); an unreadable or missing outbox exits 1. */
function metadataExitCode(state: FleetEmailOutboxSourceState): number {
  if (state === 'ok') return 0;
  return state === 'missing-config' || state === 'invalid-config' ? 2 : 1;
}

/** Prints only the reader's fields: counts, flags, row name/state/fixed reason — never paths or transport text. */
function printMetadataReport(report: FleetEmailOutboxReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report));
    return;
  }
  const flag = (value: boolean | null): string => value === null ? 'unknown' : String(value);
  if (report.sourceState !== 'ok' || !report.counts || !report.entries) {
    console.error(`email-outbox: source=${report.sourceState} enabled=${flag(report.configEnabled)} sendReplies=${flag(report.sendReplies)}`);
    return;
  }
  const { counts } = report;
  console.log(`email-outbox: source=${report.sourceState} enabled=${flag(report.configEnabled)} sendReplies=${flag(report.sendReplies)}`);
  console.log(`email-outbox: queued=${counts.queued} drafted=${counts.drafted} sent=${counts.sent} stuck=${counts.stuck} total=${report.total} returned=${report.returned} truncated=${report.truncated ? 'yes' : 'no'}`);
  for (const entry of report.entries) {
    console.log(`  ${entry.state} ${entry.name}${entry.reason ? ` (${entry.reason})` : ''}`);
  }
}
