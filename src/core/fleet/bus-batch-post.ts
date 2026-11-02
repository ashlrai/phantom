/** Sequential durable fanout. A failed suffix never rolls back an accepted prefix. */
import { validateBusEnvelope, type BusEnvelope } from './bus-envelope.js';
import { appendBusInbox, type BusInboxOptions, type BusInboxPost } from './bus-inbox.js';

export const MAX_BUS_BATCH_BYTES = 256 * 1024;
export const MAX_BUS_BATCH_MESSAGES = 32;
type Accepted = Extract<BusInboxPost, { id: string }>;
export interface BusBatchReceipt {
  version: 1;
  status: 'complete' | BusInboxPost['status'];
  accepted: Accepted[];
  failure: { index: number | null; status: BusInboxPost['status'] } | null;
  unattempted: string[];
  complete: boolean;
}

export function failedBusBatch(status: 'invalid' | 'unavailable', index: number | null = null): BusBatchReceipt {
  return { version: 1, status, accepted: [], failure: { index, status }, unattempted: [], complete: false };
}

export function postBusBatch(text: string, options: BusInboxOptions = {}): BusBatchReceipt {
  if (Buffer.byteLength(text, 'utf8') > MAX_BUS_BATCH_BYTES) return failedBusBatch('invalid');
  let input: unknown;
  try { input = JSON.parse(text); } catch { return failedBusBatch('invalid'); }
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_BUS_BATCH_MESSAGES) return failedBusBatch('invalid');
  const envelopes: BusEnvelope[] = [], ids = new Set<string>();
  // Validate the entire input, including duplicate IDs, before opening a store.
  for (const [index, row] of input.entries()) {
    const checked = validateBusEnvelope(row);
    if (!checked.ok || ids.has(checked.value.id)) return failedBusBatch('invalid', index);
    ids.add(checked.value.id);
    envelopes.push(checked.value);
  }
  const accepted: Accepted[] = [];
  for (const [index, envelope] of envelopes.entries()) {
    let result: BusInboxPost;
    try { result = appendBusInbox(envelope, options); }
    catch { result = { status: 'unavailable' }; }
    // Input is already valid; an invalid store clock is an operational refusal.
    if (result.status === 'invalid') result = { status: 'unavailable' };
    if (result.status !== 'posted' && result.status !== 'duplicate') {
      return { version: 1, status: result.status, accepted, failure: { index, status: result.status },
        unattempted: envelopes.slice(index + 1).map(row => row.id), complete: false };
    }
    accepted.push(result);
  }
  return { version: 1, status: 'complete', accepted, failure: null, unattempted: [], complete: true };
}
