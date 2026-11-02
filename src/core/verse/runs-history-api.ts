/**
 * core/verse/runs-history-api.ts — `GET /api/verse/runs-history` (mounted by
 * verse-api.ts through the api-modules.ts contract).
 *
 * The durable fleet-runs series: lane running/target/queued/held, worker and
 * leader counts, paused — one JSONL sample per minute while something was
 * watching (see core/fleet/runs-history.ts). Reading the route is what drives
 * the sampler: each GET first offers `sampleIfDue`, then returns the window.
 * A sampling failure NEVER fails the read — the existing series is served.
 * stallWindows adds observed idle intervals; they do not prove dispatch failure.
 * Continuity is limited to consecutive samples at most 150 seconds apart.
 *
 *   GET /api/verse/runs-history[?hours=1..168]  → RunsHistory (default 24 h)
 *   GET /api/verse/runs-history/lane-truth      → LaneTruth (see below)
 *   GET /api/verse/runs-history/lane-streaks[?minutes=15..1440]
 *                                               → LaneEmptyStreaksV1 (default 90 min)
 *   any other method on any of these paths      → 405
 *   any other path                              → false (next module runs)
 *
 * The lane-truth route serves the same verdict `ashlr fleet lane-truth`
 * computes (core/fleet/lane-truth.ts): per lane, held_with_capacity /
 * reset_detected / idle_with_work / ok / unknown, with the newest meter
 * sample that informed it. A reader failure answers 200 with
 * `source: 'unavailable'` and no lanes — half-evidence is never truth.
 *
 * The lane-streaks route serves the same verdict `ashlr fleet lane-streaks`
 * computes (core/fleet/lane-empty-streak.ts): per lane, burning / ok / quiet
 * over the dispatch-events.log launches inside the window. A missing or
 * unreadable log answers 200 with `source: 'unavailable'` and no lanes.
 *
 * Read-only: no dispatch gate, no mutation surface. The response carries
 * counts, job ids and timestamps only — never paths, hold reasons or error
 * text.
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
import { projectRunsStallWindows } from '../fleet/runs-stall-windows.js';
import {
  defaultLaneTruthReaders,
  LANE_TRUTH_MAX_AGE_MS,
  readLaneTruthReport,
  type LaneTruthReaders,
} from '../fleet/lane-truth.js';
import {
  laneEmptyStreaks,
  LANE_STREAKS_DEFAULT_MINUTES,
  LANE_STREAKS_MAX_MINUTES,
  LANE_STREAKS_MIN_MINUTES,
} from '../fleet/lane-empty-streak.js';

export const VERSE_RUNS_HISTORY_PATH = '/api/verse/runs-history';
export const VERSE_RUNS_HISTORY_LANE_TRUTH_PATH = '/api/verse/runs-history/lane-truth';
export const VERSE_RUNS_HISTORY_LANE_STREAKS_PATH = '/api/verse/runs-history/lane-streaks';

export interface RunsHistoryApiDeps {
  /** Defaults to sampleIfDue on the resolved history file. */
  sample?: () => Promise<unknown>;
  /** Defaults to readRunsHistory on the resolved history file. */
  readHistory?: (hours: number) => Promise<RunsHistory>;
  /** Defaults to defaultLaneTruthReaders() built per request. */
  laneTruth?: LaneTruthReaders;
  /** Defaults to the dispatch-events.log tail under ~/.ashlr-runs (null when absent). */
  readDispatchEvents?: () => Promise<string | null>;
}

/** Descriptor-bound tail read of the runs-dir event log, like runs-dir-state. */
const DISPATCH_EVENTS_TAIL = 8 * 1024 * 1024;
async function readDispatchEventsLog(): Promise<string | null> {
  const path = join(homedir(), '.ashlr-runs', 'dispatch-events.log');
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size <= 0) return null;
      const start = Math.max(0, info.size - DISPATCH_EVENTS_TAIL);
      const bytes = Buffer.alloc(Math.min(info.size, DISPATCH_EVENTS_TAIL));
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, start + offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const text = bytes.subarray(0, offset).toString('utf8');
      return start ? text.slice(text.indexOf('\n') < 0 ? text.length : text.indexOf('\n') + 1) : text;
    } finally { await file.close(); }
  } catch { return null; }
}

export function createRunsHistoryApi(deps: RunsHistoryApiDeps = {}): ApiModule {
  const take = deps.sample ?? (() => sampleIfDue({}));
  const read = deps.readHistory ?? ((hours: number) => readRunsHistory({ hours }));
  // Concurrent GETs share one in-flight sample so a burst cannot double-append.
  let sampling: Promise<unknown> | undefined;
  const sample = () => (sampling ??= take().finally(() => { sampling = undefined; }));

  return async (_ctx, req: IncomingMessage, res: ServerResponse, path, method) => {
    if (path === VERSE_RUNS_HISTORY_LANE_TRUTH_PATH) {
      if (method !== 'GET') {
        sendJson(res, 405, { error: `method not allowed: ${method} ${path}` });
        return true;
      }
      const unknown = [...new URL(req.url ?? '/', 'http://localhost').searchParams.keys()][0];
      if (unknown !== undefined) {
        sendJson(res, 400, { code: 'VERSE_INVALID', error: `unknown parameter: ${unknown.slice(0, 64)}` });
        return true;
      }
      try {
        const lanes = await readLaneTruthReport(deps.laneTruth ?? defaultLaneTruthReaders());
        sendJson(res, 200, { v: 1, generatedAt: new Date().toISOString(), source: 'ok', maxAgeMs: LANE_TRUTH_MAX_AGE_MS, lanes });
      } catch {
        sendJson(res, 200, { v: 1, generatedAt: new Date().toISOString(), source: 'unavailable', maxAgeMs: LANE_TRUTH_MAX_AGE_MS, lanes: [] });
      }
      return true;
    }
    if (path === VERSE_RUNS_HISTORY_LANE_STREAKS_PATH) {
      if (method !== 'GET') {
        sendJson(res, 405, { error: `method not allowed: ${method} ${path}` });
        return true;
      }
      const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
      const unknown = [...params.keys()].find((key) => key !== 'minutes');
      if (unknown !== undefined) {
        sendJson(res, 400, { code: 'VERSE_INVALID', error: `unknown parameter: ${unknown.slice(0, 64)}` });
        return true;
      }
      let minutes = LANE_STREAKS_DEFAULT_MINUTES;
      const raw = params.get('minutes');
      if (raw !== null) {
        if (!/^\d+$/.test(raw)) {
          sendJson(res, 400, { code: 'VERSE_INVALID', error: `minutes must be an integer ${LANE_STREAKS_MIN_MINUTES}..${LANE_STREAKS_MAX_MINUTES}` });
          return true;
        }
        minutes = Number(raw);
        if (!Number.isSafeInteger(minutes) || minutes < LANE_STREAKS_MIN_MINUTES || minutes > LANE_STREAKS_MAX_MINUTES) {
          sendJson(res, 400, { code: 'VERSE_INVALID', error: `minutes must be an integer ${LANE_STREAKS_MIN_MINUTES}..${LANE_STREAKS_MAX_MINUTES}` });
          return true;
        }
      }
      const readEvents = deps.readDispatchEvents ?? readDispatchEventsLog;
      let text: string | null = null;
      try { text = await readEvents(); } catch { text = null; }
      sendJson(res, 200, text === null
        ? { v: 1, generatedAt: new Date().toISOString(), source: 'unavailable', windowMinutes: minutes, lanes: [], malformedLines: 0 }
        : laneEmptyStreaks(text, Date.now(), minutes));
      return true;
    }
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
      const history = await read(hours);
      sendJson(res, 200, { ...history, stallWindows: projectRunsStallWindows(history) });
    } catch {
      sendJson(res, 500, { code: 'RUNS_HISTORY_UNAVAILABLE', error: 'runs history unavailable' });
    }
    return true;
  };
}

export const handleRunsHistoryApi: ApiModule = createRunsHistoryApi();
