import { apiGet } from '../../data/client.js';
import type { QueryDef } from '../../data/queries.js';
import { parseFleetUsage, type FleetUsageV1 } from './fleet-usage-model.js';

export type FleetUsageLoader = (signal?: AbortSignal) => Promise<FleetUsageV1>;

export const FLEET_USAGE_PATH = '/api/app/fleet-usage';

/** Live readings from GET /api/app/fleet-usage (src/core/resources/fleet-usage.ts). Payloads are validated, never trusted. */
export const fleetUsageLoader: FleetUsageLoader = async signal =>
  parseFleetUsage(await apiGet<unknown>(FLEET_USAGE_PATH, signal));

export const fleetUsageQuery: QueryDef<FleetUsageV1> = { key: 'fleet-usage', fetch: signal => fleetUsageLoader(signal) };
