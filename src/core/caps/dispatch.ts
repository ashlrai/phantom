/** OS-1 routing is data only. A plan never launches a surface or grants authority. */
import { BUILTIN_ENGINE_REGISTRY } from '../run/engine-registry.js';
import { resolveSurfaceModelPair, type CapsPair } from './registry.js';
import type { CapsRegistry } from './schema.js';

export type SurfaceDispatch =
  | { ok: true; pair: CapsPair; adapter: 'engine'; engine: string; model: string; transport: 'cli-agent' | 'api-model' }
  | { ok: true; pair: CapsPair; adapter: 'hosted'; model: string; hops: Array<{ host: string; guest: string; via: string }> }
  | { ok: false; reason: string };

type Adapter = (reg: CapsRegistry, pair: CapsPair) => SurfaceDispatch;
const ADAPTERS = Object.freeze<Record<'engine' | 'hosted' | 'unavailable', Adapter>>({
  engine: (reg, pair) => {
    const surface = reg.surfaces.find(s => s.id === pair.surface)!;
    const model = reg.models.find(m => m.id === pair.model)!;
    const spec = surface.engine && Object.hasOwn(BUILTIN_ENGINE_REGISTRY, surface.engine)
      ? BUILTIN_ENGINE_REGISTRY[surface.engine] : undefined;
    if (!spec || spec.kind === 'builtin') return { ok: false, reason: 'Surface has no execution engine.' };
    // A shared quota lane does not imply that two engines accept the same model.
    if (model.catalogId !== null && model.catalogId.slice(0, model.catalogId.indexOf(':')) !== surface.engine) {
      return { ok: false, reason: 'Model catalog engine does not match the selected surface engine.' };
    }
    return { ok: true, pair, adapter: 'engine', engine: surface.engine!, model: model.providerModelId, transport: spec.kind };
  },
  hosted: (reg, pair) => {
    const path = [...pair.via, pair.surface];
    const hops = path.slice(0, -1).map((host, i) => reg.hosting.find(e => e.host === host && e.guest === path[i + 1])!);
    if (!hops.length || hops.some(h => !h)) return { ok: false, reason: 'Hosted surface has no execution path.' };
    return { ok: true, pair, adapter: 'hosted', model: reg.models.find(m => m.id === pair.model)!.providerModelId,
      hops: hops.map(({ host, guest, via }) => ({ host, guest, via })) };
  },
  unavailable: () => ({ ok: false, reason: 'Surface has no commissioned execution adapter.' }),
});

/** Select an execution adapter by (surface, model), never by a provider branch. */
export function routeSurfaceModel(reg: CapsRegistry, surfaceId: string, modelId: string): SurfaceDispatch {
  const resolved = resolveSurfaceModelPair(reg, surfaceId, modelId);
  if (!resolved.ok) return resolved;
  const surface = reg.surfaces.find(s => s.id === surfaceId)!;
  return ADAPTERS[surface.dispatch ?? 'unavailable'](reg, resolved.pair);
}

