import { open, readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readInboxEntries } from './mason-inbox.js';

export interface OrderTraceJob {
  id: string;
  lane: string | null;
  state: 'queued' | 'launched' | 'published';
  url: string | null;
}
export interface OrderTraceV1 {
  v: 1;
  generatedAt: string;
  sources: Record<'inbox' | 'prompts' | 'publishes', 'healthy' | 'missing' | 'degraded'>;
  orders: Array<{ at: string; source: string; key: string; jobs: OrderTraceJob[] }>;
}
const months = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
export function parseOrderCitations(body: string): string[] {
  const keys = new Set<string>();
  for (const phrase of body.matchAll(/Serves Mason['’]s\s+([^.!?]+)/gi)) {
    let date: string | undefined;
    for (const match of phrase[1]!.matchAll(/\b(?:(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\s+)?([0-2]\d:[0-5]\d)\b/gi)) {
      if (match[1]) {
        const month = months.findIndex(m => m.toLowerCase() === match[1]!.toLowerCase()) + 1;
        const day = Number(match[2]);
        date = day >= 1 && day <= 31 ? `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : undefined;
      }
      if (date && Number(match[3]!.slice(0, 2)) < 24) keys.add(`${date} ${match[3]}`);
    }
  }
  return [...keys];
}
export function orderKey(entryAt: string): string | null {
  const match = /^\d{4}-(\d{2}-\d{2}) ([0-2]\d:[0-5]\d)(?: ET)?$/.exec(entryAt);
  if (!match || Number(match[1]!.slice(0, 2)) < 1 || Number(match[1]!.slice(0, 2)) > 12 ||
      Number(match[1]!.slice(3)) < 1 || Number(match[1]!.slice(3)) > 31 || Number(match[2]!.slice(0, 2)) > 23) return null;
  return `${match[1]} ${match[2]}`;
}
const cache = new Map<string, { mtime: number; keys: string[] }>();
function sourceError(error: unknown): 'missing' | 'degraded' {
  return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'degraded';
}
async function boundedText(path: string, bytes: number): Promise<string> {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await file.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally { await file.close(); }
}
export async function readOrderTrace(opts: { runsDir?: string; now?: () => number; maxBodies?: number } = {}): Promise<OrderTraceV1> {
  const root = opts.runsDir ?? join(homedir(), '.ashlr-runs');
  const inbox = await readInboxEntries({ runsDir: root, limit: Number.MAX_SAFE_INTEGER });
  const result: OrderTraceV1 = {
    v: 1, generatedAt: new Date((opts.now ?? Date.now)()).toISOString(),
    sources: { inbox: inbox.sourceState, prompts: 'healthy', publishes: 'healthy' },
    orders: inbox.entries.flatMap(entry => {
      const key = orderKey(entry.at);
      return key ? [{ at: entry.at, source: entry.source, key, jobs: [] }] : [];
    }),
  };
  const files: Array<{ path: string; id: string; mtime: number }> = [];
  let directories = 0;
  for (const [dir, pattern] of [[root, /^(RQ-[\w-]+)\.prompt$/], [join(root, 'queue', 'prompts'), /^(RQ-[\w-]+)\.md$/]] as const) {
    try {
      const names = await readdir(dir);
      directories++;
      for (const name of names) {
        const match = pattern.exec(name);
        if (!match) continue;
        try {
          const path = join(dir, name);
          const info = await stat(path);
          if (info.isFile()) files.push({ path, id: match[1]!, mtime: info.mtimeMs });
        } catch { result.sources.prompts = 'degraded'; }
      }
    } catch (error) {
      if (sourceError(error) === 'degraded') result.sources.prompts = 'degraded';
    }
  }
  if ((!directories || !files.length) && result.sources.prompts === 'healthy') result.sources.prompts = 'missing';
  const publishes = new Map<string, { url: string; ts: number }>();
  try {
    const text = await readFile(join(root, 'metrics', 'jobs.jsonl'), 'utf8');
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        if (row.event !== 'publish' || typeof row.job !== 'string' || typeof row.url !== 'string' ||
            typeof row.ts !== 'string' || !Number.isFinite(Date.parse(row.ts))) {
          result.sources.publishes = 'degraded'; continue;
        }
        const ts = Date.parse(row.ts);
        if (ts >= (publishes.get(row.job)?.ts ?? -Infinity)) publishes.set(row.job, { url: row.url, ts });
      } catch { result.sources.publishes = 'degraded'; }
    }
  } catch (error) { result.sources.publishes = sourceError(error); }
  const limit = Number.isFinite(opts.maxBodies) ? Math.max(0, Math.min(600, Math.floor(opts.maxBodies!))) : 600;
  files.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
  if (files.length > limit) result.sources.prompts = 'degraded';
  const active = new Set(files.slice(0, limit).map(file => file.path));
  for (const path of cache.keys()) if (!active.has(path)) cache.delete(path);
  for (const file of files.slice(0, limit)) {
    try {
      let cached = cache.get(file.path);
      if (!cached || cached.mtime !== file.mtime) {
        cached = { mtime: file.mtime, keys: parseOrderCitations(await boundedText(file.path, 16 * 1024)) };
        cache.set(file.path, cached);
      }
      let launched = false;
      let lane: string | null = null;
      try {
        const marker = await boundedText(join(root, `${file.id}.launch`), 4096);
        launched = true;
        lane = /^launched\s+RQ-[\w-]+\s+(\S+)/m.exec(marker)?.[1] ?? null;
      } catch (error) { if (sourceError(error) === 'degraded') result.sources.prompts = 'degraded'; }
      const publish = publishes.get(file.id);
      for (const order of result.orders) {
        if (!cached.keys.includes(order.key) || order.jobs.some(job => job.id === file.id)) continue;
        order.jobs.push({ id: file.id, lane, state: publish ? 'published' : launched ? 'launched' : 'queued', url: publish?.url ?? null });
      }
    } catch { result.sources.prompts = 'degraded'; }
  }
  return result;
}
