import { performance } from 'node:perf_hooks';
import { candidateDecision, defaultRouteBackends, routeModelsDisabled, type RouteBackend } from './decision-backends.js';
import { enumerateRouteCandidates, rankRouteCandidates, type RouteSources } from './decision-candidates.js';
import { routeDecisionSchema, routeRequestSchema, type RouteReason, type RouteReport } from './decision-schema.js';

/** The deadline covers all model stages together, including clients that ignore cancellation. */
export async function decideRoute(raw: unknown, sources: RouteSources, options: {
  backends?: readonly RouteBackend[]; signal?: AbortSignal;
} = {}): Promise<RouteReport> {
  const started = performance.now();
  const request = routeRequestSchema.parse(raw);
  const candidates = rankRouteCandidates(request, enumerateRouteCandidates(request, sources));
  const reasons: RouteReason[] = [];
  let attempts = 0, retried = false;
  const report = (decision: ReturnType<typeof candidateDecision>, path: RouteReport['path']): RouteReport => ({
    ...routeDecisionSchema.parse(decision), schema: 'route.decision.v1', advisory: true, path,
    duration_ms: Math.round(performance.now() - started), attempts, candidate_count: candidates.length,
  });
  const fallback = (): RouteReport => report(candidates[0] ? {
    ...candidateDecision(candidates[0]), reason_codes: [...new Set([...reasons, 'deterministic-fallback' as const])],
  } : { lane: null, model: null, effort: null, speed_tier: null,
    reason_codes: [request.machine_state.admit ? 'no-candidates' : 'admission-blocked'] }, 'fallback');
  if (candidates.length === 0) return fallback();
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
        const selected = parsed.success && candidates.find(c => c.lane === parsed.data.lane && c.model === parsed.data.model
          && c.effort === parsed.data.effort && c.speed_tier === parsed.data.speed_tier);
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
