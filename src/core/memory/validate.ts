import { redactGenericHomePaths, scrubSecrets } from '../util/scrub-secrets.js';
import { canonicalJson } from '../authority/canonical-json.js';
import { MEMORY_LIMITS, type MemoryFactEvent, type MemoryPackQuery, type MemorySnapshot } from './types.js';

/** Pattern screening only: no transformation and no guarantee of exhaustive private-data detection. */
export const memoryContentUnchanged = (value: string): boolean => redactGenericHomePaths(scrubSecrets(value)) === value;
export const memoryUtf8Bytes = (value: string): number => new TextEncoder().encode(value).length;
export function validMemoryId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) && memoryContentUnchanged(value);
}
export function validMemoryDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
const optionalDate = (value: unknown): boolean => value === null || validMemoryDate(value);
function record(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && 'value' in descriptor && descriptor.enumerable;
  });
}
function array(value: unknown, max: number, check: (entry: unknown) => boolean, min = 0): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < min || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let i = 0; i < value.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !('value' in descriptor) || !check(descriptor.value)) return false;
  }
  return true;
}
const ids = (value: unknown, max: number, min = 0): value is string[] => array(value, max, validMemoryId, min)
  && new Set(value).size === value.length;
function text(value: unknown, bytes: number, allowEmpty = false): value is string {
  // Refuse, rather than silently transform, controls or unpaired surrogates.
  return typeof value === 'string' && (allowEmpty || value.trim().length > 0) && value.length <= bytes
    // eslint-disable-next-line no-control-regex
    && !/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/.test(value)
    && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)
    && memoryUtf8Bytes(value) <= bytes && memoryContentUnchanged(value);
}
function source(value: unknown): boolean {
  return record(value, ['id', 'digest', 'locator', 'quote', 'observedAt']) && validMemoryId(value.id)
    && typeof value.digest === 'string' && /^sha256_[a-f0-9]{64}$/.test(value.digest)
    && text(value.locator, 256) && text(value.quote, MEMORY_LIMITS.quoteBytes) && optionalDate(value.observedAt);
}
export function validMemoryFactEvent(value: unknown): value is MemoryFactEvent {
  if (!record(value, ['schemaVersion', 'eventId', 'factId', 'revision', 'kind', 'projectId', 'ownerId', 'audienceIds',
    'subjectKey', 'slotKey', 'text', 'sourceRefs', 'observedAt', 'validFrom', 'validUntil', 'recordedAt', 'reviewState',
    'reviewedAt', 'reviewerDecisionId', 'supersedes', 'derivedFrom', 'tombstones', 'authority'])) return false;
  if (value.schemaVersion !== 1 || value.authority !== false || !validMemoryId(value.eventId) || !validMemoryId(value.factId)
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 || typeof value.kind !== 'string' || !['fact', 'tombstone'].includes(value.kind)
    || !validMemoryId(value.projectId) || !validMemoryId(value.ownerId) || !ids(value.audienceIds, MEMORY_LIMITS.audiences, 1)
    || !validMemoryId(value.subjectKey) || !validMemoryId(value.slotKey) || !text(value.text, MEMORY_LIMITS.textBytes, value.kind === 'tombstone')
    || !array(value.sourceRefs, MEMORY_LIMITS.refs, source, 1) || !optionalDate(value.observedAt)
    || !optionalDate(value.validFrom) || !optionalDate(value.validUntil) || !validMemoryDate(value.recordedAt)
    || typeof value.reviewState !== 'string' || !['proposed', 'approved', 'disputed', 'withdrawn'].includes(value.reviewState)
    || !optionalDate(value.reviewedAt) || !(value.reviewerDecisionId === null || validMemoryId(value.reviewerDecisionId))
    || !ids(value.supersedes, MEMORY_LIMITS.links) || !ids(value.derivedFrom, MEMORY_LIMITS.links)
    || !ids(value.tombstones, MEMORY_LIMITS.links)) return false;
  if (value.kind === 'tombstone' ? value.text !== '' || !value.tombstones.length || value.supersedes.length > 0 || value.derivedFrom.length > 0
    : value.tombstones.length > 0) return false;
  if (['approved', 'withdrawn'].includes(value.reviewState) && (value.reviewedAt === null || value.reviewerDecisionId === null)) return false;
  if (value.reviewState === 'withdrawn' && (value.kind !== 'fact' || value.validFrom === null)) return false;
  if (value.observedAt !== null && (value.observedAt as string) > value.recordedAt) return false;
  if (value.sourceRefs.some(ref => (ref as { observedAt: string | null }).observedAt !== null
    && (ref as { observedAt: string }).observedAt > (value.recordedAt as string))) return false;
  if (value.reviewedAt !== null && (value.reviewedAt as string) > value.recordedAt) return false;
  if (value.validUntil !== null && (value.validFrom === null || (value.validUntil as string) <= (value.validFrom as string))) return false;
  return true;
}
export function validMemorySnapshot(value: unknown): value is MemorySnapshot {
  if (!(record(value, ['schemaVersion', 'snapshotId', 'revision', 'recordedThrough', 'sourceState', 'complete', 'events', 'authority'])
    && value.schemaVersion === 1 && value.authority === false && validMemoryId(value.snapshotId)
    && Number.isSafeInteger(value.revision) && (value.revision as number) >= 0 && validMemoryDate(value.recordedThrough)
    && typeof value.sourceState === 'string' && ['available', 'unknown', 'unavailable'].includes(value.sourceState)
    && typeof value.complete === 'boolean' && array(value.events, MEMORY_LIMITS.events, validMemoryFactEvent))) return false;
  const events = value.events as MemoryFactEvent[];
  if (new Set(events.map(event => event.eventId)).size !== events.length) return false;
  // Count exact canonical bytes incrementally, avoiding allocation of an over-cap whole snapshot.
  let bytes = memoryUtf8Bytes(canonicalJson({ ...value, events: [] })) + Math.max(0, events.length - 1);
  for (const event of events) {
    bytes += memoryUtf8Bytes(canonicalJson(event));
    if (bytes > MEMORY_LIMITS.snapshotBytes) return false;
  }
  return bytes <= MEMORY_LIMITS.snapshotBytes;
}
export function validMemoryPackQuery(value: unknown): value is MemoryPackQuery {
  return record(value, ['schemaVersion', 'projectId', 'ownerId', 'audienceId', 'time', 'knownAt', 'query', 'maxBytes', 'maxFacts', 'authority'])
    && value.schemaVersion === 1 && value.authority === false && validMemoryId(value.projectId) && validMemoryId(value.ownerId)
    && validMemoryId(value.audienceId) && record(value.time, ['mode', 'at']) && typeof value.time.mode === 'string' && ['current', 'asOf'].includes(value.time.mode)
    && validMemoryDate(value.time.at) && optionalDate(value.knownAt) && text(value.query, MEMORY_LIMITS.queryBytes, true)
    && Number.isSafeInteger(value.maxBytes) && (value.maxBytes as number) >= 256 && (value.maxBytes as number) <= MEMORY_LIMITS.packBytes
    && Number.isSafeInteger(value.maxFacts) && (value.maxFacts as number) >= 1 && (value.maxFacts as number) <= MEMORY_LIMITS.packFacts;
}
// Only this module's successfully validated detached/frozen copies qualify for reuse.
// Object.freeze, a caller brand or an identical JSON shape cannot forge membership.
// Weak membership retains no snapshot independently of its caller and caches no query result.
const preparedSnapshots = new WeakSet<MemorySnapshot>();
/** Prepare once or reuse this factory's immutable copy; later caller edits cannot alter it. */
export function immutableMemorySnapshot(value: unknown): MemorySnapshot | null {
  try {
    if (value !== null && typeof value === 'object' && preparedSnapshots.has(value as MemorySnapshot)) return value as MemorySnapshot;
    if (!validMemorySnapshot(value)) return null;
    const copy = JSON.parse(canonicalJson(value)) as MemorySnapshot;
    // Unknown JavaScript inputs may change during copying; brand only the actual validated JSON bytes.
    if (!validMemorySnapshot(copy)) return null;
    const stack: object[] = [copy];
    while (stack.length) { const item = stack.pop()!; Object.values(item).forEach(child => { if (child && typeof child === 'object') stack.push(child); }); Object.freeze(item); }
    preparedSnapshots.add(copy);
    return copy;
  } catch { return null; }
}
