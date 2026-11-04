import { apiGet } from '../../data/client.js';
import type { QueryDef } from '../../data/queries.js';
import { FLEET_USAGE_FIXTURE } from './fleet-usage.fixture.js';
import { parseFleetUsage, type FleetUsageV1 } from './fleet-usage-model.js';

export type FleetUsageLoader = (signal?: AbortSignal) => Promise<FleetUsageV1>;

export const FLEET_USAGE_PATH = '/api/app/fleet-usage';

/** Live feed (RQ-RESOURCES-1-FEED). Payloads are validated, never trusted. */
export const endpointFleetUsageLoader: FleetUsageLoader = async signal =>
  parseFleetUsage(await apiGet<unknown>(FLEET_USAGE_PATH, signal));

/** Fixture-backed loader used until the endpoint ships; timestamps are relative to now. */
export const fixtureFleetUsageLoader: FleetUsageLoader = async () => parseFleetUsage(FLEET_USAGE_FIXTURE(Date.now()));

/** The one-line swap: point this at `endpointFleetUsageLoader` once GET /api/app/fleet-usage is on master. */
export const fleetUsageLoader: FleetUsageLoader = fixtureFleetUsageLoader;

export const fleetUsageQuery: QueryDef<FleetUsageV1> = { key: 'fleet-usage', fetch: signal => fleetUsageLoader(signal) };
