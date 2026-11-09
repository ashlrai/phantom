/**
 * Per-node local model lanes for the unified pool (RQ-OMLX-DISTILL-1 on
 * RQ-MULTINODE-1). `~/.ashlr/local-lanes.json` opts a Mac in; the planner in
 * local-runtime/omlx/models.ts turns RAM plus live headroom into the caps the
 * node advertises at `phm node join` / `phm node worker` time. Swap and memory
 * pressure back the lane off: advertised caps always reflect the last probe.
 */
import { existsSync, readFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { ashlrHome } from '../../cloud/store.js';
import { readMacHostHeadroom, type HostHeadroom } from '../../run/host-headroom.js';
import {
  LANE_MAX_SLOTS, OMLX_MODEL_CATALOG, planOmlxLocalLanes,
  type OmlxLaneConfig, type OmlxLanePlan,
} from '../../local-runtime/omlx/models.js';

export function localLaneConfigPath(home = ashlrHome()): string {
  return join(home, 'local-lanes.json');
}

const CONFIG_KEYS = new Set(['schemaVersion', 'enabled', 'model', 'maxSlots']);
const CONFIG_USAGE = '{"schemaVersion":1,"enabled":true,"model":"<catalog id>","maxSlots":1-4}';

export interface LocalLaneConfigResult { config: OmlxLaneConfig | null; error: string | null }

/** Strict parse; an unreadable or malformed file means "not configured", never guessed defaults. */
export function readLocalLaneConfig(path = localLaneConfigPath()): LocalLaneConfigResult {
  if (!existsSync(path)) return { config: null, error: null };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, 'utf8')); } catch {
    return { config: null, error: 'local-lanes.json is not valid JSON' };
  }
  const c = raw as Record<string, unknown>;
  if (typeof c !== 'object' || c === null || Array.isArray(c)) {
    return { config: null, error: `local-lanes.json must be a JSON object: ${CONFIG_USAGE}` };
  }
  for (const key of Object.keys(c)) {
    if (!CONFIG_KEYS.has(key)) return { config: null, error: `local-lanes.json: unknown key '${key}'` };
  }
  if (c['schemaVersion'] !== 1 || typeof c['enabled'] !== 'boolean') {
    return { config: null, error: `local-lanes.json needs ${CONFIG_USAGE}` };
  }
  const model = c['model'];
  if (model !== undefined && (typeof model !== 'string' || !OMLX_MODEL_CATALOG.candidates.some(x => x.id === model))) {
    return { config: null, error: `local-lanes.json model must be a catalog id (${OMLX_MODEL_CATALOG.candidates.map(x => x.id).join(', ')})` };
  }
  const maxSlots = c['maxSlots'];
  if (maxSlots !== undefined && (typeof maxSlots !== 'number' || !Number.isSafeInteger(maxSlots) ||
      maxSlots < 1 || maxSlots > LANE_MAX_SLOTS)) {
    return { config: null, error: `local-lanes.json maxSlots must be an integer 1-${LANE_MAX_SLOTS}` };
  }
  return {
    config: {
      enabled: c['enabled'] as boolean,
      ...(model === undefined ? {} : { model: model as string }),
      ...(maxSlots === undefined ? {} : { maxSlots: maxSlots as number }),
    },
    error: null,
  };
}

export interface LocalLaneProbe {
  config: OmlxLaneConfig | null;
  configError: string | null;
  plan: OmlxLanePlan;
}
export interface LocalLaneProbeDeps {
  configPath?: string;
  headroom?: () => HostHeadroom | null;
  totalBytes?: () => number;
  platform?: string;
}

/** The node's lane plan as it stands right now: config, RAM class and live headroom. */
export function localLanePlan(deps: LocalLaneProbeDeps = {}): LocalLaneProbe {
  const { config, error } = readLocalLaneConfig(deps.configPath ?? localLaneConfigPath());
  const plan = planOmlxLocalLanes({
    totalBytes: (deps.totalBytes ?? totalmem)(),
    headroom: config?.enabled === true ? (deps.headroom ?? readMacHostHeadroom)() : null,
    config,
    platform: deps.platform,
  });
  return { config, configError: error, plan };
}

/** Caps to merge into `phm node join --caps` / worker advertisement; [] unless advertised. */
export function probeLocalModelCaps(deps: LocalLaneProbeDeps = {}): string[] {
  try { return localLanePlan(deps).plan.caps; } catch { return []; }
}
