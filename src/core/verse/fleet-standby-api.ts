/** Read-only standby projection; private config and child diagnostics stay local. */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { findStandbyReadinessScript, type FleetStandbyDeps, type FleetStandbyExec } from '../../cli/fleet-standby.js';
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';

export interface FleetStandbyApiDeps extends FleetStandbyDeps { runsDir?: string; now?: () => number }
const execAsync = promisify(execFile);
// Matches the former exec cap; now the ceiling for config read, discovery and child combined.
const PROBE_BUDGET_MS = 30_000;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
// Same identity rule as fleet-standby.ts, which does not export its validator.
const identity = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(v);
const nullableIdentity = (v: unknown) => v === null || identity(v);
export function createFleetStandbyApi(deps: FleetStandbyApiDeps = {}): ApiModule {
  const now = deps.now ?? Date.now;
  const root = deps.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const exec: FleetStandbyExec = deps.exec ?? (async (file, argv, options) => execAsync(file, argv, options));
  let cached: { at: number; view: Promise<object> } | undefined;
  // One wall budget covers config read, discovery and the child; exec gets only what remains.
  async function snapshot(): Promise<object> {
    const base = { v: 1, generatedAt: new Date(now()).toISOString() };
    const started = now();
    // Latest learned projection; returned as-is if the budget expires before the probe settles.
    let known: object = { ...base, configured: false };
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<object>(resolve => {
      timer = setTimeout(() => { expired = true; resolve(known); }, PROBE_BUDGET_MS);
    });
    // Never rejects: every failure settles as a projection, and late results after expiry are dropped.
    const probe = (async (): Promise<object> => {
      try {
        let config: unknown;
        try { config = JSON.parse(await readFile(join(root, 'standby.json'), 'utf8')); } catch { /* Not configured. */ }
        if (expired || !record(config) || config.v !== 1 ||
          !['db', 'snapshotStore'].every(k => typeof config[k] === 'string' && (config[k] as string).trim().length > 0) ||
          !identity(config.primary) || !identity(config.role) || !identity(config.host) ||
          (config.maxAgeSec !== undefined && (typeof config.maxAgeSec !== 'number' || !Number.isInteger(config.maxAgeSec) || config.maxAgeSec < 60 || config.maxAgeSec > 86400))) {
          return known;
        }
        known = { ...base, configured: true, available: false };
        // Discovery resolving after expiry must not start a child.
        const script = await (deps.locateScript ?? findStandbyReadinessScript)();
        if (!script || expired) return known;
        // -B like the CLI: -I would drop the script directory from sys.path and break its sibling imports.
        const argv = ['-B', script, '--db', config.db as string, '--snapshot-store', config.snapshotStore as string,
          '--primary', config.primary, '--role', config.role, '--host', config.host];
        if (config.maxAgeSec !== undefined) argv.push('--max-age', String(config.maxAgeSec));
        // execFile treats timeout 0 as unbounded, so the floor of 1 ms is load-bearing.
        const timeout = Math.max(1, PROBE_BUDGET_MS - (now() - started));
        const { stdout } = await exec('python3', argv, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, windowsHide: true });
        const report: unknown = JSON.parse(stdout);
        if (!record(report) || typeof report.ready !== 'boolean' || !Array.isArray(report.blockers) ||
          !report.blockers.every(identity) || !nullableIdentity(report.leaseHolder) ||
          !(report.snapshotAgeSec === null || (typeof report.snapshotAgeSec === 'number' && Number.isFinite(report.snapshotAgeSec) && report.snapshotAgeSec >= 0))) return known;
        return { ...base, configured: true, available: true, ready: report.ready,
          blocker: report.blockers[0] ?? null, leaseHolder: report.leaseHolder, snapshotAgeSec: report.snapshotAgeSec };
      } catch { return known; } // Never echo stderr or config paths.
    })();
    try { return await Promise.race([probe, expiry]); } finally { clearTimeout(timer); }
  }
  return async (_ctx, _req, res, path, method) => {
    if (path !== '/api/verse/fleet/standby') return false;
    if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
    if (!cached || now() - cached.at >= 30_000) cached = { at: now(), view: snapshot() };
    sendJson(res, 200, await cached.view);
    return true;
  };
}
export const handleFleetStandbyApi: ApiModule = createFleetStandbyApi();
