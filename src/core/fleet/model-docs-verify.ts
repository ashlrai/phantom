/** Check registry IDs against the provider pages already recorded in the registry. */
import { readFile } from 'node:fs/promises';
import type { ModelRegistryEntry } from './model-verify.js';

export type ModelDocsStatus = 'confirmed' | 'not-found' | 'unknown';
export interface ModelDocsResult {
  id: string;
  provider: string;
  status: ModelDocsStatus;
  sourceUrl: string;
  checkedAt: string;
}

export async function verifyModelDocs(options: {
  registryPath?: string | URL;
  fetch?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
} = {}): Promise<ModelDocsResult[]> {
  const registry: unknown = JSON.parse(await readFile(options.registryPath ?? new URL('../../../docs/model-registry.json', import.meta.url), 'utf8'));
  if (!Array.isArray(registry)) throw new Error('Invalid model registry');
  const entries: ModelRegistryEntry[] = registry.map((row: unknown) => {
    if (!row || typeof row !== 'object') throw new Error('Invalid model registry');
    const entry = row as Partial<ModelRegistryEntry>;
    if (typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/i.test(entry.id)
      || typeof entry.provider !== 'string' || typeof entry.docs_url !== 'string') throw new Error('Invalid model registry');
    const url = new URL(entry.docs_url);
    const domains: Record<string, string[]> = { openai: ['learn.chatgpt.com'], anthropic: ['platform.claude.com'] };
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !domains[entry.provider]?.includes(url.hostname)) throw new Error('Invalid model source');
    return entry as ModelRegistryEntry;
  });
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  const fetcher = options.fetch ?? fetch;
  const pages = new Map<string, Promise<string | null>>();
  for (const entry of entries) {
    if (!pages.has(entry.docs_url)) pages.set(entry.docs_url, (async () => {
      try {
        const response = await fetcher(entry.docs_url, { signal: AbortSignal.timeout(options.timeoutMs ?? 10_000), redirect: 'error', credentials: 'omit' });
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
    const page = await pages.get(entry.docs_url)!;
    const escaped = entry.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const found = page !== null && new RegExp(`(^|[^a-z0-9.-])${escaped}($|[^a-z0-9.-])`, 'i').test(page);
    return { id: entry.id, provider: entry.provider, status: page === null ? 'unknown' : found ? 'confirmed' : 'not-found', sourceUrl: entry.docs_url, checkedAt };
  }));
}
