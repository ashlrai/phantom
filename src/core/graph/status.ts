import { lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { buildRegistryGraph } from './registry.js';
import type { GraphSourceState, RegistryGraph } from './types.js';

export const GRAPH_SOURCE_MAX_BYTES = 2 * 1024 * 1024;
export interface GraphStatusOptions { fleet?: string; seats?: string }
interface Source { state: GraphSourceState; value?: unknown }

/** Reuse the bounded, stable descriptor reader; errors never include file contents or paths. */
function readSource(file: string): Source {
  const path = resolve(file);
  try { lstatSync(path); }
  catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable' };
  }
  const result = readStableRegularFile(path, {
    anchorPath: dirname(path), maxFileBytes: GRAPH_SOURCE_MAX_BYTES, remainingBytes: GRAPH_SOURCE_MAX_BYTES,
  });
  if (!result.ok) return { state: 'unavailable' };
  try { return { state: 'loaded', value: JSON.parse(result.text) as unknown }; }
  catch { return { state: 'invalid' }; }
}

async function nativeSeats(): Promise<Source> {
  try {
    // Lazy and metadata-only: do not start discoverSeats, usage collectors, or provider probes.
    const [{ loadConfigReadOnlyStrict }, { resolveAccountsRoot, readSeatProfile, nativeSeatModels },
      { validateResourceConnectionConfig }] = await Promise.all([
      import('../config.js'), import('../verse/seats.js'), import('../resources/connection-config.js'),
    ]);
    const source = readSource(join(resolveAccountsRoot(loadConfigReadOnlyStrict()), 'connections.json'));
    if (source.state !== 'loaded') return source;
    try {
      const roster = validateResourceConnectionConfig(source.value);
      return { state: 'loaded', value: roster.accounts.map(account => ({
        id: account.id, engine: account.provider, accountId: account.id,
        models: nativeSeatModels(account.provider, readSeatProfile(account.command, account.provider)).models
          .map(model => ({ id: model.id })),
      })) };
    } catch { return { state: 'invalid' }; }
  } catch { return { state: 'unavailable' }; }
}

/** Read an explicit snapshot when supplied, otherwise only the native seat metadata on disk. */
export async function readRegistryGraph(options: GraphStatusOptions = {}): Promise<RegistryGraph> {
  const fleet = readSource(options.fleet ?? join(process.cwd(), 'fleet.json'));
  const seats = options.seats === undefined ? await nativeSeats() : readSource(options.seats);
  const graph = buildRegistryGraph(fleet.value, seats.value);
  for (const [name, source] of [['fleet', fleet], ['seats', seats]] as const) {
    if (source.state === 'loaded') continue;
    graph.sources[name] = source.state;
    graph.issues = graph.issues.filter(issue => !(issue.source === name && issue.code === 'invalid'));
    graph.issues.push({ source: name, code: source.state });
  }
  graph.issues.sort((a, b) => {
    const left = `${a.source}/${a.code}`; const right = `${b.source}/${b.code}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  graph.complete = graph.issues.length === 0;
  return graph;
}
