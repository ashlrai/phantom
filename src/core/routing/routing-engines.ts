import { parseLocalInferenceConfig } from '../run/local-inference.js';
import type { AshlrConfig } from '../types.js';
import type { LocalRouteContext } from './local-route.js';

/**
 * The routing `ctx.engines` map, built from config. Only id, endpoint and tier
 * are projected: no envKey, key or other credential field enters routing.
 * The configured local inference endpoint is listed under 'openai-compat' so a
 * loopback seat classifies as local; config engines with an api endpoint list
 * it, so a custom loopback engine is local and an unknown id stays unclassified.
 */
export function routingEnginesFromConfig(cfg: AshlrConfig): NonNullable<LocalRouteContext['engines']> {
  const out: Record<string, { baseUrl?: string; tier?: string }> = {};
  try {
    const engines = (cfg as { engines?: Record<string, { tier?: unknown; api?: { defaultBaseUrl?: unknown } }> }).engines ?? {};
    for (const [id, spec] of Object.entries(engines)) {
      if (!spec || typeof spec !== 'object') continue;
      const baseUrl = typeof spec.api?.defaultBaseUrl === 'string' ? spec.api.defaultBaseUrl : undefined;
      const tier = typeof spec.tier === 'string' ? spec.tier : undefined;
      out[id] = { ...(baseUrl ? { baseUrl } : {}), ...(tier ? { tier } : {}) };
    }
    const parsed = parseLocalInferenceConfig((cfg as unknown as Record<string, unknown>)['localInference']);
    if (parsed.ok && parsed.config && parsed.config.loopback) out['openai-compat'] = { baseUrl: parsed.config.baseUrl, tier: 'local' };
  } catch { /* fail closed: unlisted ids are unclassified */ }
  return out;
}
