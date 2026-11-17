/** Check registry IDs against the provider pages already recorded in the registry. */
import { loadVerifiedRegistry } from './model-verify.js';

export type ModelDocsStatus = 'confirmed' | 'not-found' | 'unknown';
export interface ModelDocsResult {
  id: string;
  provider: string;
  status: ModelDocsStatus;
  sourceUrl: string | null;
  checkedAt: string;
}

export async function verifyModelDocs(options: {
  registryPath?: string | URL;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
} = {}): Promise<ModelDocsResult[]> {
  const entries = await loadVerifiedRegistry({ registryPath: options.registryPath, now: () => (options.now ?? (() => new Date()))().getTime() });
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  const fetcher = options.fetch ?? fetch;
  const pages = new Map<string, Promise<string | null>>();
  for (const entry of entries) {
    const source = entry.verified_source;
    if (source === null) continue;
    if (!pages.has(source)) pages.set(source, (async () => {
      try {
        const response = await fetcher(source, { signal: AbortSignal.timeout(options.timeoutMs ?? 10_000), redirect: 'error', credentials: 'omit' });
        if (!response.ok) return null;
        if (!response.body) return null;
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 2_000_000) { await reader.cancel(); return null; }
          chunks.push(value);
        }
        return Buffer.concat(chunks).toString('utf8');
      } catch { return null; }
    })());
  }
  return Promise.all(entries.map(async entry => {
    const page = entry.verified_source === null ? null : await pages.get(entry.verified_source)!;
    const escaped = entry.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const found = page !== null && new RegExp(`(^|[^a-z0-9._:/-])${escaped}($|[^a-z0-9._:/-])`, 'i').test(page);
    return { id: entry.id, provider: entry.provider, status: page === null ? 'unknown' : found ? 'confirmed' : 'not-found', sourceUrl: entry.verified_source, checkedAt };
  }));
}
