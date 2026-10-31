/**
 * core/verse/runs-history-api.ts — `GET /api/verse/runs-history` (mounted by
 * verse-api.ts through the api-modules.ts contract).
 *
 * The durable fleet-runs series: lane running/target/queued/held, worker and
 * leader counts, paused — one JSONL sample per minute while something was
 * watching (see core/fleet/runs-history.ts). Reading the route is what drives
 * the sampler: each GET first offers `sampleIfDue`, then returns the window.
 * A sampling failure NEVER fails the read — the existing series is served.
 *
 *   GET /api/verse/runs-history[?hours=1..168]  → RunsHistory (default 24 h)
 *   any other method on the path                → 405
 *   any other path                              → false (next module runs)
 *
 * Read-only: no dispatch gate, no mutation surface. The response carries
 * counts and timestamps only — never paths, job ids or error text.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';
import {
  readRunsHistory,
  sampleIfDue,
  RUNS_HISTORY_DEFAULT_HOURS,
  RUNS_HISTORY_MAX_HOURS,
  RUNS_HISTORY_MIN_HOURS,
  type RunsHistory,
} from '../fleet/runs-history.js';

export const VERSE_RUNS_HISTORY_PATH = '/api/verse/runs-history';

export interface RunsHistoryApiDeps {
  /** Defaults to sampleIfDue on the resolved history file. */
  sample?: () => Promise<unknown>;
  /** Defaults to readRunsHistory on the resolved history file. */
  readHistory?: (hours: number) => Promise<RunsHistory>;
}

export function createRunsHistoryApi(deps: RunsHistoryApiDeps = {}): ApiModule {
  const take = deps.sample ?? (() => sampleIfDue({}));
  const read = deps.readHistory ?? ((hours: number) => readRunsHistory({ hours }));
  // Concurrent GETs share one in-flight sample so a burst cannot double-append.
  let sampling: Promise<unknown> | undefined;
  const sample = () => (sampling ??= take().finally(() => { sampling = undefined; }));

  return async (_ctx, req: IncomingMessage, res: ServerResponse, path, method) => {
    if (path !== VERSE_RUNS_HISTORY_PATH) return false;
    if (method !== 'GET') {
      sendJson(res, 405, { error: `method not allowed: ${method} ${path}` });
      return true;
    }
    const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
    const unknown = [...params.keys()].find((key) => key !== 'hours');
    if (unknown !== undefined) {
      sendJson(res, 400, { code: 'VERSE_INVALID', error: `unknown parameter: ${unknown.slice(0, 64)}` });
      return true;
    }
    let hours = RUNS_HISTORY_DEFAULT_HOURS;
    const raw = params.get('hours');
    if (raw !== null) {
      if (!/^\d+$/.test(raw)) {
        sendJson(res, 400, { code: 'VERSE_INVALID', error: `hours must be an integer ${RUNS_HISTORY_MIN_HOURS}..${RUNS_HISTORY_MAX_HOURS}` });
        return true;
      }
      hours = Number(raw);
      if (!Number.isSafeInteger(hours) || hours < RUNS_HISTORY_MIN_HOURS || hours > RUNS_HISTORY_MAX_HOURS) {
        sendJson(res, 400, { code: 'VERSE_INVALID', error: `hours must be an integer ${RUNS_HISTORY_MIN_HOURS}..${RUNS_HISTORY_MAX_HOURS}` });
        return true;
      }
    }
    try { await sample(); } catch { /* a failed sample never fails the read */ }
    try {
      sendJson(res, 200, await read(hours));
    } catch {
      sendJson(res, 500, { code: 'RUNS_HISTORY_UNAVAILABLE', error: 'runs history unavailable' });
    }
    return true;
  };
}

export const handleRunsHistoryApi: ApiModule = createRunsHistoryApi();
