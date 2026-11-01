import { ApiError, apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export interface AgentBusReceipt {
  cursor: number;
  receivedAt: number;
  envelope: { id: string; from: string; to: string; priority: 'P0' | 'P1' | 'P2' | 'P3'; ttl: number; body: unknown };
}
export interface AgentBusPage { v: 1; status: 'ok'; messages: AgentBusReceipt[]; nextCursor: number }
export interface AgentBusStatus {
  v: 1; source: 'available' | 'missing' | 'unavailable';
  retainedCount: number | null; retainedBytes: number | null; liveCount: number | null; expiredCount: number | null;
  maxMessages: number; maxBytes: number;
}
const record = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const count = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0;
const nullableCount = (x: unknown) => x === null || count(x);
const json = (x: unknown): boolean => x === null || typeof x === 'string' || typeof x === 'boolean'
  || (typeof x === 'number' && Number.isFinite(x)) || (Array.isArray(x) && x.every(json))
  || (record(x) && Object.values(x).every(json));

export function narrowAgentBusPage(x: unknown): AgentBusPage | null {
  if (!record(x) || x.v !== 1 || x.status !== 'ok' || !count(x.nextCursor) || !Array.isArray(x.messages)
    || !x.messages.every(row => record(row) && count(row.cursor) && row.cursor > 0 && count(row.receivedAt)
      && row.receivedAt <= 8_640_000_000_000_000 && record(row.envelope)
      && typeof row.envelope.id === 'string' && typeof row.envelope.from === 'string' && typeof row.envelope.to === 'string'
      && ['P0', 'P1', 'P2', 'P3'].includes(String(row.envelope.priority))
      && count(row.envelope.ttl) && row.envelope.ttl > 0 && json(row.envelope.body))) return null;
  return x as unknown as AgentBusPage;
}
export function narrowAgentBusStatus(x: unknown): AgentBusStatus | null {
  if (!record(x) || x.v !== 1 || !['available', 'missing', 'unavailable'].includes(String(x.source))
    || !nullableCount(x.retainedCount) || !nullableCount(x.retainedBytes) || !nullableCount(x.liveCount)
    || !nullableCount(x.expiredCount) || !count(x.maxMessages) || !count(x.maxBytes)) return null;
  return x as unknown as AgentBusStatus;
}

// Once an older hub reports the route missing, do not probe it again this page lifetime.
let missing: ApiError | null = null;
export const agentBusMissing = () => missing !== null;
async function read(path: string, signal?: AbortSignal): Promise<unknown> {
  if (missing) throw missing;
  try { return await apiGet<unknown>(path, signal); }
  catch (error) { if (error instanceof ApiError && error.status === 404) missing = error; throw error; }
}
export function agentBusPageQuery(after: number, limit = 50): QueryDef<AgentBusPage | null> {
  return { key: `verse-agent-bus:${after}:${limit}`,
    fetch: async signal => narrowAgentBusPage(await read(`/api/verse/agent-bus?after=${after}&limit=${limit}`, signal)) };
}
export const agentBusStatusQuery: QueryDef<AgentBusStatus | null> = {
  key: 'verse-agent-bus-status', fetch: async signal => narrowAgentBusStatus(await read('/api/verse/agent-bus/status', signal)),
};
