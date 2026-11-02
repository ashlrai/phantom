/**
 * Self-tick route: the desktop Needs-you list's read and its one action.
 *
 *   GET  /api/verse/fleet/self-tick → {v:1, last} — the read-only projection
 *                                   of queue/self-tick-last.json; never runs
 *                                   a tick and never takes the lock.
 *   POST /api/verse/fleet/self-tick → {v:1, exitCode, report} — one locked
 *                                   `ashlr fleet self-tick` pass run in this
 *                                   server process. {apply:true} runs with
 *                                   --apply; absent or false is a dry-run.
 *
 * The POST is gated like every Verse mutation: 404 without dispatch, the
 * mutation-token gate, a JSON-object body, no query parameters, and one run
 * in flight at a time (409 busy). Lock contention inside the run is NOT an
 * error: a contended pass answers 200 with a 'busy' report.
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readSelfTickLast, type SelfTickLastView } from '../fleet/self-tick-last.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';

export const VERSE_FLEET_SELF_TICK_PATH = '/api/verse/fleet/self-tick';
export interface FleetSelfTickResponseV1 {
  v: 1;
  last: SelfTickLastView | null;
}
/** The POST answer: the run's exit code and its parsed --json report. */
export interface FleetSelfTickRunResponseV1 {
  v: 1;
  exitCode: number;
  /** The parsed self-tick report (state 'ran' or 'busy'); null when the verb printed nothing parseable. */
  report: unknown;
}
export interface FleetSelfTickRunResult {
  exitCode: number;
  report: unknown;
}
export interface FleetSelfTickApiDeps {
  /** Runs root holding queue/self-tick-last.json. Default: ASHLR_RUNS_DIR, then ~/.ashlr-runs. */
  runsDir?: string;
  now?: () => number;
  /**
   * One locked self-tick pass; args are the verb's own argv (--json, maybe
   * --apply, --runs-dir <abs>). Default runs cmdFleetSelfTick in-process via
   * a dynamic import (the authority-api → cli/authority precedent); tests
   * inject a fake and never run real verbs.
   */
  runTick?: (args: string[]) => Promise<FleetSelfTickRunResult>;
}

/** ASHLR_RUNS_DIR overrides ~/.ashlr-runs — the fleet runs-dir convention fleet-runs-api uses. */
function defaultRunsDir(): string {
  return process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
}

/** The real run: one cmdFleetSelfTick call, its --json line captured. */
async function runTickInProcess(args: string[]): Promise<FleetSelfTickRunResult> {
  const { cmdFleetSelfTick } = await import('../../cli/fleet-self-tick.js');
  const captured: string[] = [];
  const exitCode = await cmdFleetSelfTick(args, {
    output: (text) => captured.push(text),
    error: () => { /* a server's stderr is not the verb's console */ },
  });
  const text = captured.join('\n').trim();
  let report: unknown = null;
  try { report = text ? (JSON.parse(text) as unknown) : null; } catch { report = null; }
  return { exitCode, report };
}

function sendInvalid(res: ServerResponse, message: string): void {
  sendJson(res, 400, { code: 'VERSE_INVALID', error: message });
}

/** The POST takes no query parameters — same refusal fleet-holds makes. */
function noQuery(req: IncomingMessage, res: ServerResponse): boolean {
  let params: URLSearchParams;
  try {
    params = new URL(req.url ?? '/', 'http://localhost').searchParams;
  } catch {
    sendInvalid(res, 'invalid query string');
    return false;
  }
  for (const key of params.keys()) {
    sendInvalid(res, `unknown query parameter: ${key}`);
    return false;
  }
  return true;
}

/** Shared fixed message: thrown errors can carry absolute paths or file text. */
const UNAVAILABLE = 'fleet self-tick unavailable';

export function createFleetSelfTickApi(deps: FleetSelfTickApiDeps = {}): ApiModule {
  const now = deps.now ?? Date.now;
  /** One run at a time: a double-click must not interleave two locked passes. */
  let runInFlight = false;
  return async (ctx, req, res, path, method) => {
    if (path !== VERSE_FLEET_SELF_TICK_PATH) return false;
    if (method === 'GET') {
      try {
        // sendJson passes the body through sanitizePublicJson, the same
        // shared-read-surface rule the recorded file itself was written under.
        const body: FleetSelfTickResponseV1 = {
          v: 1,
          last: readSelfTickLast(deps.runsDir ?? defaultRunsDir(), now()),
        };
        sendJson(res, 200, body);
      } catch {
        sendJson(res, 503, { v: 1, error: UNAVAILABLE });
      }
      return true;
    }
    if (method !== 'POST') return false;
    if (!ctx.allowDispatch) {
      sendJson(res, 404, { error: 'not found' });
      return true;
    }
    if (!passesMutationGate(req, res, ctx.token)) return true;
    if (!noQuery(req, res)) return true;
    let raw: string;
    try {
      raw = await readBody(req);
    } catch {
      sendJson(res, 413, { code: 'VERSE_TOO_LARGE', error: 'request body too large' });
      return true;
    }
    let parsed: unknown;
    try {
      parsed = raw.length === 0 ? {} : (JSON.parse(raw) as unknown);
    } catch {
      sendInvalid(res, 'invalid JSON body');
      return true;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      sendInvalid(res, 'body must be a JSON object');
      return true;
    }
    const apply = (parsed as Record<string, unknown>)['apply'];
    if (Object.keys(parsed).some((key) => key !== 'apply') || (apply !== undefined && typeof apply !== 'boolean')) {
      sendInvalid(res, 'body accepts only { "apply": boolean }');
      return true;
    }
    if (runInFlight) {
      sendJson(res, 409, { code: 'busy', error: 'a self-tick run is already in flight' });
      return true;
    }
    const runsDir = resolve(deps.runsDir ?? defaultRunsDir());
    const args = ['--json', ...(apply === true ? ['--apply'] : []), '--runs-dir', runsDir];
    runInFlight = true;
    try {
      const { exitCode, report } = await (deps.runTick ?? runTickInProcess)(args);
      const body: FleetSelfTickRunResponseV1 = { v: 1, exitCode, report };
      sendJson(res, 200, body);
    } catch {
      sendJson(res, 503, { v: 1, error: UNAVAILABLE });
    } finally {
      runInFlight = false;
    }
    return true;
  };
}
export const handleFleetSelfTickApi: ApiModule = createFleetSelfTickApi();
