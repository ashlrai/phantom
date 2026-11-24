import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import type { FleetCompute } from '../../../../core/fleet/compute-view.js';
import type { FleetMessageGraph } from '../../../../core/fleet/message-graph.js';
import type { MapMessage, MapMessages } from '../../../../core/fleet/map-messages.js';
import type { FleetSessionMap } from '../../../../core/fleet/sessions-view.js';
import { isFleetCompute, isFleetSessionMap } from '../../verse/company/compute-model.js';

export const fleetComputeQuery: QueryDef<FleetCompute> = {
  key: 'fleet-map-compute',
  fetch: async signal => {
    const value = await apiGet<unknown>('/api/verse/fleet/control/compute', signal);
    if (!isFleetCompute(value)) throw new Error('Unsupported compute observation');
    return value;
  },
};
export const fleetSessionMapQuery: QueryDef<FleetSessionMap> = {
  key: 'fleet-map-sessions',
  fetch: async signal => {
    const value = await apiGet<unknown>('/api/verse/fleet/control/sessions', signal);
    if (!isFleetSessionMap(value)) throw new Error('Unsupported session observation');
    return value;
  },
};

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const counted = (row: Record<string, unknown>) => ['id', 'from', 'to', 'lastAt'].every(key => typeof row[key] === 'string') && typeof row.count === 'number';
/** A readable fleet.message-graph.v1: every group and edge has its names, count and last time. */
export function isFleetMessageGraph(value: unknown): value is FleetMessageGraph & { groups: NonNullable<FleetMessageGraph['groups']> } {
  return record(value) && value.schema === 'fleet.message-graph.v1' && value.version === 1 && typeof value.since === 'string' && Array.isArray(value.groups)
    && value.groups.every(group => record(group) && counted(group) && Array.isArray(group.edges) && group.edges.every(edge => record(edge) && counted(edge)));
}
export const fleetMessageGraphQuery: QueryDef<FleetMessageGraph & { groups: NonNullable<FleetMessageGraph['groups']> }> = {
  key: 'fleet-map-message-graph',
  fetch: async signal => {
    const value = await apiGet<unknown>('/api/fleet/message-graph', signal);
    if (!isFleetMessageGraph(value)) throw new Error('Unsupported message graph');
    return value;
  },
};

/** One computer's badge from `phm nodes plan --json`; "unknown" is kept as unknown. */
export interface NodeBadge { name: string; online: boolean | 'unknown'; slots: number | 'unknown'; why: string }
/** Narrow a phantom.nodes-plan.v1 body to badges; malformed rows are dropped, malformed fields become unknown. */
export function narrowNodeBadges(value: unknown): NodeBadge[] | null {
  if (!record(value) || value.schema !== 'phantom.nodes-plan.v1' || !Array.isArray(value.nodes)) return null;
  return value.nodes.filter(row => record(row) && typeof row.name === 'string' && row.name !== '').map(row => {
    const r = row as Record<string, unknown>;
    return {
      name: (r.name as string).slice(0, 160),
      online: typeof r.online === 'boolean' ? r.online : 'unknown',
      slots: typeof r.suggested_slots === 'number' && Number.isFinite(r.suggested_slots) && r.suggested_slots >= 0 ? r.suggested_slots : 'unknown',
      why: typeof r.why === 'string' ? r.why.slice(0, 200) : '',
    };
  });
}
export const fleetNodesPlanQuery: QueryDef<NodeBadge[] | null> = {
  key: 'fleet-map-nodes-plan',
  fetch: async signal => narrowNodeBadges(await apiGet<unknown>('/api/verse/fleet/runtime-identity/nodes-plan', signal).catch(() => null)),
};

const MAP_MESSAGE_KEYS = ['id', 'from', 'to', 'kind', 'summary', 'at'] as const;
/** A readable fleet.map-messages.v1 with a message list: every row has its names, kind, summary and time. */
export function isMapMessages(value: unknown): value is MapMessages & { messages: MapMessage[] } {
  return record(value) && value.schema === 'fleet.map-messages.v1' && value.version === 1 && Array.isArray(value.messages)
    && value.messages.every(row => record(row) && MAP_MESSAGE_KEYS.every(key => typeof row[key] === 'string') && Number.isFinite(Date.parse(row.at as string))
      && (row.fromNode === null || typeof row.fromNode === 'string') && (row.toNode === null || typeof row.toNode === 'string'));
}
export const fleetMapMessagesQuery: QueryDef<MapMessages & { messages: MapMessage[] }> = {
  key: 'fleet-map-messages',
  fetch: async signal => {
    const value = await apiGet<unknown>('/api/fleet/map/messages', signal);
    if (!isMapMessages(value)) throw new Error('Unsupported map messages');
    return value;
  },
};
