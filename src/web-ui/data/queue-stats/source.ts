/**
 * data/queue-stats/source.ts: pluggable data sources for `queue.stats.v1`.
 *
 * fixture: works today. command: stub for `phm queue stats --json` (needs a
 * native or daemon bridge; RQ-QUEUE-3). http: stub for a web route that serves
 * the same JSON. Every source returns parsed, whitelisted data only.
 */
import { parseQueueStats, type ParseResult } from './schema.js';
import { QUEUE_STATS_NORMAL } from './fixtures.js';

export interface QueueStatsSource {
  readonly kind: 'fixture' | 'command' | 'http';
  load(): Promise<ParseResult>;
}

export function fixtureQueueStatsSource(payload: unknown = QUEUE_STATS_NORMAL): QueueStatsSource {
  return { kind: 'fixture', load: async () => parseQueueStats(payload) };
}

/** Stub: wire to a bridge that runs `phm queue stats --json` once RQ-QUEUE-3 lands. */
export function commandQueueStatsSource(run?: () => Promise<string>): QueueStatsSource {
  return {
    kind: 'command',
    load: async () => {
      if (!run) return { ok: false, error: 'phm queue stats --json is not wired yet (RQ-QUEUE-3)' };
      try {
        return parseQueueStats(JSON.parse(await run()));
      } catch {
        return { ok: false, error: 'phm queue stats output was not valid JSON' };
      }
    },
  };
}

/** Stub: same-origin route serving queue.stats.v1. No auth headers are sent from here. */
export function httpQueueStatsSource(path = '/api/queue/stats', fetchImpl: typeof fetch = fetch): QueueStatsSource {
  return {
    kind: 'http',
    load: async () => {
      try {
        const res = await fetchImpl(path, { headers: { accept: 'application/json' } });
        if (!res.ok) return { ok: false, error: `queue stats route returned ${res.status}` };
        return parseQueueStats(await res.json());
      } catch {
        return { ok: false, error: 'queue stats route unreachable' };
      }
    },
  };
}
