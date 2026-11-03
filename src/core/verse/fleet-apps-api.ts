/** Bounded local desktop app control; no phone gateway mutations. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { awaitAppState } from '../fleet/app-await.js';
import { findAppControlScript, findInstalledAppControlScript, type FleetAppExec } from '../../cli/fleet-app.js';
import { passesMutationGate, readBody, sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';

export const FLEET_APPS = ['Phantom', 'Codex', 'Claude', 'Grok Bot', 'ChatGPT', 'Cursor', 'Safari', 'Google Chrome'] as const;
const PATH = '/api/verse/fleet/apps';
// One finite budget covers the action and any running confirmation; waitRunningMs only caps the confirmation part.
const ACTION_BUDGET_MS = 30_000;
const MAX_WAIT_RUNNING_MS = 30_000;
const CONFIRM_INTERVAL_MS = 200;
const execAsync = promisify(execFile);
export interface FleetAppsApiDeps {
  exec?: FleetAppExec;
  locateScript?: () => string | null;
  now?: () => number;
  runsDir?: string;
}
interface AppsView {
  v: 1;
  generatedAt: string;
  available: boolean;
  apps: Array<{ app: string; running: boolean | null; checkedAt: string }>;
}
const UNAVAILABLE = { code: 'unavailable', error: 'fleet apps unavailable' } as const;
// Known script refusals (ok:false); anything else is reported as generic unavailable.
const REFUSALS: Record<string, string> = {
  permission_denied: 'app control permission required',
  quit_timeout: 'app did not quit in time',
  not_running: 'app is not running',
  automatic_termination_denied: 'automatic termination denied',
  unknown_action: 'unknown app action',
  unknown_app: 'unknown app',
};
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
type Report = Record<string, unknown>;
/** Hard bound on one pending child call, so a hung dependency cannot outlive the budget. */
function bounded(work: Promise<Report | undefined>, ms: number): Promise<Report | undefined> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(undefined), Math.max(0, ms));
    work.then(resolve, () => resolve(undefined)).finally(() => clearTimeout(timer));
  });
}
export function createFleetAppsApi(deps: FleetAppsApiDeps = {}): ApiModule {
  const now = deps.now ?? Date.now;
  const root = deps.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const locate = deps.locateScript ?? (() => findAppControlScript() ?? findInstalledAppControlScript(root));
  const exec: FleetAppExec = deps.exec ?? (async (file, argv, options) => execAsync(file, argv, options));
  let cached: { at: number; view: Promise<AppsView> } | undefined;
  const inFlight = new Set<string>();
  async function run(script: string, action: string, app: string, timeout: number): Promise<Record<string, unknown>> {
    let stdout: string;
    try {
      ({ stdout } = await exec('python3', ['-I', script, action, app, '--output-dir', root], {
        encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, windowsHide: true,
      }));
    } catch (error) {
      const e = error as { code?: unknown; stdout?: unknown; killed?: unknown; signal?: unknown };
      // Script refusals exit nonzero but still return the JSON contract.
      if (typeof e.code !== 'number' || e.killed || e.signal || typeof e.stdout !== 'string') throw new Error('app control unavailable');
      stdout = e.stdout;
    }
    const parsed: unknown = JSON.parse(stdout);
    if (!record(parsed)) throw new Error('app control unavailable');
    return parsed;
  }
  async function snapshot(): Promise<AppsView> {
    const generatedAt = new Date(now()).toISOString();
    const script = locate();
    if (!script) return { v: 1, generatedAt, available: false, apps: [] };
    const apps: AppsView['apps'] = FLEET_APPS.map(app => ({ app, running: null, checkedAt: generatedAt }));
    const deadline = Date.now() + 20_000;
    let next = 0;
    async function worker() {
      while (next < apps.length) {
        const row = apps[next++]!;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return;
        try {
          const result = await run(script!, 'status', row.app, remaining);
          row.running = typeof result.running === 'boolean' ? result.running : null;
        } catch { /* Unreadable status stays unknown; never echo stderr. */ }
        row.checkedAt = new Date(now()).toISOString();
      }
    }
    await Promise.all([worker(), worker()]);
    return { v: 1, generatedAt, available: true, apps };
  }
  /** Resolves undefined when the work fails or the budget runs out; an injected exec may ignore its own timeout option. */
  const control = (script: string, action: 'status' | 'launch', app: string, budgetMs: number): Promise<Report | undefined> =>
    bounded(run(script, action, app, Math.max(1, Math.ceil(budgetMs))).catch(() => undefined), budgetMs);
  /** Only a valid ok:true boolean is a reading; anything else is unknown. */
  const reading = (report: Report | undefined): boolean | null =>
    report?.ok === true && typeof report.running === 'boolean' ? report.running : null;
  /**
   * Idempotent "ensure running" on one app within one 30 s budget. One status probe; launch is requested
   * at most once and only after an ok:true running:false reading; then running is confirmed with the remaining budget.
   *
   * Response body (never child stdout/stderr or paths; `code`/`error` only from the REFUSALS allowlist):
   *   200 {app, action:"ensure", outcome:"already_running"|"launched", launchRequested, running:true, at}
   *   422 {app, action:"ensure", outcome:"unavailable", launchRequested, running, at, code, error[, needsMason:true]}
   *       a known refusal from the status or launch report
   *   503 {app, action:"ensure", outcome:"unavailable", launchRequested, running, at, code:"unavailable", error}
   *       unknown or malformed status, a launch that was not accepted, or a child failure
   *   504 {app, action:"ensure", outcome:"timeout", launchRequested, running, at, code:"VERSE_ENSURE_TIMEOUT", error}
   *       budget spent without observing running; running is the last valid observation (true|false|null)
   */
  async function ensure(script: string, app: string, wait: number | undefined): Promise<{ http: number; body: Record<string, unknown> }> {
    const deadline = Date.now() + ACTION_BUDGET_MS;
    const left = (): number => deadline - Date.now();
    const at = new Date(now()).toISOString();
    const respond = (outcome: 'already_running' | 'launched' | 'unavailable' | 'timeout', running: boolean | null, launchRequested: boolean, failed?: Report) => {
      const base = { app, action: 'ensure', outcome, launchRequested, running, at };
      if (outcome === 'already_running' || outcome === 'launched') return { http: 200, body: base };
      if (outcome === 'timeout') return { http: 504, body: { ...base, code: 'VERSE_ENSURE_TIMEOUT', error: 'running not confirmed in time' } };
      const refusal = failed?.ok === false && typeof failed.code === 'string' && Object.hasOwn(REFUSALS, failed.code) ? failed.code : undefined;
      if (refusal) {
        const needsMason = refusal === 'permission_denied' && failed?.needs_mason_written === true;
        return { http: 422, body: { ...base, code: refusal, error: REFUSALS[refusal], ...(needsMason ? { needsMason: true } : {}) } };
      }
      return { http: 503, body: { ...base, ...UNAVAILABLE } };
    };
    const first = await control(script, 'status', app, left());
    const initial = reading(first);
    if (initial === true) return respond('already_running', true, false);
    if (initial === null) return respond('unavailable', null, false, first);
    // Definitively stopped: the single launch. Never retried, whatever its report.
    const launch = await control(script, 'launch', app, left());
    if (launch === undefined && left() <= 0) return respond('timeout', false, true);
    if (launch?.ok !== true || typeof launch.code !== 'string') return respond('unavailable', false, true, launch);
    // Observe only: sequential status probes, capped by waitRunningMs when given.
    const seen = await awaitAppState({
      target: 'running',
      timeoutMs: Math.max(0, Math.min(wait ?? Infinity, left())),
      intervalMs: CONFIRM_INTERVAL_MS,
      probe: async budget => reading(await control(script, 'status', app, budget)),
    });
    return seen.outcome === 'reached' ? respond('launched', true, true) : respond('timeout', seen.running, true);
  }
  return async (ctx, req, res, path, method) => {
    if (path === PATH && method === 'GET') {
      if (!cached || now() - cached.at >= 30_000) cached = { at: now(), view: snapshot() };
      try { sendJson(res, 200, await cached.view); }
      catch { sendJson(res, 503, { error: 'fleet apps unavailable' }); }
      return true;
    }
    if (path !== `${PATH}/action`) return false;
    if (method !== 'POST') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    if (!ctx.allowDispatch) { sendJson(res, 404, { error: 'not found' }); return true; }
    if (!passesMutationGate(req, res, ctx.token)) return true;
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress ?? '') || req.headers['x-ashlr-channel'] === 'mobile') {
      sendJson(res, 403, { error: 'local request required' }); return true;
    }
    let body: unknown;
    try { body = JSON.parse(await readBody(req)); } catch { body = null; }
    if (!record(body) || Object.keys(body).some(k => k !== 'app' && k !== 'action' && k !== 'waitRunningMs') ||
      !FLEET_APPS.some(app => app === body.app) || (typeof body.action !== 'string' || !['launch', 'focus', 'restart', 'ensure'].includes(body.action))) {
      sendJson(res, 400, { code: 'VERSE_INVALID', error: 'invalid app action' }); return true;
    }
    // Validated before anything runs; focus never has a running state to wait for.
    const wait = body.waitRunningMs;
    if (wait !== undefined && (body.action === 'focus' || typeof wait !== 'number' || !Number.isInteger(wait) || wait < 1 || wait > MAX_WAIT_RUNNING_MS)) {
      sendJson(res, 400, { code: 'VERSE_INVALID', error: 'invalid app action' }); return true;
    }
    const app = body.app as string;
    // A busy app rejects all actions until its current action settles.
    if (inFlight.has(app)) { sendJson(res, 409, { code: 'VERSE_APP_BUSY', error: 'app action in progress' }); return true; }
    const script = locate();
    if (!script) { sendJson(res, 503, { error: 'fleet apps unavailable' }); return true; }
    inFlight.add(app);
    try {
      if (body.action === 'ensure') {
        const answer = await ensure(script, app, typeof wait === 'number' ? wait : undefined);
        sendJson(res, answer.http, answer.body);
        return true;
      }
      const deadline = Date.now() + ACTION_BUDGET_MS;
      const result = await run(script, body.action as string, app, ACTION_BUDGET_MS);
      if (result.ok === true && typeof result.code === 'string') {
        const accepted = { app, action: body.action, code: result.code };
        let confirmation: { target: 'running'; outcome: string; attempts: number; running: boolean | null; confirmed: boolean } | undefined;
        if (typeof wait === 'number') {
          // Observe only: sequential status probes, never a second launch or retry of the action.
          const seen = await awaitAppState({
            target: 'running',
            timeoutMs: Math.min(wait, Math.max(0, deadline - Date.now())),
            intervalMs: CONFIRM_INTERVAL_MS,
            probe: async budget => {
              try {
                const status = await run(script, 'status', app, Math.max(1, Math.ceil(budget)));
                return status.ok === true && typeof status.running === 'boolean' ? status.running : null;
              } catch { return null; }
            },
          });
          confirmation = { target: 'running', outcome: seen.outcome, attempts: seen.attempts, running: seen.running, confirmed: seen.outcome === 'reached' && seen.running === true };
        }
        sendJson(res, 202, { ...accepted, at: new Date(now()).toISOString(), ...(confirmation ? { confirmation } : {}) });
      } else if (result.ok === false && typeof result.code === 'string' && Object.hasOwn(REFUSALS, result.code)) {
        const needsMason = result.code === 'permission_denied' && result.needs_mason_written === true;
        sendJson(res, 422, { code: result.code, error: REFUSALS[result.code], ...(needsMason ? { needsMason: true } : {}) });
      } else if (result.ok === false && result.code === 'unavailable') {
        sendJson(res, 503, UNAVAILABLE);
      } else throw new Error('unreadable result');
    } catch { sendJson(res, 503, UNAVAILABLE); }
    finally { inFlight.delete(app); cached = undefined; }
    return true;
  };
}
export const handleFleetAppsApi: ApiModule = createFleetAppsApi();
