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
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
// Same identity rule as fleet-standby.ts, which does not export its validator.
const identity = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(v);
const nullableIdentity = (v: unknown) => v === null || identity(v);
export function createFleetStandbyApi(deps: FleetStandbyApiDeps = {}): ApiModule {
  const now = deps.now ?? Date.now;
  const root = deps.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const exec: FleetStandbyExec = deps.exec ?? (async (file, argv, options) => execAsync(file, argv, options));
  let cached: { at: number; view: Promise<object> } | undefined;
  async function snapshot(): Promise<object> {
    const base = { v: 1, generatedAt: new Date(now()).toISOString() };
    let config: unknown;
    try { config = JSON.parse(await readFile(join(root, 'standby.json'), 'utf8')); } catch { /* Not configured. */ }
    if (!record(config) || config.v !== 1 ||
      !['db', 'snapshotStore'].every(k => typeof config[k] === 'string' && (config[k] as string).trim().length > 0) ||
      !identity(config.primary) || !identity(config.role) || !identity(config.host) ||
      (config.maxAgeSec !== undefined && (typeof config.maxAgeSec !== 'number' || !Number.isInteger(config.maxAgeSec) || config.maxAgeSec < 60 || config.maxAgeSec > 86400))) {
      return { ...base, configured: false };
    }
    const unavailable = { ...base, configured: true, available: false };
    try {
      const script = await (deps.locateScript ?? findStandbyReadinessScript)();
      if (!script) return unavailable;
      // -B like the CLI: -I would drop the script directory from sys.path and break its sibling imports.
      const argv = ['-B', script, '--db', config.db as string, '--snapshot-store', config.snapshotStore as string,
        '--primary', config.primary, '--role', config.role, '--host', config.host];
      if (config.maxAgeSec !== undefined) argv.push('--max-age', String(config.maxAgeSec));
      const { stdout } = await exec('python3', argv, { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true });
      const report: unknown = JSON.parse(stdout);
      if (!record(report) || typeof report.ready !== 'boolean' || !Array.isArray(report.blockers) ||
        !report.blockers.every(identity) || !nullableIdentity(report.leaseHolder) ||
        !(report.snapshotAgeSec === null || (typeof report.snapshotAgeSec === 'number' && Number.isFinite(report.snapshotAgeSec) && report.snapshotAgeSec >= 0))) return unavailable;
      return { ...base, configured: true, available: true, ready: report.ready,
        blocker: report.blockers[0] ?? null, leaseHolder: report.leaseHolder, snapshotAgeSec: report.snapshotAgeSec };
    } catch { return unavailable; } // Never echo stderr or config paths.
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
