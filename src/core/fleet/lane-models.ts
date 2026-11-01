/**
 * lane-models.ts — RQ-PHX-LANEMODELVIEW31: read-only `fleet.lane-models.v1`
 * projection backing `phm fleet lane-models`. Proves which model each
 * (lane, tier) resolves to from `~/.ashlr-runs/models.json` and flags a lane
 * whose newest `launch` row in `metrics/jobs.jsonl` ran another model.
 * Bounded reads only — never writes; each source fails independently.
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export interface LaneModelLaunch { lane: string; tier: string | null; model: string; at: string | null }
export interface LaneModelTierRow { tier: string; model: string | null; via: string | null }
export interface LaneModelLane { lane: string; family: string; tiers: LaneModelTierRow[]; lastLaunch: LaneModelLaunch | null; mismatch: boolean }
export interface LaneModelSnapshot {
  schema: 'fleet.lane-models.v1'; generatedAt: string; tiers: string[]; lanes: LaneModelLane[];
  sources: {
    models: { state: 'healthy' | 'missing' | 'degraded'; file: 'models.json'; entries: number };
    launches: { state: 'healthy' | 'missing' | 'degraded'; file: 'metrics/jobs.jsonl'; launches: number; dropped: number };
  };
}
/** runsDir: `$ASHLR_RUNS_DIR` else `~/.ashlr-runs`; models.json + metrics/jobs.jsonl beneath it. */
export interface LaneModelViewOptions { runsDir?: string; modelsPath?: string; now?: () => Date }

const MAX_BYTES = 4 * 1024 * 1024;
const LANE_RE = /^[a-z][a-z0-9-]{0,62}$/;
const TIER_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/;
const KNOWN_TIERS = ['frontier', 'work', 'mid', 'fast', 'low']; // launch.sh tiers (runs-live-workers.ts)

const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const pick = (row: Record<string, unknown>, ...keys: string[]): string | null => {
  const v = keys.map(k => row[k]).find(v => typeof v === 'string' && v.trim());
  return typeof v === 'string' ? v.trim().slice(0, 512) : null;
};

/** The map family a lane inherits: `codex` for codex lanes, else itself. */
export const laneModelFamily = (lane: string): string =>
  lane === 'codex' || lane.startsWith('codex-') ? 'codex' : lane;

/** First non-empty of `<lane>.<tier>`, `<lane>`, `<family>.<tier>`, `<family>`. */
export const resolveLaneModel = (map: ReadonlyMap<string, string>, lane: string, tier: string): { model: string; via: string } | null => {
  const family = laneModelFamily(lane);
  for (const key of family === lane ? [`${lane}.${tier}`, lane] : [`${lane}.${tier}`, lane, `${family}.${tier}`, family]) {
    const model = map.get(key);
    if (model) return { model, via: key };
  }
  return null;
};

/** Flatten models.json into `lane[.tier]` → model; invalid entries dropped. */
export function parseModelsJson(text: string): { map: Map<string, string>; dropped: number } {
  const map = new Map<string, string>();
  let dropped = 0;
  const root = record(JSON.parse(text));
  if (!root) throw new Error('models.json is not a JSON object');
  for (const [key, value] of Object.entries(root)) {
    const dot = key.indexOf('.');
    const [lane, tier] = dot < 0 ? [key, null] : [key.slice(0, dot), key.slice(dot + 1)];
    if (!LANE_RE.test(lane) || (tier !== null && !TIER_RE.test(tier)) ||
        typeof value !== 'string' || !MODEL_RE.test(value.trim())) { dropped++; continue; }
    map.set(key, value.trim());
  }
  return { map, dropped };
}

/** Newest `launch` row per lane — append order is the ledger's own clock. */
export function parseJobLaunches(text: string): { latest: Map<string, LaneModelLaunch>; launches: number; dropped: number } {
  const latest = new Map<string, LaneModelLaunch>();
  let launches = 0, dropped = 0;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let row: Record<string, unknown> | null;
    try { row = record(JSON.parse(line)); } catch { dropped++; continue; }
    if (!row) { dropped++; continue; }
    if (!['launch', 'launched'].includes(pick(row, 'event', 'type') ?? '')) continue;
    launches++;
    const [lane, model] = [pick(row, 'lane', 'pool', 'arm', 'account'), pick(row, 'model')];
    if (!lane || !LANE_RE.test(lane) || !model || !MODEL_RE.test(model)) { dropped++; continue; }
    const [tier, at] = [pick(row, 'tier'), pick(row, 'ts', 'at', 'timestamp', 'launchedAt', 'startedAt', 'time')];
    latest.set(lane, {
      lane, model, tier: tier && TIER_RE.test(tier) ? tier : null,
      at: at && Number.isFinite(Date.parse(at)) ? new Date(at).toISOString() : null,
    });
  }
  return { latest, launches, dropped };
}

/** Descriptor-bound read; refuses symlinks and oversized files. */
async function readBounded(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error('invalid source');
    return (await handle.readFile('utf8')).slice(0, MAX_BYTES);
  } finally { await handle.close(); }
}
/** Read + parse one source; never throws — 'missing' on ENOENT, else 'degraded'. */
async function guarded<T extends { dropped: number }>(path: string, parse: (text: string) => T): Promise<{ state: 'healthy' | 'missing' | 'degraded'; parsed: T | null }> {
  try {
    const parsed = parse(await readBounded(path));
    return { state: parsed.dropped ? 'degraded' : 'healthy', parsed };
  } catch (e) { return { state: record(e)?.code === 'ENOENT' ? 'missing' : 'degraded', parsed: null }; }
}

export async function getLaneModelSnapshot(opts: LaneModelViewOptions = {}): Promise<LaneModelSnapshot> {
  const runsDir = opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const snapshot: LaneModelSnapshot = {
    schema: 'fleet.lane-models.v1', generatedAt: (opts.now ?? (() => new Date()))().toISOString(),
    sources: {
      models: { state: 'missing', file: 'models.json', entries: 0 },
      launches: { state: 'missing', file: 'metrics/jobs.jsonl', launches: 0, dropped: 0 } },
    tiers: [], lanes: [],
  };
  const modelsPath = opts.modelsPath ?? join(runsDir, 'models.json');
  if (!isAbsolute(runsDir) || !isAbsolute(modelsPath)) {
    snapshot.sources.models.state = snapshot.sources.launches.state = 'degraded';
    return snapshot;
  }
  const models = await guarded(modelsPath, parseModelsJson);
  const launches = await guarded(join(runsDir, 'metrics', 'jobs.jsonl'), parseJobLaunches);
  const map = models.parsed?.map ?? new Map<string, string>();
  const latest = launches.parsed?.latest ?? new Map<string, LaneModelLaunch>();
  snapshot.sources.models = { state: models.state, file: 'models.json', entries: models.parsed?.map.size ?? 0 };
  snapshot.sources.launches = { state: launches.state, file: 'metrics/jobs.jsonl',
    launches: launches.parsed?.launches ?? 0, dropped: launches.parsed?.dropped ?? 0 };

  // Lanes are named by map keys or launches — never invented; tiers = canonical + observed extras.
  const observed = new Set<string>(), laneIds = new Set<string>();
  for (const key of map.keys()) { laneIds.add(key.split('.')[0]!); if (key.includes('.')) observed.add(key.slice(key.indexOf('.') + 1)); }
  for (const [lane, launch] of latest) { laneIds.add(lane); if (launch.tier) observed.add(launch.tier); }
  const tiers = snapshot.tiers = [...KNOWN_TIERS, ...[...observed].filter(t => !KNOWN_TIERS.includes(t)).sort()];
  snapshot.lanes = [...laneIds].sort().map(lane => {
    const lastLaunch = latest.get(lane) ?? null;
    const rows = tiers.map(tier => ({ tier, ...(resolveLaneModel(map, lane, tier) ?? { model: null, via: null }) }));
    const mismatch = !lastLaunch ? false : lastLaunch.tier
      ? (resolveLaneModel(map, lane, lastLaunch.tier)?.model ?? null) !== lastLaunch.model
      : !rows.some(r => r.model === lastLaunch.model);
    return { lane, family: laneModelFamily(lane), tiers: rows, lastLaunch, mismatch };
  });
  return snapshot;
}
