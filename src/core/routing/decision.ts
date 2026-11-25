import { performance } from 'node:perf_hooks';
import { candidateDecision, defaultRouteBackends, routeModelsDisabled, type RouteBackend } from './decision-backends.js';
import { enumerateRouteCandidates, rankRouteCandidates, type RouteSources } from './decision-candidates.js';
import { routeDecisionSchema, routeRequestSchema, type RouteReason, type RouteReport } from './decision-schema.js';
import { decidePairing } from './pairing.js';
import { compareSpendPriority } from './reset-pressure.js';

/** The deadline covers all model stages together, including clients that ignore cancellation. */
export async function decideRoute(raw: unknown, sources: RouteSources, options: {
  backends?: readonly RouteBackend[]; signal?: AbortSignal; nowMs?: number;
} = {}): Promise<RouteReport | ReturnType<typeof decidePairing>> {
  const started = performance.now();
  const request = routeRequestSchema.parse(raw);
  const local_models_refused: RouteReport['local_models_refused'] = [];
  const nowMs = options.nowMs ?? Date.now();
  const candidates = rankRouteCandidates(request, enumerateRouteCandidates(request, sources, local_models_refused), nowMs, sources.familyYield);
  if (request.mode === 'fusion') return decidePairing(candidates.map(c => ({
    lane: c.lane, model: c.model, mode_tier: c.mode_tier,
    laneClass: c.mode_tier === 'ultra' ? 'frontier' : 'cheap', available: true,
    pool: c.capacity ?? { pool: c.lane, resetAt: null, remainingPercent: null },
  })), nowMs);
  const reasons: RouteReason[] = [];
  let attempts = 0, retried = false;
  const report = (decision: ReturnType<typeof candidateDecision>, path: RouteReport['path']): RouteReport => ({
    ...routeDecisionSchema.parse(decision), requested_mode: request.mode ?? null, schema: 'route.decision.v1', advisory: true, path,
    capacity: candidates.find(c => c.lane === decision.lane)?.capacity ?? null,
    ...(() => { const label = candidates.find(c => c.lane === decision.lane)?.seat_label; return label ? { seat_label: label } : {}; })(),
    duration_ms: Math.round(performance.now() - started), attempts, candidate_count: candidates.length, local_models_refused,
  });
  const fallback = (): RouteReport => report(candidates[0] ? {
    ...candidateDecision(candidates[0]), reason_codes: [...new Set([...reasons, 'deterministic-fallback' as const])],
  } : { lane: null, model: null, mode_tier: null, effort: null, speed_tier: null,
    reason_codes: [request.machine_state.admit ? 'no-candidates' : 'admission-blocked'] }, 'fallback');
  if (candidates.length === 0) return fallback();
  if (request.mode) {
    const selected = candidates[0]!;
    const pool = selected.capacity;
    const reason: RouteReason = pool && (pool.remainingPercent ?? 0) > 0 && pool.resetAt !== null && Date.parse(pool.resetAt) > nowMs
      ? 'reset-pressure' : pool?.costPerMTok === 0 ? 'free-capacity' : pool?.costPerMTok != null ? 'cheapest' : 'cost-prior';
    return report({ ...candidateDecision(selected), reason_codes: ['mode-tier', reason] }, 'fallback');
  }
  if (candidates.length === 1) return report({ ...candidateDecision(candidates[0]!), reason_codes: ['single-candidate'] }, 'fallback');
  if (routeModelsDisabled() || options.signal?.aborted) { reasons.push('backend-unavailable'); return fallback(); }

  for (const backend of options.backends ?? defaultRouteBackends()) {
    let retry = false;
    do {
      const remaining = 450 - (performance.now() - started);
      if (remaining <= 0 || options.signal?.aborted) { reasons.push('deadline'); return fallback(); }
      const timeoutMs = Math.min(remaining, backend.name === 'jev' ? 120 : 100);
      const controller = new AbortController();
      const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        attempts++;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error('deadline')); }, timeoutMs);
        });
        const output = await Promise.race([backend.ask({ request, candidates, retry, signal, timeoutMs }), deadline]);
        const parsed = routeDecisionSchema.safeParse(output);
        const selected = parsed.success && candidates.find(c => compareSpendPriority(c.capacity, candidates[0]!.capacity, nowMs) === 0 &&
          c.lane === parsed.data.lane && c.model === parsed.data.model
          && c.mode_tier === parsed.data.mode_tier && c.effort === parsed.data.effort && c.speed_tier === parsed.data.speed_tier);
        if (selected) return report({ ...candidateDecision(selected), reason_codes: [...new Set([...reasons, backend.name])] }, backend.name);
        reasons.push('schema-invalid');
        if (!retried) { retried = true; retry = true; reasons.push('schema-retry'); }
        else { retry = false; }
      } catch {
        reasons.push(controller.signal.aborted ? 'deadline' : 'backend-unavailable');
        // Network, throttling and timeout failures never trigger extra paid calls.
        return fallback();
      } finally { clearTimeout(timer); controller.abort(); }
    } while (retry);
  }
  return fallback();
}
