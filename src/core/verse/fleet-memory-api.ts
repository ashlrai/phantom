/** Read-only host memory + memguard projection. No repair or dispatch authority. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFleetStartStatus } from '../fleet/admission-status.js';
import { readFamilyYield } from '../fleet/family-yield.js';
import type { YieldLineReader } from '../fleet/ledger-lines.js';
import { readFleetMemoryFiles, type FleetMemoryFiles } from '../fleet/memory-files.js';
import { memoryView, type FleetMemoryView } from '../fleet/memory-view.js';
import { readEngineAdmission, type EngineAdmissionView } from '../fleet/engine-admission-view.js';
import { diskForecast } from '../fleet/disk-forecast.js';
import { readHostLoadReport, type HostLoadReport } from '../fleet/host-load.js';
import { readDiskPlan } from '../../cli/disk.js';
import type { DiskPlanReportV1 } from '../disk-maint/removal-plan.js';
import { readHostTopReport, type HostTopReport } from '../fleet/host-top.js';
import { sanitizePublicJson } from '../util/public-json.js';
import { readSource } from '../fleet/runs-parked-queue.js';
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';

export const VERSE_FLEET_DISK_FORECAST_PATH = '/api/verse/fleet/memory/disk-forecast';
/** What is loading this host, by group: the same host.load.v1 report `phm host load --json` prints. */
export const VERSE_FLEET_HOST_LOAD_PATH = '/api/verse/fleet/memory/host-load';
/** What is using this Mac, by bucket, with one suggestion: the same host.top.v1 report `phm host top --json` prints. */
export const VERSE_FLEET_HOST_TOP_PATH = '/api/verse/fleet/memory/host-top';
/** Where the disk is going and which finished job folders are safe to remove: the same disk.plan.v1 `phm disk --plan --json` prints. Reads only. */
export const VERSE_FLEET_DISK_PLAN_PATH = '/api/verse/fleet/memory/disk-plan';
export const VERSE_FLEET_MEMORY_PATH = '/api/verse/fleet/memory';
export interface FleetMemoryResponseV1 {
  v: 1;
  generatedAt: string;
  memory: FleetMemoryView & { engine_admission: EngineAdmissionView };
}
export interface FleetMemoryApiDeps {
  /** Reads <root>/memstat.json and <root>/.memguard2.json; injected in tests. */
  readFiles?: (root: string) => Promise<FleetMemoryFiles>;
  /** Samples the engine launch gate's current verdict; injected in tests. */
  readAdmission?: () => EngineAdmissionView;
  /** Runs root holding the memory files. Default: ASHLR_RUNS_DIR, then ~/.ashlr-runs. */
  runsDir?: string;
  readDiskSources?: (root: string) => Promise<[string | null, string | null]>;
  /** Runs ps and reads the job claims; injected in tests. */
  readHostLoad?: (opts?: { byTree?: boolean }) => Promise<HostLoadReport>;
  /** Reads ps, vm_stat, swap, pressure and the app in front; injected in tests. */
  readHostTop?: () => Promise<HostTopReport>;
  /** Scans job folders and the free-disk trend; injected in tests. */
  readDiskPlan?: () => Promise<DiskPlanReportV1>;
  now?: () => number;
  readYieldLines?: YieldLineReader;
}

/** ASHLR_RUNS_DIR overrides ~/.ashlr-runs — the fleet runs-dir convention fleet-runs-api uses. */
function defaultRunsDir(): string {
  return process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
}

async function readDiskSources(root: string): Promise<[string | null, string | null]> {
  const read = async (path: string) => {
    const source = await readSource(path, 5 * 1024 * 1024, false);
    return source.state === 'healthy' ? source.text : null;
  };
  return Promise.all([read(join(root, 'queue', 'disk-growth-history.json')), read(join(root, 'metrics', 'jobs.jsonl'))]);
}

export function createFleetMemoryApi(deps: FleetMemoryApiDeps = {}): ApiModule {
  const read = deps.readFiles ?? readFleetMemoryFiles;
  const readAdmission = deps.readAdmission ?? readEngineAdmission;
  const now = deps.now ?? Date.now;
  return async (_ctx, _req, res, path, method) => {
    if (path === '/api/verse/fleet/yield') {
      if (method !== 'GET') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
      sendJson(res, 200, sanitizePublicJson(await readFamilyYield(join(deps.runsDir ?? defaultRunsDir(), 'metrics/jobs.jsonl'), 24, now(), deps.readYieldLines)));
      return true;
    }
    if (path === '/api/verse/fleet/admission') {
      if (method !== 'GET') { sendJson(res, 405, { v: 1, error: 'method not allowed' }); return true; }
      sendJson(res, 200, await readFleetStartStatus({ runsDir: deps.runsDir, now: now() }));
      return true;
    }
    if (path === VERSE_FLEET_DISK_FORECAST_PATH) {
      if (method !== 'GET') { sendJson(res, 405, { v: 1, error: 'method not allowed' }); return true; }
      let sources: [string | null, string | null] = [null, null];
      try { sources = await (deps.readDiskSources ?? readDiskSources)(deps.runsDir ?? defaultRunsDir()); } catch { /* Unknown evidence. */ }
      sendJson(res, 200, { v: 1, forecast: diskForecast(...sources, now()) });
      return true;
    }
    if (path === VERSE_FLEET_HOST_LOAD_PATH) {
      if (method !== 'GET') { sendJson(res, 405, { v: 1, error: 'method not allowed' }); return true; }
      sendJson(res, 200, sanitizePublicJson(await (deps.readHostLoad ?? readHostLoadReport)(
        { byTree: new URL(_req.url ?? '', 'http://local').searchParams.get('by') === 'tree' })));
      return true;
    }
    if (path === VERSE_FLEET_DISK_PLAN_PATH) {
      if (method !== 'GET') { sendJson(res, 405, { v: 1, error: 'method not allowed' }); return true; }
      try { sendJson(res, 200, sanitizePublicJson(await (deps.readDiskPlan ?? readDiskPlan)())); }
      catch { sendJson(res, 503, { v: 1, error: 'disk plan unavailable' }); }
      return true;
    }
    if (path === VERSE_FLEET_HOST_TOP_PATH) {
      if (method !== 'GET') { sendJson(res, 405, { v: 1, error: 'method not allowed' }); return true; }
      sendJson(res, 200, sanitizePublicJson(await (deps.readHostTop ?? readHostTopReport)()));
      return true;
    }
    if (path !== VERSE_FLEET_MEMORY_PATH || method !== 'GET') return false;
    try {
      const files = await read(deps.runsDir ?? defaultRunsDir());
      const view = memoryView(files.memstat, files.memguard, now(), files.resourceSession);
      const body: FleetMemoryResponseV1 = { v: 1, generatedAt: view.generatedAt,
        memory: { ...view, engine_admission: readAdmission() } };
      sendJson(res, 200, body);
    } catch {
      // Fixed message: thrown errors can carry absolute paths or file text.
      sendJson(res, 503, { v: 1, error: 'fleet memory unavailable' });
    }
    return true;
  };
}
export const handleFleetMemoryApi: ApiModule = createFleetMemoryApi();
