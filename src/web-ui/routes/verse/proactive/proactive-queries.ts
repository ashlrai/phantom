import type { CompanionCandidate } from '../../../../core/proactive/planning.js';
import { decodeCompanionWire, projectCompanionWire } from '../../../../core/proactive/coordination-wire.js';
import type { CompanionTask, CompanionCommand, CompanionWrite, CompanionTaskInput } from '../../../../core/proactive/coordination-types.js';
import type { ProactiveProfile, ProactiveProfileInput, ProactiveProfilePatch, ProactiveProfilesResponse } from '../../../../core/proactive/types.js';
import { VERSE_PROACTIVE_AGENTS_PATH } from '../../../../core/proactive/types.js';
import { GROK_HANDOFF_PREVIEW_MAX_BYTES, validGrokHandoffPreviewRequest,
  type GrokHandoffPreviewRequest, type GrokHandoffPreviewResponse } from '../../../../core/proactive/handoff-preview-types.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { invalidate } from '../../../data/cache.js';
import { apiGet, apiPost } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { VerseMutationLockedError } from '../verse-queries.js';

export const PROACTIVE_KEY = 'verse-proactive-agents';
function validProfile(value: unknown): value is ProactiveProfile {
  if (!value || typeof value !== 'object') return false;
  const row = value as ProactiveProfile;
  return typeof row.id === 'string' && !!row.id && Number.isSafeInteger(row.version) && row.version > 0 && !!row.identity
    && typeof row.identity.provider === 'string' && row.identity.provider.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(row.identity.provider) && typeof row.identity.accountId === 'string' && !!row.identity.accountId
    && typeof row.identity.agentId === 'string' && !!row.identity.agentId && typeof row.displayName === 'string'
    && typeof row.responsibility === 'string' && !!row.avatar && /^#[a-fA-F0-9]{6}$/.test(row.avatar.color)
    && ['classic', 'round', 'pixel'].includes(row.avatar.variant) && !!row.computer
    && ['hosted', 'connected-local', 'unknown'].includes(row.computer.kind) && typeof row.computer.label === 'string'
    && (row.computer.providerComputerId === null || typeof row.computer.providerComputerId === 'string')
    && Array.isArray(row.services) && row.services.every(service => !!service && typeof service.id === 'string' && typeof service.label === 'string')
    && (row.fundingReference === null || !!row.fundingReference && ['subscription', 'promotional-api', 'unknown'].includes(row.fundingReference.kind)
      && row.fundingReference.accountId === row.identity.accountId && (row.fundingReference.poolId === null || typeof row.fundingReference.poolId === 'string'))
    && Array.isArray(row.capabilityIds) && row.capabilityIds.every(id => typeof id === 'string' && !!id) && row.capabilityVerification === 'declared-unverified'
    && !!row.preferences && Number.isInteger(row.preferences.priority) && row.preferences.priority >= 0 && row.preferences.priority <= 100
    && Number.isInteger(row.preferences.maxConcurrent) && row.preferences.maxConcurrent >= 1 && row.preferences.maxConcurrent <= 32
    && Array.isArray(row.preferences.projectBindingIds) && row.preferences.projectBindingIds.every(id => typeof id === 'string' && !!id)
    && typeof row.enabled === 'boolean' && row.connection === 'configured' && row.lastRun === null
    && typeof row.createdAt === 'string' && typeof row.updatedAt === 'string' && !!row.operations
    && ['dispatch', 'status', 'cancel', 'result'].every(key => {
      const operation = row.operations[key as keyof typeof row.operations];
      return !!operation && ['unverified', 'unsupported'].includes(operation.state) && operation.verifiedAt === null && typeof operation.note === 'string';
    });
}
export const proactiveProfilesQuery: QueryDef<ProactiveProfilesResponse> = {
  key: PROACTIVE_KEY,
  async fetch(signal) {
    const result = await apiGet<ProactiveProfilesResponse>(VERSE_PROACTIVE_AGENTS_PATH, signal);
    if (!result || result.schemaVersion !== 1 || !Array.isArray(result.profiles) || !result.profiles.every(validProfile)
      || new Set(result.profiles.map(profile => profile.id)).size !== result.profiles.length) throw new Error('Agent profile records are incompatible. Update Phantom and refresh.');
    return result;
  },
};
async function write<T>(path: string, body: unknown): Promise<T> {
  const token = getMutationToken();
  if (!token) throw new VerseMutationLockedError();
  const result = await apiPost<T>(path, body, token);
  touchMutationHold();
  invalidate(PROACTIVE_KEY);
  return result;
}
export async function createProactiveProfile(input: ProactiveProfileInput): Promise<ProactiveProfile> {
  const result = await write<{ profile: ProactiveProfile }>(VERSE_PROACTIVE_AGENTS_PATH, input);
  if (!validProfile(result?.profile) || result.profile.identity.provider !== input.identity.provider
    || result.profile.identity.accountId !== input.identity.accountId || result.profile.identity.agentId !== input.identity.agentId) {
    throw new Error('The new profile could not be confirmed. Refresh profiles before trying again.');
  }
  return result.profile;
}
export async function editProactiveProfile(id: string, patch: ProactiveProfilePatch): Promise<ProactiveProfile> {
  const result = await write<{ profile: ProactiveProfile }>(`${VERSE_PROACTIVE_AGENTS_PATH}/${encodeURIComponent(id)}`, patch);
  if (!validProfile(result?.profile) || result.profile.id !== id || result.profile.version !== patch.expectedVersion + 1) {
    throw new Error('The profile change could not be confirmed. Refresh before trying again.');
  }
  return result.profile;
}
export async function deleteProactiveProfile(id: string, expectedVersion: number): Promise<{ ok: true }> {
  const result = await write<{ ok: true }>(`${VERSE_PROACTIVE_AGENTS_PATH}/${encodeURIComponent(id)}/delete`, { expectedVersion });
  if (result?.ok !== true) throw new Error('Profile deletion could not be confirmed. Refresh before trying again.');
  return result;
}

export interface CoordinationResponse {
  schemaVersion: 1; revision: number | null; tasks: CompanionTask[];
  routing?: { taskId: string; candidates: CompanionCandidate[] }[];
  packetDestinations: { taskId: string; identity: ProactiveProfile['identity'] }[];
  sourceState: 'healthy' | 'missing' | 'degraded'; planningOnly: true; transport: 'unavailable';
}
export const COORDINATION_KEY = 'verse-proactive-coordination';
export const COORDINATION_PATH = `${VERSE_PROACTIVE_AGENTS_PATH}/coordination`;
function validTask(value: unknown): value is CompanionTask {
  if (!value || typeof value !== 'object') return false;
  const task = value as CompanionTask;
  return typeof task.id === 'string' && typeof task.goal === 'string' && typeof task.tenantId === 'string'
    && typeof task.projectBindingId === 'string' && typeof task.taskKey === 'string' && /^[a-f0-9]{64}$/.test(task.packetDigest)
    && ['draft', 'assigned', 'handoff-intent', 'cancel-requested', 'reported', 'verified', 'needs-attention'].includes(task.state)
    && Array.isArray(task.acceptance) && task.acceptance.every(item => typeof item === 'string')
    && Array.isArray(task.capabilityIds) && task.capabilityIds.every(item => typeof item === 'string')
    && Array.isArray(task.attempts) && task.attempts.every(item => !!item && typeof item.id === 'string' && !!item.assignee && typeof item.assignee.provider === 'string' && typeof item.assignee.accountId === 'string' && typeof item.assignee.agentId === 'string')
    && Array.isArray(task.reports) && task.reports.every(item => !!item && typeof item.id === 'string' && typeof item.result === 'string' && typeof item.resultDigest === 'string' && typeof item.report === 'string')
    && Array.isArray(task.verifications) && task.verifications.every(item => !!item && typeof item.id === 'string' && !!item.reviewer)
    && Array.isArray(task.events) && task.events.every(item => !!item && typeof item.type === 'string')
    && (task.notification === null || !!task.notification && typeof task.notification.eventId === 'string' && ['pending', 'acknowledged'].includes(task.notification.state));
}
export const coordinationQuery: QueryDef<CoordinationResponse> = {
  key: COORDINATION_KEY,
  async fetch(signal) {
    const result = decodeCompanionWire(await apiGet<unknown>(COORDINATION_PATH, signal)) as CoordinationResponse;
    if (!result || result.schemaVersion !== 1 || result.planningOnly !== true || result.transport !== 'unavailable'
      || !['healthy', 'missing', 'degraded'].includes(result.sourceState)
      || !(result.revision === null || Number.isSafeInteger(result.revision) && result.revision >= 0)
      || result.routing !== undefined && (!Array.isArray(result.routing) || !result.routing.every(row => !!row && typeof row.taskId === 'string' && Array.isArray(row.candidates) && row.candidates.every(candidate => !!candidate && typeof candidate.profileId === 'string' && typeof candidate.localAssignmentEligible === 'boolean' && candidate.executionEligible === false && Array.isArray(candidate.reasons) && candidate.reasons.every(reason => typeof reason === 'string'))))
      || !Array.isArray(result.packetDestinations) || !result.packetDestinations.every(item => !!item && typeof item.taskId === 'string' && !!item.identity && typeof item.identity.provider === 'string' && typeof item.identity.accountId === 'string' && typeof item.identity.agentId === 'string')
      || !Array.isArray(result.tasks) || !result.tasks.every(validTask)
      || new Set(result.tasks.map(task => task.id)).size !== result.tasks.length) throw new Error('Local coordination records are incompatible. Refresh or update Phantom.');
    return result;
  },
};
export async function recordCoordination(command: CompanionCommand): Promise<CompanionWrite> {
  const result = decodeCompanionWire(await write<unknown>(COORDINATION_PATH, projectCompanionWire(command))) as CompanionWrite;
  invalidate(COORDINATION_KEY);
  if (!result || result.dispatchAuthorized !== false || typeof result.ok !== 'boolean'
    || result.ok && (!validTask(result.task) || result.taskId !== result.task.id || !Number.isSafeInteger(result.revision))) {
    throw new Error('The local record could not be confirmed. Retry the same command or refresh before continuing.');
  }
  return result;
}

export interface CoordinationPacketInput extends Omit<CompanionTaskInput, 'packetDigest'> { profileId: string }
export async function prepareCoordinationPacket(input: CoordinationPacketInput): Promise<string> {
  const result = decodeCompanionWire(await write<unknown>(`${COORDINATION_PATH}/packet`, input)) as { packetDigest: string; dispatchAuthorized: false };
  if (result?.dispatchAuthorized !== false || !/^[a-f0-9]{64}$/.test(result.packetDigest)) throw new Error('The local evidence packet could not be confirmed. No task was created.');
  return result.packetDigest;
}

export type GrokBotHandoffRequest = GrokHandoffPreviewRequest;
export type GrokBotHandoffPreview = GrokHandoffPreviewResponse;
const HANDOFF_KEYS = ['schemaVersion', 'taskId', 'attemptId', 'epoch', 'revision', 'profileId', 'profileVersion',
  'packetDigest', 'previewDigest', 'briefText', 'dispatchAuthorized', 'contextShared', 'transport'];
const HASH = /^[a-f0-9]{64}$/;
function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw new DOMException('Aborted', 'AbortError'); }
/** A projection POST, not a ledger mutation: do not invalidate or queue a handoff. */
export async function fetchGrokBotHandoffPreview(request: GrokBotHandoffRequest, packetDigest: string, signal: AbortSignal): Promise<GrokBotHandoffPreview> {
  throwIfAborted(signal);
  if (!validGrokHandoffPreviewRequest(request) || !HASH.test(packetDigest)) throw new Error('Use a current Grok Bot handoff intent.');
  const token = getMutationToken();
  if (!token) throw new VerseMutationLockedError();
  const stillHeld = () => { throwIfAborted(signal); if (getMutationToken() !== token) throw new VerseMutationLockedError(); };
  const value = decodeCompanionWire(await apiPost<unknown>(`${COORDINATION_PATH}/handoff-preview`, projectCompanionWire(request), token, signal));
  stillHeld();
  const refused = () => new Error('The exact Grok Bot brief could not be confirmed. Refresh coordination and review again.');
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== HANDOFF_KEYS.length || HANDOFF_KEYS.some(key => !Object.hasOwn(value, key))) throw refused();
  const preview = value as GrokBotHandoffPreview;
  if (preview.schemaVersion !== 1 || preview.taskId !== request.taskId || preview.attemptId !== request.attemptId
    || preview.epoch !== request.epoch || preview.revision !== request.expectedRevision || preview.profileId !== request.profileId
    || preview.profileVersion !== request.expectedProfileVersion || preview.packetDigest !== packetDigest
    || !HASH.test(preview.packetDigest) || typeof preview.previewDigest !== 'string' || !HASH.test(preview.previewDigest) || preview.dispatchAuthorized !== false
    || preview.contextShared !== false || preview.transport !== 'manual-copy' || typeof preview.briefText !== 'string'
    || !preview.briefText.trim() || new TextEncoder().encode(preview.briefText).length > GROK_HANDOFF_PREVIEW_MAX_BYTES
    || request.expectedPreviewDigest !== undefined && preview.previewDigest !== request.expectedPreviewDigest) throw refused();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(preview.briefText));
  stillHeld();
  if (Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') !== preview.previewDigest) throw refused();
  stillHeld(); touchMutationHold(); stillHeld();
  return preview;
}
