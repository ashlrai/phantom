/** Pure local projection of supplied validated records. No storage, provider, launcher or coordinator mutation. */
import { createHash } from 'node:crypto';
import { canonicalJson } from '../authority/canonical-json.js';
import { redactGenericHomePaths, scrubSecrets } from '../util/scrub-secrets.js';
import { parseScopedCompanionPacket, companionPacketDigest } from './packets.js';
import { companionDigestToReference } from './coordination-wire.js';
import { companionIdentityEqual, type CompanionRead } from './coordination-types.js';
import type { ProactiveProfile } from './types.js';
import { GROK_HANDOFF_PREVIEW_MAX_BYTES, validGrokHandoffPreviewRequest,
  type GrokHandoffPreviewRequest, type GrokHandoffPreviewResponse } from './handoff-preview-types.js';

export class GrokHandoffPreviewError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'HELD' | 'UNAVAILABLE') {
    super(code === 'INVALID_INPUT' ? 'Use the exact current task, attempt, profile and revision bindings.'
      : code === 'HELD' ? 'The handoff preview changed or is no longer available. Refresh and review it again.'
        : 'Local handoff evidence is unavailable. Existing records were preserved.');
  }
}
function refuse(code: GrokHandoffPreviewError['code']): never { throw new GrokHandoffPreviewError(code); }
const time = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const same = (left: unknown, right: unknown): boolean => canonicalJson(left) === canonicalJson(right);

export function buildGrokHandoffPreview(input: {
  request: GrokHandoffPreviewRequest; read: CompanionRead; packet: unknown; profile: ProactiveProfile | null; asOf: string;
}): GrokHandoffPreviewResponse {
  const { request, read, profile, asOf } = input;
  if (!validGrokHandoffPreviewRequest(request)) refuse('INVALID_INPUT');
  if (!time(asOf) || read.sourceState !== 'healthy') refuse('UNAVAILABLE');
  if (read.revision !== request.expectedRevision) refuse('HELD');
  const task = read.task, attempt = task?.attempts.at(-1);
  if (!task || !attempt || task.id !== request.taskId || attempt.id !== request.attemptId || attempt.epoch !== request.epoch
    || task.state !== 'handoff-intent' || attempt.contact !== 'intent'
    || !time(attempt.handoffAt) || attempt.handoffAt < attempt.claimedAt || attempt.handoffAt > asOf
    || attempt.cancelRequestedAt !== null || attempt.providerRunId !== null || attempt.observationReference !== null
    || !time(attempt.claimedAt) || attempt.claimedAt > asOf || !time(attempt.leaseExpiresAt) || attempt.leaseExpiresAt <= asOf
    || (task.deadline !== null && (!time(task.deadline) || task.deadline <= asOf))) refuse('HELD');
  if (!profile || profile.id !== request.profileId || profile.version !== request.expectedProfileVersion
    || profile.identity.provider !== 'grok-bot' || !profile.enabled || !companionIdentityEqual(profile.identity, attempt.assignee)
    || task.capabilityIds.some(id => !profile.capabilityIds.includes(id))
    || profile.preferences.projectBindingIds.length > 0 && !profile.preferences.projectBindingIds.includes(task.projectBindingId)) refuse('HELD');
  const packet = parseScopedCompanionPacket(input.packet);
  if (!packet) refuse('UNAVAILABLE');
  if (packet.accountRefs.length || packet.evidence.length || packet.coverage.sourceState !== 'missing' || packet.coverage.complete
    || packet.taskId !== task.id || packet.tenantId !== task.tenantId || packet.projectBindingId !== task.projectBindingId
    || !companionIdentityEqual(packet.allowedDestination, profile.identity) || packet.goal !== task.goal
    || !same(packet.acceptance, task.acceptance) || packet.deadline !== task.deadline || packet.asOf > asOf
    || packet.limits.maxCostUsd !== task.maxCostUsd || packet.limits.maxAttempts !== task.maxAttempts
    || packet.limits.maxContextBytes > GROK_HANDOFF_PREVIEW_MAX_BYTES
    || companionPacketDigest(packet) !== task.packetDigest || attempt.packetDigest !== task.packetDigest) refuse('HELD');
  // Screen original leaves too: JSON escaping doubles Windows separators and can hide home-path shapes.
  const rawText = [task.tenantId, task.projectBindingId, task.id, attempt.ownerId, profile.id,
    profile.identity.provider, profile.identity.accountId, profile.identity.agentId,
    packet.goal, ...packet.acceptance, ...task.capabilityIds, ...packet.coverage.stopReasons];
  if (rawText.some(value => typeof value !== 'string' || scrubSecrets(value) !== value || redactGenericHomePaths(value) !== value)) refuse('HELD');
  const briefText = canonicalJson({
    schemaVersion: 1, type: 'phantom-grok-bot-operator-brief',
    provenance: 'locally-supplied-review-required-not-authorship-proof',
    scope: { tenantId: task.tenantId, projectBindingId: task.projectBindingId, taskId: task.id },
    recipient: profile.identity, profile: { id: profile.id, version: profile.version, capabilityVerification: 'declared-unverified' },
    ownership: { attemptId: companionDigestToReference(attempt.id), epoch: attempt.epoch, ownerId: attempt.ownerId,
      claimedAt: attempt.claimedAt, handoffIntentAt: attempt.handoffAt, contactState: 'intent', leaseExpiresAt: attempt.leaseExpiresAt },
    packetDigest: companionDigestToReference(task.packetDigest), savedPacketAsOf: packet.asOf,
    goal: packet.goal, acceptance: packet.acceptance, capabilityIds: task.capabilityIds,
    deadline: packet.deadline, limits: packet.limits, coverage: packet.coverage,
    returnBinding: { taskId: task.id, attemptId: companionDigestToReference(attempt.id), epoch: attempt.epoch,
      packetDigest: companionDigestToReference(task.packetDigest), reportSource: 'manual-unverified', independentReviewRequired: true },
    transport: 'manual-copy', providerAcceptance: 'unobserved', providerCompletion: 'unobserved',
    dispatchAuthorized: false, contextShared: false, authority: false,
  }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  // Refuse any transformation; the preview digest must bind the exact displayed/copied bytes.
  if (Buffer.byteLength(briefText, 'utf8') > GROK_HANDOFF_PREVIEW_MAX_BYTES
    || scrubSecrets(briefText) !== briefText || redactGenericHomePaths(briefText) !== briefText) refuse('HELD');
  const previewDigest = createHash('sha256').update(briefText, 'utf8').digest('hex');
  if (request.expectedPreviewDigest !== undefined && request.expectedPreviewDigest !== previewDigest) refuse('HELD');
  return { schemaVersion: 1, taskId: task.id, attemptId: attempt.id, epoch: attempt.epoch, revision: read.revision,
    profileId: profile.id, profileVersion: profile.version, packetDigest: task.packetDigest, previewDigest, briefText,
    dispatchAuthorized: false, contextShared: false, transport: 'manual-copy' };
}
