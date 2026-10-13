/**
 * Stale-while-revalidate cache for slow read-only probes (GitHub status, gh
 * search). A fresh value is returned as is; a stale one is returned at once
 * while one background refresh runs; only a cold key waits. Values persist to
 * ~/.ashlr/cache/<key>.json (0600) so a restarted server is warm.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

interface Entry<T> { at: number; value: T }
const memory = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

export interface SwrOptions { ttlMs: number; now?: () => number; dir?: string | null }

function file(dir: string, key: string): string { return join(dir, `${key.replace(/[^a-z0-9_-]/gi, '_')}.json`); }
function defaultDir(): string { return join(homedir(), '.ashlr', 'cache'); }

export async function swr<T>(key: string, fn: () => Promise<T>, opts: SwrOptions): Promise<T> {
  const now = opts.now ?? Date.now;
  const dir = opts.dir === undefined ? defaultDir() : opts.dir;
  let entry = memory.get(key) as Entry<T> | undefined;
  if (!entry && dir) {
    try { entry = JSON.parse(readFileSync(file(dir, key), 'utf8')) as Entry<T>; memory.set(key, entry); } catch { /* cold */ }
  }
  const refresh = (): Promise<T> => {
    const running = inflight.get(key) as Promise<T> | undefined;
    if (running) return running;
    const p = fn().then((value) => {
      const e = { at: now(), value }; memory.set(key, e);
      if (dir) { try { mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(file(dir, key), JSON.stringify(e), { mode: 0o600 }); } catch { /* best effort */ } }
      return value;
    }).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };
  if (!entry) return refresh();
  if (now() - entry.at > opts.ttlMs) void refresh().catch(() => undefined);
  return entry.value;
}

/** Drop a key (after a write that changes it, e.g. `ecosystem up`). */
export function invalidateSwr(key: string): void { memory.delete(key); }
export function resetSwrForTests(): void { memory.clear(); inflight.clear(); }
