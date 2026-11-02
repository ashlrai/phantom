import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const PAGE_SIZE = 100;
const MAX_ITEMS = 1000; // GitHub search cannot return more than 1,000 results.
const CACHE_MS = 60_000;
const HOUR_MS = 3_600_000;
const REPO_URL = 'https://api.github.com/repos/ashlrai/phantom';

export type MergeWindowRunner = (file: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string }>;
type Item = { repo: string; number: number; title: string; openedAt: string | null; mergedAt: string; openToMergeMs: number | null };
type Sample = { count: number; items: Item[]; observedAt: string; complete: boolean; cached: boolean; sourceState: 'healthy' | 'degraded' };
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const runGh: MergeWindowRunner = async (file, args, options) => promisify(execFile)(file, args, options);

/** Count only validated Phantom merges, never the search total. Partial searches
 * retain their validated rows with complete=false. Transport or validation errors
 * throw so the API preserves its unavailable projection and local publish facts.
 * Cached observations are degraded because their window is no longer current. */
export function createPhantomMergeWindow({ now = Date.now, runner = runGh }: { now?: () => number; runner?: MergeWindowRunner } = {}): () => Promise<Sample> {
  let cache: { at: number; sample: Sample } | undefined;
  return async () => {
    const at = now();
    if (cache && at >= cache.at && at - cache.at < CACHE_MS) {
      return { ...cache.sample, cached: true, sourceState: 'degraded' };
    }
    cache = undefined;
    const start = new Date(at - HOUR_MS).toISOString();
    const end = new Date(at).toISOString();
    const items: Item[] = [];
    const seen = new Set<number>();
    let total: number | undefined;
    let received = 0;
    let complete = true;
    for (let page = 1; page <= MAX_ITEMS / PAGE_SIZE; page++) {
      const { stdout } = await runner('gh', ['api', 'search/issues', '-X', 'GET', '-f',
        `q=repo:ashlrai/phantom is:pr is:merged merged:${start}..${end}`,
        '-f', `per_page=${PAGE_SIZE}`, '-f', `page=${page}`], { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
      const raw: unknown = JSON.parse(stdout);
      if (!isRecord(raw) || !Number.isSafeInteger(raw.total_count) || (raw.total_count as number) < 0 ||
        typeof raw.incomplete_results !== 'boolean' || !Array.isArray(raw.items) || raw.items.length > PAGE_SIZE) throw new Error('incomplete merge search');
      complete &&= raw.incomplete_results === false;
      if (total === undefined) total = raw.total_count as number;
      if (raw.total_count !== total) throw new Error('incomplete merge search');
      received += raw.items.length;
      if (received > total) throw new Error('inconsistent merge search');
      for (const row of raw.items as unknown[]) {
        if (!isRecord(row) || typeof row.repository_url !== 'string') throw new Error('invalid merge row');
        if (row.repository_url !== REPO_URL) continue;
        if (!Number.isSafeInteger(row.number) || (row.number as number) <= 0 || typeof row.title !== 'string' || !isRecord(row.pull_request) ||
          !('merged_at' in row.pull_request)) throw new Error('invalid merge row');
        if (row.pull_request.merged_at === null) continue;
        const mergedAt = row.pull_request.merged_at;
        if (typeof mergedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(mergedAt) || !Number.isFinite(Date.parse(mergedAt)) ||
          new Date(mergedAt).toISOString().slice(0, 19) !== mergedAt.slice(0, 19)) throw new Error('invalid merge timestamp');
        const time = Date.parse(mergedAt);
        if (time <= at - HOUR_MS || time > at) continue;
        const number = row.number as number;
        if (seen.has(number)) throw new Error('duplicate merge row');
        seen.add(number);
        const openedAt = typeof row.created_at === 'string' && Number.isFinite(Date.parse(row.created_at)) ? row.created_at : null;
        const duration = openedAt === null ? NaN : time - Date.parse(openedAt);
        items.push({ repo: 'ashlrai/phantom', number, title: row.title, openedAt, mergedAt,
          openToMergeMs: Number.isFinite(duration) && duration >= 0 ? duration : null });
      }
      if (received === total || raw.items.length < PAGE_SIZE || page === MAX_ITEMS / PAGE_SIZE) {
        complete &&= received === total;
        const sample: Sample = { count: items.length, items, observedAt: end, complete, cached: false, sourceState: complete ? 'healthy' : 'degraded' };
        cache = { at, sample };
        return sample;
      }
    }
    throw new Error('incomplete merge search');
  };
}
