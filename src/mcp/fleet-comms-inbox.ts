import { fixedOwnerRunsDir } from '../core/comms/owner-channel.js';
import { readUnifiedInbox, UNIFIED_INBOX_MAX_ITEMS, type UnifiedInbox, type UnifiedInboxOptions } from '../core/comms/unified-inbox.js';

export interface FleetCommsInboxArgs { limit: number }
export interface FleetCommsInboxDeps {
  runsDir?: string;
  read?: (options: UnifiedInboxOptions) => Promise<UnifiedInbox>;
}

export function parseFleetCommsInboxArgs(args: Record<string, unknown>): FleetCommsInboxArgs | null {
  if (Object.keys(args).some(key => key !== 'limit')) return null;
  const limit = args.limit === undefined && !('limit' in args) ? 50 : args.limit;
  return typeof limit === 'number' && Number.isInteger(limit) && limit >= 1 && limit <= UNIFIED_INBOX_MAX_ITEMS
    ? { limit } : null;
}

/** Read the same ranked, private inbox as the local HTTP endpoint. */
export async function readFleetCommsInbox(args: FleetCommsInboxArgs, deps: FleetCommsInboxDeps = {}) {
  const schema = 'comms.unified-inbox.v1' as const;
  try {
    const inbox = await (deps.read ?? readUnifiedInbox)({ runsDir: deps.runsDir ?? fixedOwnerRunsDir() });
    const items = inbox.items.slice(0, args.limit);
    return { schema, generatedAt: inbox.generatedAt, sources: inbox.sources, total: inbox.total,
      omitted: Math.max(0, inbox.total - items.length), items };
  } catch {
    return { schema, unavailable: true as const, items: [] };
  }
}
