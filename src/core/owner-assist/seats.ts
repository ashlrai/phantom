import type { AshlrConfig } from '../types.js';
import { discoverSeats, type VerseSeatDiscovery } from '../verse/seats.js';
import { discoverLocalHarness } from '../verse/local-harness.js';
import type { VerseSeat } from '../verse/types.js';

/** Read-only oMLX metadata, numeric loopback only. Never loads or downloads a model. */
export async function discoverOwnerOmlx(port: number, fetchImpl = fetch): Promise<VerseSeat[]> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return [];
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
    if (!response.ok || !response.body) { await response.body?.cancel(); return []; }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        length += next.value.length; if (length > 128 * 1024) return [];
        chunks.push(next.value);
      }
    } finally { await reader.cancel(); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { data?: unknown[] };
    if (!Array.isArray(body.data)) return [];
    return body.data.slice(0, 100).flatMap(row => {
      if (!row || typeof row !== 'object') return [];
      const m = row as Record<string, unknown>;
      // These Qwen chat templates are supported by oMLX's tool parser; no embeddings/drafters.
      if (m.owned_by !== 'omlx' || typeof m.id !== 'string' || !/^[\w./:-]{1,160}$/.test(m.id)
        || !/qwen(?:2\.5-coder|3)/i.test(m.id) || /embed|rerank|draft/i.test(m.id)) return [];
      const contextWindow = typeof m.max_model_len === 'number' && Number.isSafeInteger(m.max_model_len) && m.max_model_len > 0 ? m.max_model_len : null;
      return [{ id: `local:omlx:${port}:${m.id}`, engine: 'local' as const, accountId: 'local', label: `oMLX · ${m.id}`,
        models: [{ id: m.id, label: m.id, contextWindow, windowSource: contextWindow ? 'runtime' as const : 'fallback' as const }],
        contextWindow, health: { state: 'ready' as const, summary: 'Advertised by local oMLX; tool behavior depends on the model template.', windows: [], observedAt: new Date().toISOString() } }];
    }).sort((a, b) => {
      const preferred = (s: VerseSeat) => Number(s.models[0]?.id.match(/(?:-|:)(\d+(?:\.\d+)?)b/i)?.[1] ?? 0) >= 27 ? 1 : 0;
      return preferred(b) - preferred(a);
    });
  } catch { return []; }
}

/** Existing seats plus provisioned oMLX. Only the existing Claude tool harness executes. */
export async function discoverOwnerSeats(cfg: AshlrConfig, port = 8000): Promise<VerseSeatDiscovery> {
  const [base, omlx, harness] = await Promise.all([discoverSeats(cfg), discoverOwnerOmlx(port), discoverLocalHarness()]);
  if (!harness.executable) return base;
  const launches = new Map(base.launches);
  for (const seat of omlx) launches.set(seat.id, { seat, launcher: null,
    ollamaBaseUrl: `http://127.0.0.1:${port}`, anthropicBaseUrl: `http://127.0.0.1:${port}` });
  return { ...base, seats: [...omlx, ...base.seats], launches };
}
