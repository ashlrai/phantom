/** Operator-only local coordination. No endpoint contacts a provider, imports context or changes authority. */
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import { ensurePrivateDirectory } from './preferences.js';
import type { ApiModule } from './api-modules.js';
import { createCompanionCoordinator } from '../proactive/coordination.js';
import { companionIdentityEqual, companionTaskId, type CompanionCommand, type CompanionCoordinator } from '../proactive/coordination-types.js';
import { getProactiveProfilesStore, type ProactiveProfilesStore } from '../proactive/profiles.js';
import { VERSE_PROACTIVE_AGENTS_PATH } from '../proactive/types.js';
import { buildScopedCompanionPacket } from '../proactive/packets.js';
import { readPreparedCompanionPacket, savePreparedCompanionPacket } from '../proactive/packet-store.js';
import { decodeCompanionWire, projectCompanionWire } from '../proactive/coordination-wire.js';
import { rankCompanionCandidates } from '../proactive/planning.js';
import { companionDigestToReference } from '../proactive/coordination-wire.js';
import { companionDigest } from '../proactive/coordination-types.js';
import { taskContextTimestamp } from '../context/task-temporal-context.js';

export const PROACTIVE_COORDINATION_PATH = `${VERSE_PROACTIVE_AGENTS_PATH}/coordination`;
interface Dependencies {
  coordinator?: () => CompanionCoordinator; profiles?: () => ProactiveProfilesStore;
  packetRoot?: () => string; now?: () => Date;
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function createProactiveCoordinationApi(deps: Dependencies = {}): ApiModule {
  const profiles = deps.profiles ?? getProactiveProfilesStore;
  const root = deps.packetRoot ?? ashlrHome;
  const coordinator = deps.coordinator ?? (() => createCompanionCoordinator({ directory: join(ashlrHome(), 'proactive-coordination') }));
  const now = deps.now ?? (() => new Date());
  return async (ctx, req, res, path, method) => {
    if (path !== PROACTIVE_COORDINATION_PATH && path !== `${PROACTIVE_COORDINATION_PATH}/packet`) return false;
    const reply = (status: number, value: unknown) => sendJson(res, status, projectCompanionWire(value));
    try {
      if (new URL(req.url ?? path, 'http://localhost').search) { reply(400, { error: 'Query parameters are not supported.' }); return true; }
      if (!['GET', 'POST'].includes(method) || method === 'GET' && path.endsWith('/packet')) { reply(404, { error: 'not found' }); return true; }
      if (method === 'POST') {
        if (!ctx.allowDispatch) { reply(404, { error: 'not found' }); return true; }
        if (!passesMutationGate(req, res, ctx.token)) return true;
      }
      const host = coordinator();
      if (method === 'GET') {
        const listing = host.list();
        const saved = (await profiles().list()).profiles;
        reply(200, { schemaVersion: 1, ...listing, planningOnly: true, transport: 'unavailable',
          packetDestinations: listing.tasks.flatMap(task => {
            const packet = readPreparedCompanionPacket(root(), task.packetDigest);
            return packet ? [{ taskId: task.id, identity: packet.allowedDestination }] : [];
          }),
          routing: listing.tasks.map(task => ({ taskId: task.id, candidates: rankCompanionCandidates(task, saved, listing.tasks) })) });
        return true;
      }
      let raw: string;
      try { raw = await readBody(req, 64 * 1024); }
      catch { reply(413, { error: 'Coordination request is too large.' }); return true; }
      let value: unknown;
      try { value = decodeCompanionWire(JSON.parse(raw)); }
      catch { reply(400, { error: 'Use a JSON object.' }); return true; }
      if (!object(value)) { reply(400, { error: 'Use a JSON object.' }); return true; }
      if (path.endsWith('/packet')) {
        const keys = ['tenantId', 'projectBindingId', 'taskKey', 'goal', 'acceptance', 'capabilityIds', 'profileId', 'deadline', 'maxCostUsd', 'maxAttempts'];
        if (Object.keys(value).some(key => !keys.includes(key)) || typeof value.profileId !== 'string'
          || !Array.isArray(value.capabilityIds) || value.capabilityIds.some(id => typeof id !== 'string')) {
          reply(400, { error: 'Use a scoped goal and one configured recipient.' }); return true;
        }
        const profile = (await profiles().list()).profiles.find(profile => profile.id === value.profileId);
        if (!profile || !profile.enabled || value.capabilityIds.some(id => !profile.capabilityIds.includes(id as string))) {
          reply(409, { error: 'The configured recipient does not declare the requested capabilities.' }); return true;
        }
        const taskId = companionTaskId(value as unknown as { tenantId: string; projectBindingId: string; taskKey: string });
        const { packet, digest } = buildScopedCompanionPacket({
          tenantId: value.tenantId as string, projectBindingId: value.projectBindingId as string, taskId,
          goal: value.goal as string, acceptance: value.acceptance as string[], accountRefs: [], allowedDestination: profile.identity,
          artifact: { artifactRef: `phantom:local-brief:${taskId}`,
            revision: companionDigestToReference(companionDigest({ goal: value.goal, acceptance: value.acceptance,
              tenantId: value.tenantId, projectBindingId: value.projectBindingId, destination: profile.identity,
              deadline: value.deadline ?? null, maxCostUsd: value.maxCostUsd ?? null, maxAttempts: value.maxAttempts ?? 1 })) },
          evidence: [], asOf: now().toISOString(),
          coverage: { sourceState: 'missing', complete: false, stopReasons: ['No source evidence has been imported.'] },
          deadline: value.deadline as string | null ?? null,
          limits: { maxCostUsd: value.maxCostUsd as number | null ?? null, maxAttempts: value.maxAttempts as number ?? 1, maxContextBytes: 32 * 1024 },
        }, { tenantId: value.tenantId as string, projectBindingId: value.projectBindingId as string, taskId,
          accountRefs: [], allowedDestination: profile.identity,
          // This endpoint builds only an operator-authored local brief with zero upstream data.
          stillAuthorized: packet => packet.evidence.length === 0 && packet.accountRefs.length === 0 });
        const latest = (await profiles().list()).profiles.find(value => value.id === profile.id);
        if (!latest || latest.version !== profile.version) { reply(409, { error: 'Recipient changed; review the brief again.' }); return true; }
        ensurePrivateDirectory(root());
        const saved = savePreparedCompanionPacket(root(), packet, () => true);
        if (!['recorded', 'replayed'].includes(saved)) { reply(503, { error: 'The local brief could not be saved.' }); return true; }
        reply(200, { packetDigest: digest, packet, dispatchAuthorized: false, contextShared: false }); return true;
      }
      const command = value as unknown as CompanionCommand;
      const replay = host.replay(command);
      if (replay) {
        reply(replay.ok ? 200 : replay.reason === 'invalid' ? 400 : replay.reason === 'unavailable' ? 503 : 409, replay);
        return true;
      }
      if (command.kind === 'create') {
        if (!object(command.task)) { reply(400, { error: 'A scoped task is required.' }); return true; }
        const packet = readPreparedCompanionPacket(root(), command.task.packetDigest);
        if (!packet || packet.taskId !== companionTaskId(command.task) || packet.tenantId !== command.task.tenantId
          || packet.projectBindingId !== command.task.projectBindingId || packet.goal !== command.task.goal
          || JSON.stringify(packet.acceptance) !== JSON.stringify(command.task.acceptance)
          || packet.deadline !== (command.task.deadline == null ? null : taskContextTimestamp(command.task.deadline))
          || packet.limits.maxCostUsd !== (command.task.maxCostUsd ?? null)
          || packet.limits.maxAttempts !== (command.task.maxAttempts ?? 1)) {
          reply(409, { error: 'Prepare and review the exact local brief before creating this task.' }); return true;
        }
      } else if (command.kind === 'assign' || command.kind === 'handoff') {
        const read = host.read(command.taskId);
        const packet = read.task ? readPreparedCompanionPacket(root(), read.task.packetDigest) : null;
        const identity = command.kind === 'assign' ? command.assignee : read.task?.attempts.at(-1)?.assignee;
        const listing = host.list();
        const saved = (await profiles().list()).profiles;
        const profile = saved.find(profile => identity && companionIdentityEqual(profile.identity, identity));
        if (!read.task || !packet || !profile || !identity || !companionIdentityEqual(packet.allowedDestination, identity)
          || command.kind === 'assign' && !rankCompanionCandidates(read.task, saved, listing.tasks).find(row => row.profileId === profile.id)?.localAssignmentEligible
          || command.kind === 'handoff' && (!profile.enabled || read.task.capabilityIds.some(id => !profile.capabilityIds.includes(id))
            || profile.preferences.projectBindingIds.length > 0 && !profile.preferences.projectBindingIds.includes(read.task.projectBindingId))) {
          reply(409, { error: 'Assignment must match the reviewed brief and current recipient preferences.' }); return true;
        }
      }
      const result = host.execute(command);
      reply(result.ok ? 200 : result.reason === 'invalid' ? 400 : result.reason === 'unavailable' ? 503 : 409, result);
      return true;
    } catch (error) {
      if (error instanceof Error && ['Invalid companion evidence packet.', 'Companion packet scope is not authorized.',
        'Companion packet scope is no longer authorized.'].includes(error.message)) {
        reply(400, { error: 'Use a valid local goal, acceptance criteria, scope and planning limits.' }); return true;
      }
      reply(503, { error: 'Local coordination is unavailable; existing records were preserved.' }); return true;
    }
  };
}
export const handleProactiveCoordinationApi = createProactiveCoordinationApi();
