import { decide } from '../decide/decide.js';
import { classifierKilledByEnv, jevKilledByEnv, readJevConfig } from '../decide/ledger.js';
import { buildOpenAICompatibleClient } from '../run/provider-client.js';
import type { RouteCandidate, RouteDecision, RouteRequest } from './decision-schema.js';

export interface RouteBackendInput {
  request: RouteRequest;
  candidates: readonly RouteCandidate[];
  retry: boolean;
  signal: AbortSignal;
  timeoutMs: number;
}
export interface RouteBackend {
  name: 'local-fast' | 'jev' | 'local-strong';
  ask(input: RouteBackendInput): Promise<unknown>;
}
export const candidateDecision = (c: RouteCandidate): RouteDecision => ({
  lane: c.lane, model: c.model, effort: c.effort, speed_tier: c.speed_tier, reason_codes: ['adequate-tier'],
});

export function routeModelsDisabled(): boolean {
  return classifierKilledByEnv() || jevKilledByEnv();
}

function localBackend(model: 'fast' | 'strong'): RouteBackend {
  return {
    name: model === 'fast' ? 'local-fast' : 'local-strong',
    async ask(input) {
      if (routeModelsDisabled()) throw new Error('Decision backend disabled');
      const client = buildOpenAICompatibleClient('http://127.0.0.1:8123/v1', '', model, false, 0, input.signal, {
        strictStreaming: { expectedModel: model, disableThinking: true }, redirect: 'error', timeoutMs: input.timeoutMs,
        maxRequestBytes: 32 * 1024, maxResponseBytes: 16 * 1024, maxOutputTokens: 160,
      });
      const response = await client.chatStream!([
        { role: 'system', content: 'Select the cheapest, fastest adequate route from the supplied candidates. Return ONLY one candidate decision as a JSON object with lane, model, effort, speed_tier, reason_codes:["adequate-tier"]. No tools or authority. /no_think' },
        // No repository identifiers, prompt bodies, account names or raw machine telemetry leave this projection.
        { role: 'user', content: JSON.stringify({ task_class: input.request.task_class, tier: input.request.tier_hint,
          candidates: input.candidates.map(candidateDecision), retry: input.retry }) },
      ], undefined, () => {}, input.signal);
      try { return JSON.parse(response.content); } catch { return null; }
    },
  };
}

/** Existing Jev transport owns credentials, call budget, confidence and accounting. */
const jevBackend: RouteBackend = {
  name: 'jev',
  async ask(input) {
    if (routeModelsDisabled() || !readJevConfig().enabled) throw new Error('Decision backend disabled');
    const criteria = Object.fromEntries(input.candidates.map((c, i) => [`c${i}`, JSON.stringify({
      speed_tier: c.speed_tier, cost_rank: c.cost_rank, latency_rank: c.latency_rank,
    })]));
    const result = await decide<string | null>('resource-choice', JSON.stringify({
      task_class: input.request.task_class, tier: input.request.tier_hint,
    }), { resource_choice: { type: 'choice', instructions: 'Choose the cheapest, fastest adequate candidate from this already eligible set.', criteria } }, {
      fallback: null, signal: input.signal, timeoutMs: input.timeoutMs,
      cacheSalt: JSON.stringify(input.candidates),
    });
    if (result.path !== 'jev') {
      if (['no-answer', 'malformed-response'].includes(result.reason ?? '')) return null;
      throw new Error('Decision backend unavailable');
    }
    const index = input.candidates.findIndex((_, i) => result.value === `c${i}`);
    return index < 0 ? null : candidateDecision(input.candidates[index]!);
  },
};

export function defaultRouteBackends(): RouteBackend[] { return [localBackend('fast'), jevBackend, localBackend('strong')]; }
