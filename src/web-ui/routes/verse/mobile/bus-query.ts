import { ApiError, apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export interface BusLite {
  hops: number;
  inputTokens: number | null;
  outputTokens: number | null;
  events: Array<{ at: string; kind: string; text: string }>;
  sources: { hops: string; events: string };
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const tokens = (value: unknown): value is number | null => value === null || count(value);
const source = (value: unknown): value is string => value === 'healthy' || value === 'missing' || value === 'degraded';

/** Read only the fields the phone displays, without importing the desktop feed. */
export function narrowBusLite(raw: unknown): BusLite | null {
  if (!record(raw) || raw.v !== 1 || !Array.isArray(raw.hops) || !Array.isArray(raw.events)
    || !record(raw.sources) || !source(raw.sources.hops) || !source(raw.sources.events)) return null;
  let inputTokens: number | null = 0;
  let outputTokens: number | null = 0;
  for (const hop of raw.hops) {
    if (!record(hop) || !tokens(hop.inputTokens) || !tokens(hop.outputTokens)) return null;
    inputTokens = inputTokens === null || hop.inputTokens === null ? null : inputTokens + hop.inputTokens;
    outputTokens = outputTokens === null || hop.outputTokens === null ? null : outputTokens + hop.outputTokens;
  }
  const events: BusLite['events'] = [];
  for (const event of raw.events) {
    if (!record(event) || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))
      || typeof event.kind !== 'string' || typeof event.text !== 'string') return null;
    events.push({ at: event.at, kind: event.kind, text: event.text });
  }
  events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return { hops: raw.hops.length, inputTokens, outputTokens, events: events.slice(0, 20),
    sources: { hops: raw.sources.hops, events: raw.sources.events } };
}

const BUS_PATH = '/api/verse/fleet/live/bus?limit=20';
let missing = false;

export const busLiteQuery: QueryDef<BusLite | null> = {
  key: 'verse-mobile-bus',
  fetch: async (signal) => {
    if (missing) return null;
    try {
      const data = narrowBusLite(await apiGet<unknown>(BUS_PATH, signal));
      if (data === null) throw new ApiError(`GET ${BUS_PATH} answered a shape this build cannot read.`, 502, BUS_PATH);
      return data;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        missing = true;
        return null;
      }
      throw error;
    }
  },
};

export function resetBusMissingForTest(): void {
  missing = false;
}
