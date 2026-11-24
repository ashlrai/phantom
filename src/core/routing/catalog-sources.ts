import { execFile } from 'node:child_process';
import { resolveExecutable } from '../run/tool-path.js';
import { parseDevinModelsList } from '../devin/models.js';

export interface CatalogSource { id: string; status: 'ok' | 'unknown'; models: string[]; reason?: string }
const scan = (text: string): string[] => [...new Set(text.match(/\b(?:(?:claude|gpt|grok)-(?=[a-z0-9.-]*\d)[a-z0-9.-]+|meta\/(?=[a-z0-9./_-]*\d)[a-z0-9./_-]+)/gi) ?? [])];
export const CATALOG_SOURCE_SPECS = [
  { id: 'claude', bin: 'claude', args: ['--help'], extract: scan },
  { id: 'codex', bin: 'codex', args: ['--help'], extract: scan },
  { id: 'devin', bin: 'devin', args: ['models', 'list'], extract: (s: string) => parseDevinModelsList(s).families.flatMap(f => f.models.map(m => m.id)) },
  { id: 'cursor', bin: 'cursor-agent', args: ['models'], extract: scan },
  { id: 'grok', bin: 'grok', args: ['models'], extract: scan },
];

export interface CatalogSourceDeps {
  resolve: (bin: string) => string | null;
  run: (bin: string, args: string[]) => Promise<string>;
  fetch: typeof globalThis.fetch;
  seats: () => Promise<string[]>;
}
const MAX_BYTES = 1024 * 1024;
const defaultRun: CatalogSourceDeps['run'] = (bin, args) => new Promise((resolve, reject) => {
  execFile(bin, args, { timeout: 10_000, maxBuffer: MAX_BYTES, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout));
});
async function defaultSeats(): Promise<string[]> {
  const [{ loadConfigReadOnly }, { loadRouterGatewayConfig }, { loadRouterGatewayDeps }] = await Promise.all([
    import('../config.js'), import('../router-gateway/config.js'), import('../router-gateway/deps.js'),
  ]);
  const loaded = loadRouterGatewayConfig();
  const deps = await loadRouterGatewayDeps(loadConfigReadOnly(), loaded.config);
  return (await deps.candidates()).flatMap(({ seat }) => seat.models.map(m => m.id));
}

export async function collectCatalogSources(includeSeats = false, overrides: Partial<CatalogSourceDeps> = {}, base = 'http://127.0.0.1:11434'): Promise<CatalogSource[]> {
  const deps: CatalogSourceDeps = { resolve: bin => resolveExecutable(bin)?.path ?? null, run: defaultRun, fetch: globalThis.fetch, seats: defaultSeats, ...overrides };
  const probe = async (id: string, action: () => Promise<string[]>): Promise<CatalogSource> => {
    try {
      const models = [...new Set(await action())].sort();
      if (!models.length || models.some(m => !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(m))) throw new Error();
      return { id, status: 'ok', models };
    } catch { return { id, status: 'unknown', models: [], reason: 'unavailable or unparseable source' }; }
  };
  return Promise.all([
    ...CATALOG_SOURCE_SPECS.map(spec => probe(spec.id, async () => {
      const bin = deps.resolve(spec.bin);
      if (!bin) throw new Error();
      const text = await deps.run(bin, spec.args);
      if (Buffer.byteLength(text) > MAX_BYTES) throw new Error();
      return spec.extract(text);
    })),
    probe('ollama', async () => {
      const url = new URL(base);
      if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password) throw new Error();
      const response = await deps.fetch(new URL('/api/tags', url), { signal: AbortSignal.timeout(10_000), redirect: 'error' });
      if (!response.ok || !response.body) throw new Error();
      const reader = response.body.getReader();
      let text = ''; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) throw new Error();
          text += Buffer.from(value).toString('utf8');
        }
      } finally { await reader.cancel(); }
      const data = JSON.parse(text) as { models: { name: string }[] };
      return data.models.map(m => m.name);
    }),
    ...(includeSeats ? [probe('seats', deps.seats)] : []),
  ]);
}
