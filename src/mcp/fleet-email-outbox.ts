/**
 * fleet_email_outbox — read-only metadata evidence of the local email reply
 * outbox for the isolated fleet MCP server, serving the Comms/leader agent
 * without shell access. The saved email-drop config is resolved at the
 * server-owned runs dir (never a caller-supplied directory, root or cwd) and
 * listing delegates to the same readEmailOutbox the CLI uses. Results carry
 * per-state counts plus a bounded list of artifact names, states and fixed
 * stuck reasons — never recipients, subjects, bodies, absolute paths or
 * transport errors. Missing/invalid config and missing/unreadable outbox
 * directories keep their own sourceState; a failure never reports a healthy
 * empty outbox. The tool never creates directories, sends, drafts, archives,
 * retries or alters comms configuration.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readEmailDropConfig } from '../core/comms/email-drop-config.js';
import { probeOutboxDir } from '../core/comms/email-diagnosis.js';
import { readEmailOutbox, type EmailOutboxEntry, type EmailOutboxListing } from '../core/comms/email-outbox.js';

export const MAX_FLEET_EMAIL_OUTBOX_ENTRIES = 200;
export const DEFAULT_FLEET_EMAIL_OUTBOX_ENTRIES = 50;

export interface FleetEmailOutboxArgs {
  /** Cap on returned artifact rows; counts and total always describe the full listing. */
  limit: number;
}

export type FleetEmailOutboxSourceState =
  | 'ok'
  | 'missing-config'
  | 'invalid-config'
  | 'missing-outbox'
  | 'unreadable-outbox';

export interface FleetEmailOutboxReport {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
  sourceState: FleetEmailOutboxSourceState;
  limit: number;
  /** Saved-config flags when a valid config resolved; null when it did not. */
  configEnabled: boolean | null;
  sendReplies: boolean | null;
  counts: EmailOutboxListing['counts'] | null;
  /** Artifacts in the full listing before clipping. */
  total: number | null;
  returned: number | null;
  truncated: boolean | null;
  entries: Array<Pick<EmailOutboxEntry, 'name' | 'state' | 'reason'>> | null;
}

export interface FleetEmailOutboxDeps {
  /** Email-drop config root; default ~/.ashlr-runs (test seam). */
  runsDir?: string;
  readConfig?: typeof readEmailDropConfig;
  probeDir?: typeof probeOutboxDir;
  list?: typeof readEmailOutbox;
}

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. `limit` is the
 * only accepted key — a caller-supplied dir, root, cwd or send option is an
 * argument error, rejected before any filesystem read.
 */
export function parseFleetEmailOutboxArgs(args: Record<string, unknown>): FleetEmailOutboxArgs | null {
  const limit = args['limit'] ?? DEFAULT_FLEET_EMAIL_OUTBOX_ENTRIES;
  if (Object.keys(args).some(key => key !== 'limit') || args['limit'] === null ||
    typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_FLEET_EMAIL_OUTBOX_ENTRIES) return null;
  return { limit };
}

/** Strip one listing row to name, state and the fixed stuck reason. */
function artifactRow(entry: EmailOutboxEntry): Pick<EmailOutboxEntry, 'name' | 'state' | 'reason'> {
  return entry.reason === undefined
    ? { name: entry.name, state: entry.state }
    : { name: entry.name, state: entry.state, reason: entry.reason };
}

/**
 * The listing is honest about source state: a missing or invalid saved config
 * and a missing or unreadable outbox directory report their own states with
 * null counts, never an invented healthy empty outbox. A valid config means
 * the outbox resolves exactly like the CLI — `outboxDir`, else the sibling of
 * `inboxDir`. Only read paths are touched: no mkdir, send, draft, archive or
 * retry, and comms config is never written.
 */
export async function readFleetEmailOutbox(
  input: FleetEmailOutboxArgs,
  deps: FleetEmailOutboxDeps = {},
): Promise<FleetEmailOutboxReport> {
  const readConfig = deps.readConfig ?? readEmailDropConfig;
  const list = deps.list ?? readEmailOutbox;
  const base = {
    schemaVersion: 1 as const,
    snapshotKind: 'local-persisted' as const,
    authority: 'none' as const,
    generatedAt: new Date().toISOString(),
    limit: input.limit,
  };
  const unavailable = (sourceState: FleetEmailOutboxSourceState, flags: { configEnabled: boolean | null; sendReplies: boolean | null }): FleetEmailOutboxReport =>
    ({ ...base, sourceState, ...flags, counts: null, total: null, returned: null, truncated: null, entries: null });

  let config: Awaited<ReturnType<typeof readEmailDropConfig>>;
  try {
    config = await readConfig(deps.runsDir ?? join(homedir(), '.ashlr-runs'));
  } catch {
    return unavailable('invalid-config', { configEnabled: null, sendReplies: null });
  }
  if (config.state !== 'ok' || !config.config) {
    return unavailable(config.state === 'missing' ? 'missing-config' : 'invalid-config', { configEnabled: null, sendReplies: null });
  }
  const flags = { configEnabled: config.config.enabled ?? true, sendReplies: config.config.sendReplies ?? false };
  const outboxDir = config.config.outboxDir ?? join(config.config.inboxDir, '..', 'outbox');
  let availability: ReturnType<typeof probeOutboxDir>;
  try {
    availability = (deps.probeDir ?? probeOutboxDir)(outboxDir);
  } catch {
    return unavailable('unreadable-outbox', flags);
  }
  if (availability !== 'ok') return unavailable(availability === 'missing' ? 'missing-outbox' : 'unreadable-outbox', flags);

  let listing: EmailOutboxListing;
  try {
    listing = list(outboxDir);
  } catch {
    return unavailable('unreadable-outbox', flags);
  }
  const entries = listing.entries.slice(0, input.limit).map(artifactRow);
  return {
    ...base,
    sourceState: 'ok',
    ...flags,
    counts: listing.counts,
    total: listing.entries.length,
    returned: entries.length,
    truncated: listing.entries.length > input.limit,
    entries,
  };
}
