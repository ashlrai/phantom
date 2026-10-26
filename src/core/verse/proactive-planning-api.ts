/** Local evidence and offline evaluations only. Never probes accounts or contacts a model/provider. */
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';
import { VERSE_PROACTIVE_AGENTS_PATH } from '../proactive/types.js';
import { getProactiveProfilesStore, type ProactiveProfilesStore } from '../proactive/profiles.js';
import { createCompanionCoordinator } from '../proactive/coordination.js';
import type { CompanionCoordinator } from '../proactive/coordination-types.js';
import { readPreparedCompanionPacket } from '../proactive/packet-store.js';
import { projectCompanionWire, decodeCompanionWire } from '../proactive/coordination-wire.js';
import { projectProactiveResourceEvidence } from '../proactive/resource-evidence.js';
import type { ProactiveResourceEvidenceResponse } from '../proactive/resource-evidence-types.js';
import { createRoutingLab } from '../proactive/routing-lab.js';
import type { RoutingLab, RoutingLabCommand, RoutingLabTask } from '../proactive/routing-lab-types.js';
import { evaluateReleaseReadiness } from '../proactive/release-readiness.js';
import type { ReleaseReadinessHost, ReleaseReadinessInput } from '../proactive/release-readiness-types.js';

export const PROACTIVE_PLANNING_PATH = `${VERSE_PROACTIVE_AGENTS_PATH}/planning`;
interface Dependencies {
  profiles?: () => ProactiveProfilesStore; coordinator?: () => CompanionCoordinator;
  packetRoot?: () => string; labRoot?: () => string; now?: () => Date;
  /** Host-supplied public cache only. No collector or credential-read fallback. */
  resources?: () => ProactiveResourceEvidenceResponse | Promise<ProactiveResourceEvidenceResponse>;
  lab?: (resources: ProactiveResourceEvidenceResponse, resolveTask: (taskId: string) => RoutingLabTask | null) => RoutingLab;
  /** Exact host-selected target/evidence; never accepted from HTTP input. */
  releaseInput?: () => ReleaseReadinessInput | null; releaseHost?: ReleaseReadinessHost;
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function createProactivePlanningApi(deps: Dependencies = {}): ApiModule {
  const profiles = deps.profiles ?? getProactiveProfilesStore;
  const now = deps.now ?? (() => new Date());
  const root = deps.packetRoot ?? ashlrHome;
  const coordinator = deps.coordinator ?? (() => createCompanionCoordinator({ directory: join(ashlrHome(), 'proactive-coordination') }));
  const readResources = deps.resources ?? (async () => projectProactiveResourceEvidence({ profiles: (await profiles().list()).profiles }, { nowMs: now().getTime() }));
  const resolveTask = (taskId: string): RoutingLabTask | null => {
    const read = coordinator().read(taskId), task = read.task;
    const packet = task ? readPreparedCompanionPacket(root(), task.packetDigest) : null;
    if (read.sourceState === 'degraded' || !task || !packet || packet.taskId !== task.id || packet.tenantId !== task.tenantId
      || packet.projectBindingId !== task.projectBindingId) return null;
    return { taskId: task.id, tenantId: task.tenantId, projectBindingId: task.projectBindingId, packetDigest: task.packetDigest,
      capabilityIds: task.capabilityIds, accountRefs: packet.accountRefs, allowedDestination: packet.allowedDestination,
      deadline: task.deadline, maxCostUsd: task.maxCostUsd };
  };
  const lab = (resources: ProactiveResourceEvidenceResponse) => deps.lab
    ? deps.lab(resources, resolveTask) : createRoutingLab({
      directory: (deps.labRoot ?? (() => join(ashlrHome(), 'proactive-routing-lab')))(), now,
      resources: () => resources, resolveTask,
    });
  return async (ctx, req, res, path, method) => {
    if (![PROACTIVE_PLANNING_PATH, `${PROACTIVE_PLANNING_PATH}/resources`, `${PROACTIVE_PLANNING_PATH}/release`].includes(path)) return false;
    const reply = (status: number, value: unknown) => sendJson(res, status, projectCompanionWire(value));
    try {
      if (new URL(req.url ?? path, 'http://localhost').search) { reply(400, { error: 'Query parameters are not supported.' }); return true; }
      if (method !== 'GET' && method !== 'POST' || method === 'POST' && path !== PROACTIVE_PLANNING_PATH) { reply(404, { error: 'not found' }); return true; }
      if (method === 'POST') {
        if (!ctx.allowDispatch) { reply(404, { error: 'not found' }); return true; }
        if (!passesMutationGate(req, res, ctx.token)) return true;
      }
      if (path.endsWith('/release')) {
        const input = deps.releaseInput?.() ?? null;
        reply(200, { schemaVersion: 1, sourceState: input ? 'snapshot' : 'missing',
          readiness: input ? evaluateReleaseReadiness(input, deps.releaseHost) : null,
          notes: input ? [] : ['No exact commissioned release target has been supplied.'], releaseAuthorized: false });
        return true;
      }
      if (path.endsWith('/resources')) { reply(200, await readResources()); return true; }
      // Listing persisted receipts does not need fresh resource observations.
      if (method === 'GET') {
        const missing = projectProactiveResourceEvidence({}, { nowMs: now().getTime() });
        reply(200, lab(missing).list()); return true;
      }
      let raw: string;
      try { raw = await readBody(req, 32 * 1024); }
      catch { reply(413, { error: 'Planning request is too large.' }); return true; }
      let value: unknown;
      try { value = decodeCompanionWire(JSON.parse(raw)); }
      catch { reply(400, { error: 'Use a JSON object.' }); return true; }
      if (!object(value)) { reply(400, { error: 'Use a JSON object.' }); return true; }
      if (value.kind === 'preview') {
        if (Object.keys(value).some(key => !['kind', 'requestId', 'expectedRevision', 'taskId'].includes(key)) || typeof value.taskId !== 'string') {
          reply(400, { error: 'Select one saved scoped task.' }); return true;
        }
      }
      const command = value as unknown as RoutingLabCommand;
      // Replay precedes resource reads so a retry cannot accidentally sample a different resource state.
      const empty = projectProactiveResourceEvidence({}, { nowMs: now().getTime() });
      const receipt = lab(empty).replay(command);
      const status = (result: Awaited<ReturnType<RoutingLab['execute']>>) => result.ok ? 200 : result.reason === 'invalid' ? 400 : result.reason === 'unavailable' ? 503 : 409;
      if (receipt) { reply(status(receipt), receipt); return true; }
      const resources = command.kind === 'preview' ? await readResources() : empty;
      const abort = new AbortController();
      const onAbort = () => abort.abort();
      req.once('aborted', onAbort); res.once?.('close', onAbort);
      try {
        if (req.aborted || res.destroyed) abort.abort();
        const result = await lab(resources).execute(command, { signal: abort.signal, timeBudgetMs: 5000 });
        if (!res.destroyed) reply(status(result), result);
      } finally { req.off('aborted', onAbort); res.off?.('close', onAbort); }
      return true;
    } catch {
      if (!res.headersSent) reply(503, { error: 'Local planning is unavailable; existing receipts were preserved.' });
      return true;
    }
  };
}
export const handleProactivePlanningApi = createProactivePlanningApi();
