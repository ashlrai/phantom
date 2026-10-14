import { canonicalJson } from '../authority/canonical-json.js';
import { buildMemoryContextPack } from './pack.js';
import { MEMORY_LIMITS, type MemorySourceRef } from './types.js';
import { immutableMemorySnapshot, memoryUtf8Bytes, validMemoryId, validMemoryPackQuery } from './validate.js';
import type { MemoryNotePreview } from './note-preview-types.js';

/** Copy own data descriptors without invoking property getters. This is a JSON-like boundary, not a hostile Proxy sandbox. */
function dataFields(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  if (Reflect.ownKeys(value).length !== keys.length) return null;
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
    result[key] = descriptor.value;
  }
  return result;
}

const REF_KEYS = ['id', 'digest', 'locator', 'quote', 'observedAt'] as const;
/** No parallel source validator: bounded scalar correspondence to an already validated, immutable fact is the gate. */
function correspondingRefs(value: unknown, expected: readonly MemorySourceRef[]): boolean {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < 1
    || value.length > MEMORY_LIMITS.refs || value.length !== expected.length || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return false;
    const supplied = dataFields(descriptor.value, REF_KEYS);
    if (!supplied) return false;
    for (const key of REF_KEYS) {
      const scalar = supplied[key];
      if (!(typeof scalar === 'string' || (key === 'observedAt' && scalar === null)) || scalar !== expected[i]![key]) return false;
    }
  }
  return true;
}

/**
 * Uncalled, pure selection-bound preview. The caller supplies the whole declared history and review/scope/time labels.
 * Creates no event, ID, approval, principal, timestamp, digest or permission. Exact correspondence is not source authentication.
 */
export function buildMemoryNotePreview(input: unknown): MemoryNotePreview {
  const output: MemoryNotePreview = { schemaVersion: 1, protocol: 'phantom-memory-note-preview-v1', pack: null,
    noteState: 'refused', noteExclusion: null, stopReasons: [], reviewBasis: 'caller-declared-not-authenticated',
    scopeBasis: 'caller-declared-not-authenticated', sourceAuthenticity: 'unknown', historyCompleteness: 'caller-declared',
    actualExecution: 'unknown', taskQuality: 'unknown', elapsedTime: 'unknown', providerCost: 'unknown',
    executionEnabled: false, autoInject: false, authority: false };
  const refuse = (reason: string): MemoryNotePreview => { output.stopReasons.push(reason); return output; };
  try {
    const request = dataFields(input, ['schemaVersion', 'snapshot', 'query', 'operatorSelection', 'authority']);
    if (!request || request.schemaVersion !== 1 || request.authority !== false) return refuse('invalid-input');
    const snapshot = immutableMemorySnapshot(request.snapshot);
    if (!snapshot) return refuse('invalid-snapshot');
    if (!validMemoryPackQuery(request.query)) return refuse('invalid-query');
    const query: unknown = JSON.parse(canonicalJson(request.query));
    if (!validMemoryPackQuery(query)) return refuse('invalid-query');
    const selection = dataFields(request.operatorSelection, ['eventId', 'text', 'sourceRefs']);
    if (!selection || !validMemoryId(selection.eventId) || typeof selection.text !== 'string'
      || selection.text.length > MEMORY_LIMITS.textBytes || memoryUtf8Bytes(selection.text) > MEMORY_LIMITS.textBytes) return refuse('invalid-selection');
    const event = snapshot.events.find(item => item.eventId === selection.eventId);
    if (!event) return refuse('selection-event-not-found');
    if (event.kind !== 'fact') return refuse('selection-not-fact');
    // Compare the captured scalar values before serializing any selection data; the kernel uses the immutable matched event.
    if (selection.text !== event.text || !correspondingRefs(selection.sourceRefs, event.sourceRefs)) return refuse('selection-mismatch');
    const pack = buildMemoryContextPack(snapshot, query);
    output.pack = pack;
    output.stopReasons = [...pack.receipt.stopReasons];
    if (pack.status === 'refused') return output;
    if (pack.status === 'unknown' || pack.status === 'unavailable') { output.noteState = 'unknown'; return output; }
    if (pack.items.some(item => item.eventId === event.eventId)) { output.noteState = 'included'; return output; }
    const exclusion = pack.receipt.exclusions.find(item => item.eventId === event.eventId);
    // An unexplained missing candidate cannot be advertised as a known exclusion.
    if (!exclusion) return refuse('selection-outcome-unavailable');
    output.noteState = 'excluded';
    output.noteExclusion = exclusion.reason;
    return output;
  } catch { return refuse('invalid-input'); }
}
