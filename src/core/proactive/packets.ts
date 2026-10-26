import { taskContextTimestamp } from '../context/task-temporal-context.js';
import { outcomeCanonical, outcomeDigest, outcomeToken } from '../goals/outcome-types.js';
import { scrubSecrets } from '../util/scrub.js';
import type { CompanionPacketAuthorization, CompanionPacketDestination, CompanionPacketFreshness,
  CompanionPacketInput, CompanionPacketV1 } from './packet-types.js';

const PACKET_KEYS = ['schemaVersion', 'projectBindingId', 'tenantId', 'taskId', 'goal', 'acceptance', 'accountRefs',
  'allowedDestination', 'artifact', 'evidence', 'asOf', 'coverage', 'deadline', 'limits'];
const INPUT_KEYS = PACKET_KEYS.filter(key => key !== 'schemaVersion');
const MAX_PACKET_BYTES = 256 * 1024;

function record(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  return required.every(key => descriptors[key] && 'value' in descriptors[key]!) &&
    keys.every(key => typeof key === 'string' && [...required, ...optional].includes(key) &&
      'value' in descriptors[key]! && descriptors[key]!.enumerable);
}
function text(value: unknown, max: number): value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max ||
      /\p{Surrogate}/u.test(value) || scrubSecrets(value) !== value) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if ((code < 32 || code === 127) && ![9, 10, 13].includes(code)) return false;
  }
  return true;
}
function list(value: unknown, max: number, valid: (item: unknown) => boolean): value is unknown[] {
  if (!Array.isArray(value) || value.length > max) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(value).length === value.length + 1 &&
    Array.from({ length: value.length }, (_, index) => descriptors[index])
      .every(descriptor => descriptor && 'value' in descriptor && valid(descriptor.value));
}
function strings(value: unknown, count: number, max: number, nonempty = false): value is string[] {
  return list(value, count, item => text(item, max)) && (!nonempty || value.length > 0) && new Set(value).size === value.length;
}
function destination(value: unknown): value is CompanionPacketDestination {
  return record(value, ['provider', 'accountId', 'agentId']) && text(value.provider, 128) &&
    text(value.accountId, 256) && text(value.agentId, 256);
}
function sameDestination(a: CompanionPacketDestination, b: CompanionPacketDestination): boolean {
  return a.provider === b.provider && a.accountId === b.accountId && a.agentId === b.agentId;
}

/** Strict data-only parsing. A parsed packet is not authorized, connected or executable. */
export function parseScopedCompanionPacket(value: unknown): CompanionPacketV1 | null {
  try {
    if (!record(value, PACKET_KEYS) || value.schemaVersion !== 1 || !outcomeToken(value.projectBindingId) || !text(value.projectBindingId, 128) ||
        !outcomeToken(value.tenantId) || !text(value.tenantId, 128) || !text(value.taskId, 256) || !text(value.goal, 8192) ||
        !strings(value.acceptance, 64, 2048, true) || !strings(value.accountRefs, 128, 256) ||
        !destination(value.allowedDestination) || !record(value.artifact, [], ['repo', 'expectedHeadSha', 'artifactRef', 'revision'])) return null;
    const artifact = value.artifact;
    if (Object.keys(artifact).length === 0 ||
        Object.entries(artifact).some(([key, item]) => !text(item, key === 'repo' || key === 'artifactRef' ? 2048 : 256)) ||
        (artifact.expectedHeadSha !== undefined && (typeof artifact.expectedHeadSha !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(artifact.expectedHeadSha))) ||
        (artifact.expectedHeadSha !== undefined && artifact.repo === undefined) ||
        (artifact.repo !== undefined && artifact.expectedHeadSha === undefined) ||
        (artifact.artifactRef !== undefined && artifact.revision === undefined) ||
        (artifact.revision !== undefined && artifact.artifactRef === undefined)) return null;
    if (!list(value.evidence, 128, item => {
      if (!record(item, ['source', 'observedAt', 'epistemic'], ['excerpt']) ||
          !record(item.source, ['provider', 'accountRef', 'objectRef', 'revisionRef'])) return false;
      const source = item.source;
      return text(source.provider, 128) && text(source.accountRef, 256) && text(source.objectRef, 2048) &&
        text(source.revisionRef, 256) && taskContextTimestamp(item.observedAt) !== null &&
        ['recorded', 'derived', 'hypothesis'].includes(item.epistemic as string) &&
        (item.excerpt === undefined || text(item.excerpt, 4096));
    }) || !record(value.coverage, ['sourceState', 'complete', 'stopReasons']) ||
        !['missing', 'healthy', 'degraded'].includes(value.coverage.sourceState as string) ||
        typeof value.coverage.complete !== 'boolean' || !strings(value.coverage.stopReasons, 32, 256) ||
        (value.coverage.complete && (value.coverage.sourceState !== 'healthy' || value.coverage.stopReasons.length > 0)) ||
        !record(value.limits, ['maxCostUsd', 'maxAttempts', 'maxContextBytes'])) return null;
    const limits = value.limits;
    if ((limits.maxCostUsd !== null && (typeof limits.maxCostUsd !== 'number' || !Number.isFinite(limits.maxCostUsd) || limits.maxCostUsd < 0)) ||
        !Number.isSafeInteger(limits.maxAttempts) || (limits.maxAttempts as number) < 1 || (limits.maxAttempts as number) > 100 ||
        !Number.isSafeInteger(limits.maxContextBytes) || (limits.maxContextBytes as number) < 1 || (limits.maxContextBytes as number) > MAX_PACKET_BYTES) return null;
    const asOf = taskContextTimestamp(value.asOf);
    const deadline = value.deadline === null ? null : taskContextTimestamp(value.deadline);
    if (!asOf || (value.deadline !== null && (!deadline || deadline <= asOf))) return null;
    // Clone only after the complete data-only shape has been admitted; no getters execute.
    const packet = JSON.parse(outcomeCanonical(value)) as CompanionPacketV1;
    packet.asOf = asOf;
    packet.deadline = deadline;
    for (const item of packet.evidence) {
      item.observedAt = taskContextTimestamp(item.observedAt)!;
      if (!packet.accountRefs.includes(item.source.accountRef) || item.observedAt > asOf) return null;
    }
    // Canonical set ordering makes equivalent scope and provenance order independent.
    packet.accountRefs.sort();
    packet.evidence.sort((a, b) => {
      const left = outcomeCanonical(a), right = outcomeCanonical(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    if (new Set(packet.evidence.map(item => outcomeCanonical(item.source))).size !== packet.evidence.length ||
        Buffer.byteLength(outcomeCanonical(packet), 'utf8') > packet.limits.maxContextBytes) return null;
    return packet;
  } catch { return null; }
}

function freezePacket(packet: CompanionPacketV1): Readonly<CompanionPacketV1> {
  function freeze(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  freeze(packet);
  return packet;
}

/** Explicit account+task+tenant+project+destination checks precede the host's revocation
 * and source-object policy check. Secret detection never substitutes for authorization. */
export function isScopedCompanionPacketAuthorized(packet: CompanionPacketV1, authorization: CompanionPacketAuthorization): boolean {
  try {
    const parsed = parseScopedCompanionPacket(packet);
    if (!parsed || !authorization || typeof authorization.stillAuthorized !== 'function' ||
        !strings(authorization.accountRefs, 128, 256) || !destination(authorization.allowedDestination) ||
        parsed.tenantId !== authorization.tenantId || parsed.projectBindingId !== authorization.projectBindingId ||
        parsed.taskId !== authorization.taskId || !sameDestination(parsed.allowedDestination, authorization.allowedDestination) ||
        parsed.accountRefs.some(account => !authorization.accountRefs.includes(account))) return false;
    return authorization.stillAuthorized(freezePacket(parsed)) === true;
  } catch { return false; }
}

export function companionPacketDigest(packet: CompanionPacketV1): string {
  const parsed = parseScopedCompanionPacket(packet);
  if (!parsed) throw new Error('Invalid companion evidence packet.');
  return outcomeDigest(parsed);
}

export function buildScopedCompanionPacket(input: CompanionPacketInput, authorization: CompanionPacketAuthorization): { packet: CompanionPacketV1; digest: string } {
  let packet: CompanionPacketV1 | null = null;
  try { if (record(input, INPUT_KEYS)) packet = parseScopedCompanionPacket({ ...input, schemaVersion: 1 }); } catch { /* Bound error below. */ }
  if (!packet) throw new Error('Invalid companion evidence packet.');
  if (!isScopedCompanionPacketAuthorized(packet, authorization)) throw new Error('Companion packet scope is not authorized.');
  const digest = outcomeDigest(packet);
  // A host may revoke the grant while preparing a projection. Publication/contact must
  // perform its own final check; this second check does not confer lasting permission.
  if (!isScopedCompanionPacketAuthorized(packet, authorization)) throw new Error('Companion packet scope is no longer authorized.');
  return { packet, digest };
}

/** Freshness is an explicit projection, never an inferred promise of source completeness. */
export function reportCompanionPacketFreshness(packet: CompanionPacketV1, input: { asOf: string; maxAgeMs: number }): CompanionPacketFreshness {
  const parsed = parseScopedCompanionPacket(packet);
  const asOf = taskContextTimestamp(input.asOf);
  if (!parsed || !asOf || !Number.isSafeInteger(input.maxAgeMs) || input.maxAgeMs < 0) throw new Error('Invalid companion freshness query.');
  const staleEvidenceIndexes: number[] = [], futureEvidenceIndexes: number[] = [];
  parsed.evidence.forEach((item, index) => {
    const age = Date.parse(asOf) - Date.parse(item.observedAt);
    if (age < 0) futureEvidenceIndexes.push(index);
    else if (age > input.maxAgeMs) staleEvidenceIndexes.push(index);
  });
  const partial = !parsed.coverage.complete || parsed.coverage.sourceState !== 'healthy';
  return { asOf, freshness: staleEvidenceIndexes.length ? 'stale' :
    partial || !parsed.evidence.length || futureEvidenceIndexes.length ? 'unknown' : 'fresh',
  staleEvidenceIndexes, futureEvidenceIndexes, partial, sourceState: parsed.coverage.sourceState,
  stopReasons: [...parsed.coverage.stopReasons], deadlineExceeded: parsed.deadline !== null && parsed.deadline <= asOf };
}
