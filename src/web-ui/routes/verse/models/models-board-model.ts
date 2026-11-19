/**
 * The Models board's rows, joined from three reads and nothing else: the model registry (`phm models`), the model
 * check (`phm models check`) and the lane model table (GET /api/verse/fleet/runs/lane-models). Pure. A read that is
 * missing leaves its facts null, which the board draws as "unknown"; nothing here turns a gap into a state.
 */
import type { ModelCheckReport, ModelCheckRow, ModelCheckState } from '../../../../core/fleet/model-check.js';
import type { ModelRegistryRow } from '../../../../core/fleet/model-verify.js';
import type { FleetLaneModelsV1 } from '../../../../core/verse/fleet-lane-models-contract.js';

export type ModelFilter = 'all' | 'attention' | 'routable';
export type ModelTone = 'ok' | 'warn' | 'bad' | 'unknown';

interface Verdict {
  /** The state in words, e.g. "Confirmed", "Deprecated in docs", "Not in docs · not routable". */
  state: string;
  tone: ModelTone;
  /** The router's own answer; null when the check that holds it could not be read. */
  routable: boolean | null;
  attention: boolean;
  reason: string | null;
  /** Order inside a provider: 0 not routable, 1 deprecated, 2 stale, 3 fine, 4 retired with no lane left on it. */
  rank: number;
}
export interface BoardModel extends Verdict {
  id: string;
  /** Null when no read names a provider (a lane points at an id the registry lacks). */
  provider: string | null;
  /** Lanes that name this model, each with the tiers that pick it when the lane table says so. Empty means unknown. */
  lanes: { lane: string; tiers: string[] }[];
  /** The newest launch that was a lane's latest and used this model. */
  lastLaunch: { lane: string; tier: string | null; at: string | null } | null;
  confirmedOn: string | null;
  sourceUrl: string | null;
  replacement: string | null;
  /** Null when the registry row is absent or retired: there is nothing to verify. */
  action: 'verify' | 'recheck' | null;
}
export interface BoardGroup { provider: string | null; models: BoardModel[] }

const CHECK_LABELS: Record<ModelCheckState, string> = { confirmed: 'Confirmed', stale: 'Stale', unconfirmed: 'Unconfirmed' };
/** What provider docs say, when it changes what to do. */
const DOCS_LABELS: Partial<Record<ModelCheckRow['docs'], string>> = { retired: 'Retired in docs', unconfirmed: 'Not in docs', deprecated: 'Deprecated in docs' };

export function registryStatusText(row: ModelRegistryRow): string {
  return row.stale ? 'Stale (verified over 30 days ago)' : row.status === 'verified' ? 'Verified' : row.status === 'retired' ? 'Retired' : 'Unverified';
}

function fromCheck(row: ModelCheckRow): Verdict {
  const deprecated = row.docs === 'deprecated', stale = row.state === 'stale';
  return {
    state: `${DOCS_LABELS[row.docs] ?? CHECK_LABELS[row.state]}${row.routable ? '' : ' · not routable'}`,
    tone: !row.routable ? 'bad' : deprecated || stale ? 'warn' : 'ok', routable: row.routable,
    attention: !row.routable || deprecated || stale, reason: row.reason, rank: !row.routable ? 0 : deprecated ? 1 : stale ? 2 : 3,
  };
}
/** The registry alone: it says which names the router refuses, but not whether a verified one is routable right now. */
function fromRegistry(row: ModelRegistryRow): Verdict {
  const retired = row.status === 'retired', refused = !row.verified;
  return {
    state: `${registryStatusText(row)}${retired ? '' : refused ? ' · not routable' : ' · routing unknown'}`, tone: retired ? 'unknown' : refused ? 'bad' : row.stale ? 'warn' : 'unknown',
    routable: refused ? false : null, attention: !retired && (refused || row.stale), reason: row.reason,
    rank: retired ? 4 : refused ? 0 : row.stale ? 2 : 3,
  };
}

export interface BoardInputs {
  registry: readonly ModelRegistryRow[] | null;
  check: ModelCheckReport | null;
  lanes: FleetLaneModelsV1 | null;
}

const when = (iso: string | null): number => Date.parse(iso ?? '') || 0;

export function boardModels({ registry, check, lanes }: BoardInputs): BoardModel[] {
  const checked = new Map((check?.registry === 'ok' ? check.models : []).map(row => [row.id, row]));
  const registered = new Map((registry ?? []).map(row => [row.id, row]));
  const table = lanes?.source === 'ok' ? lanes.lanes : [];
  return [...new Set([...registered.keys(), ...checked.keys()])].map((id): BoardModel => {
    const entry = registered.get(id), row = checked.get(id);
    const tiers = new Map<string, string[]>();
    for (const lane of row?.lanes ?? entry?.lanes ?? []) tiers.set(lane, []);
    let lastLaunch: BoardModel['lastLaunch'] = null;
    for (const lane of table) {
      const picked = lane.tiers.filter(tier => tier.model === id).map(tier => tier.tier);
      if (picked.length > 0) tiers.set(lane.lane, picked);
      const launch = lane.lastLaunch;
      if (launch?.model === id && (lastLaunch === null || when(launch.at) > when(lastLaunch.at))) lastLaunch = { lane: launch.lane, tier: launch.tier, at: launch.at };
    }
    return {
      id, provider: entry?.provider ?? row?.provider ?? null,
      ...(row ? fromCheck(row) : fromRegistry(entry!)),
      lanes: [...tiers].map(([lane, picked]) => ({ lane, tiers: picked })).sort((a, b) => a.lane < b.lane ? -1 : 1),
      lastLaunch, confirmedOn: row?.confirmed_on ?? entry?.verified_on ?? null, sourceUrl: entry?.source_url ?? row?.source_url ?? null,
      replacement: row?.replacement ?? null,
      action: !entry || entry.status === 'retired' ? null : entry.verified ? 'recheck' : 'verify',
    };
  });
}

/** One group per provider, by name, with the models no read gives a provider to last. Inside a group: what needs attention first. */
export function boardGroups(models: readonly BoardModel[]): BoardGroup[] {
  const groups = new Map<string, BoardGroup>();
  for (const model of models) {
    const key = model.provider?.toLowerCase() ?? '';
    const group = groups.get(key) ?? { provider: model.provider, models: [] };
    group.models.push(model);
    groups.set(key, group);
  }
  return [...groups].sort(([a], [b]) => a === '' ? 1 : b === '' ? -1 : a < b ? -1 : 1)
    .map(([, group]) => ({ ...group, models: [...group.models].sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) }));
}

export const matchesFilter = (model: BoardModel, filter: ModelFilter): boolean =>
  filter === 'all' || (filter === 'attention' ? model.attention : model.routable === true);

export function filterCounts(models: readonly BoardModel[]): Record<ModelFilter, number> {
  return { all: models.length, attention: models.filter(m => m.attention).length, routable: models.filter(m => m.routable === true).length };
}

/** "claude (high, medium), codex-cmp": a lane with no tier in the lane table is named alone. */
export function lanesText(model: BoardModel): string | null {
  if (model.lanes.length === 0) return null;
  return model.lanes.map(({ lane, tiers }) => tiers.length > 0 ? `${lane} (${tiers.join(', ')})` : lane).join(', ');
}

/** "3 models, 2 routable"; says so when no model in the group has the router's answer. */
export function groupLine(group: BoardGroup): string {
  const count = `${group.models.length} ${group.models.length === 1 ? 'model' : 'models'}`;
  return group.models.some(model => model.routable === null) ? `${count}, routing unknown` : `${count}, ${group.models.filter(model => model.routable).length} routable`;
}
