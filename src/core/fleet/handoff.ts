/**
 * ONE-TEAM v1 handoffs carry references, never inline prompts or credentials.
 * These are coordination claims, not lease transfers or execution authority.
 * Structural rules mirror schema/handoff.v1.schema.json; runtime additionally
 * rejects recognized secrets using the shared scrubber. No reference is fetched.
 */
import { scrubSecrets } from '../util/scrub.js';

export const HANDOFF_KINDS = Object.freeze([
  'plan', 'delegate', 'ask', 'review', 'takeover', 'result',
] as const);

export type HandoffKind = typeof HANDOFF_KINDS[number];

/** Mapped union preserves narrowing and Extract<HandoffMessage, { kind: K }>. */
export type HandoffMessage = {
  [K in HandoffKind]: Readonly<{
    version: 1;
    kind: K;
    taskId: string;
    fromProvider: string;
    toProvider: string;
    /** Opaque namespace:id locators. Dereferencing needs separate authorization. */
    payloadRefs: readonly string[];
  }>;
}[HandoffKind];

const FIELDS = ['version', 'kind', 'taskId', 'fromProvider', 'toProvider', 'payloadRefs'] as const;
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
const PROVIDER_ID = /^[a-z][a-z0-9-]*$/;
const PAYLOAD_REF = /^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9][A-Za-z0-9._/-]*$/;
// Stripe keys are intentionally outside the shared identity scrubber's policy.
const STRIPE_SECRET = /\bsk_(?:live|test)_[A-Za-z0-9_]{8,}\b/i;
const MAX_WIRE_BYTES = 16 * 1024;

function invalid(): never {
  // Never echo submitted values, property names, or native JSON parse errors.
  throw new TypeError('Invalid handoff message');
}

function safeString(value: unknown, max: number, pattern: RegExp): value is string {
  return typeof value === 'string'
    && value.length > 0 && value.length <= max
    // JS $ also matches before a final newline. Require an ASCII identifier.
    && !/\s/.test(value) && pattern.test(value)
    && scrubSecrets(value) === value && !STRIPE_SECRET.test(value);
}

/**
 * Validate untrusted input and return a detached, immutable message. Exact own
 * data properties prevent getters/toJSON or hidden fields bypassing inspection.
 */
export function parseHandoff(value: unknown): HandoffMessage {
  try {
    if (typeof value !== 'object' || value === null) return invalid();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalid();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== FIELDS.length || !FIELDS.every((key) => keys.includes(key))) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const data: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of FIELDS) {
      const descriptor = descriptors[key];
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return invalid();
      data[key] = descriptor.value;
    }
    if (data.version !== 1 || !HANDOFF_KINDS.includes(data.kind as HandoffKind)) return invalid();
    if (!safeString(data.taskId, 128, TASK_ID)
      || !safeString(data.fromProvider, 64, PROVIDER_ID)
      || !safeString(data.toProvider, 64, PROVIDER_ID)) return invalid();

    const refs = data.payloadRefs;
    if (!Array.isArray(refs) || Object.getPrototypeOf(refs) !== Array.prototype) return invalid();
    const length = Object.getOwnPropertyDescriptor(refs, 'length')?.value as unknown;
    if (typeof length !== 'number' || length < 1 || length > 32) return invalid();
    if (Reflect.ownKeys(refs).length !== length + 1) return invalid();
    const payloadRefs: string[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(refs, String(index));
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)
        || !safeString(descriptor.value, 256, PAYLOAD_REF)) return invalid();
      payloadRefs.push(descriptor.value);
    }
    if (new Set(payloadRefs).size !== payloadRefs.length) return invalid();
    return Object.freeze({
      version: 1,
      kind: data.kind as HandoffKind,
      taskId: data.taskId,
      fromProvider: data.fromProvider,
      toProvider: data.toProvider,
      payloadRefs: Object.freeze(payloadRefs),
    });
  } catch {
    return invalid();
  }
}

/** Serialize only validated fields, without invoking user-supplied toJSON. */
export function serializeHandoff(value: unknown): string {
  return JSON.stringify(parseHandoff(value));
}

/** Parse bounded JSON. Returned references are still opaque and untrusted. */
export function deserializeHandoff(json: string): HandoffMessage {
  try {
    if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > MAX_WIRE_BYTES) return invalid();
    return parseHandoff(JSON.parse(json) as unknown);
  } catch {
    return invalid();
  }
}
