import { homedir } from 'node:os';
import { join } from 'node:path';
import { appendInboxEntry } from './mason-inbox.js';
import { ensureDeliveryDir, readDelivery, serializeDelivery, writeDelivery, type DeliveryState } from './needs-mason-reply-delivery.js';
import { listNeedsMason, resolveNeedsMason, type NeedsMasonOptions, type NeedsMasonResolveResult } from './needs-mason-resolve.js';

/**
 * `deliveryReceipt: 'unrecorded'` means the append succeeded but the receipt could not be
 * persisted, so a retry may append again (no idempotent append primitive exists).
 */
export type NeedsMasonRelayResult = NeedsMasonResolveResult & { inbox: 'appended' | 'skipped' | 'failed'; deliveryReceipt?: 'unrecorded' };

// Labels chosen so inboxChannelSlug yields src:desktop/telegram/cli/phone.
const INBOX_SOURCE = { desktop: 'Phantom desktop', telegram: 'Telegram', cli: 'CLI', phone: 'Phantom phone' } as const;
const ITEM_ID = /^nm-[0-9a-f]{12}$/;

/**
 * Relay answers to the planner after the durable resolution succeeds. The accepted
 * message is persisted before the append, so a failed append can be retried for the
 * same item (original reply, no second bus event) even though the item is resolved.
 */
export async function resolveNeedsMasonWithInbox(
  input: unknown,
  options: NeedsMasonOptions & { appendInbox?: typeof appendInboxEntry } = {},
): Promise<NeedsMasonRelayResult> {
  const runsDir = options.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const fields = input !== null && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown> : {};
  const id = typeof fields.itemId === 'string' && ITEM_ID.test(fields.itemId) ? fields.itemId : null;
  if (!id) return relay(input, options, runsDir);
  return serializeDelivery(`${runsDir}\0${id}`, () => relay(input, options, runsDir, id));
}

async function relay(
  input: unknown, options: NeedsMasonOptions & { appendInbox?: typeof appendInboxEntry }, runsDir: string, id?: string,
): Promise<NeedsMasonRelayResult> {
  const resolvedOptions = { ...options, runsDir };
  const fields = input !== null && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown> : {};
  const reply = typeof fields.reply === 'string' ? fields.reply.trim() : '';
  const unavailable = (error: string): NeedsMasonRelayResult => ({ ok: false, code: 'unavailable', error, inbox: 'failed' });
  const deliver = async (state: DeliveryState, itemId: string): Promise<NeedsMasonRelayResult> => {
    const base = { ok: true as const, itemId, cursor: state.cursor, duplicate: state.duplicate };
    try {
      const appended = await (options.appendInbox ?? appendInboxEntry)(state.message, {
        runsDir, source: state.source, ...(options.now ? { now: () => new Date(options.now!()) } : {}),
      });
      if (!appended.ok) return { ...base, inbox: 'failed' };
    } catch {
      // Bus and marker writes already succeeded; an inbox failure cannot undo them.
      return { ...base, inbox: 'failed' };
    }
    const receipted = id !== undefined && writeDelivery(runsDir, id, { ...state, status: 'delivered', message: '' });
    return receipted ? { ...base, inbox: 'appended' } : { ...base, inbox: 'appended', deliveryReceipt: 'unrecorded' };
  };

  if (id !== undefined) {
    const prior = readDelivery(runsDir, id);
    if (prior.kind === 'unsafe') return unavailable('Reply delivery state is unreadable; nothing was changed.');
    if (prior.kind === 'state' && prior.state.status === 'pending') {
      // Retry: the original accepted reply wins; the new text is only validated, never substituted.
      const check = resolveNeedsMason(input, resolvedOptions);
      if (!check.ok && check.code !== 'already-resolved' && check.code !== 'unknown') return { ...check, inbox: 'skipped' };
      return deliver(prior.state, id);
    }
    if (reply && !ensureDeliveryDir(runsDir)) return unavailable('Reply delivery storage is unavailable; nothing was changed.');
  }
  const item = listNeedsMason(resolvedOptions).find(candidate => candidate.id === fields.itemId);
  const result = resolveNeedsMason(input, resolvedOptions);
  if (!result.ok || result.duplicate || !reply || id === undefined) return { ...result, inbox: 'skipped' };
  const state: DeliveryState = {
    status: 'pending', source: INBOX_SOURCE[options.source ?? 'desktop'], cursor: result.cursor, duplicate: false,
    message: `Re needs-you ${result.itemId} ("${(item?.text ?? '').slice(0, 160)}"): ${reply}`,
  };
  // If the intent cannot be persisted we still try once; a failure then has no retry path and says so.
  writeDelivery(runsDir, id, state);
  return deliver(state, result.itemId);
}
