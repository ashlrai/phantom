/** Read-only host memory + memguard projection. No repair or dispatch authority. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFleetMemoryFiles, type FleetMemoryFiles } from '../fleet/memory-files.js';
import { memoryView, type FleetMemoryView } from '../fleet/memory-view.js';
import { readEngineAdmission, type EngineAdmissionView } from '../fleet/engine-admission-view.js';
import { sendJson } from '../web/api.js';
import type { ApiModule } from './api-modules.js';

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
  now?: () => number;
}

/** ASHLR_RUNS_DIR overrides ~/.ashlr-runs — the fleet runs-dir convention fleet-runs-api uses. */
function defaultRunsDir(): string {
  return process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
}

export function createFleetMemoryApi(deps: FleetMemoryApiDeps = {}): ApiModule {
  const read = deps.readFiles ?? readFleetMemoryFiles;
  const readAdmission = deps.readAdmission ?? readEngineAdmission;
  const now = deps.now ?? Date.now;
  return async (_ctx, _req, res, path, method) => {
    if (path !== VERSE_FLEET_MEMORY_PATH || method !== 'GET') return false;
    try {
      const files = await read(deps.runsDir ?? defaultRunsDir());
      const view = memoryView(files.memstat, files.memguard, now());
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
