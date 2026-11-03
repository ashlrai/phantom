/** Read-only projection of retained apps-watch bus events. */
import { BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ, listBusInboxAfter } from './bus-inbox.js';
import { FLEET_APPS } from '../verse/fleet-apps-api.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const app = (v: unknown): v is string => typeof v === 'string' && (FLEET_APPS as readonly string[]).includes(v);
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const outcomes = ['running', 'launched', 'unavailable', 'launch-failed', 'timeout', 'cancelled', 'unattempted', 'unknown'];

function state(value: unknown): unknown {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length > FLEET_APPS.length) return undefined;
  const seen = new Set<string>();
  const rows: { app: string; observedRunning: boolean | null }[] = [];
  for (const row of value) {
    if (!object(row) || !app(row.app) || seen.has(row.app) || (row.observedRunning !== null && typeof row.observedRunning !== 'boolean')) return undefined;
    seen.add(row.app);
    rows.push({ app: row.app, observedRunning: row.observedRunning });
  }
  return rows;
}
function diagnostics(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (!Array.isArray(value) || value.length > FLEET_APPS.length) return undefined;
  const seen = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  for (const row of value) {
    if (!object(row) || !app(row.app) || seen.has(row.app) || typeof row.outcome !== 'string' || !outcomes.includes(row.outcome) ||
      (row.attempted !== undefined && typeof row.attempted !== 'boolean') || (row.launched !== undefined && typeof row.launched !== 'boolean') ||
      (row.reason !== undefined && row.reason !== 'deadline' && row.reason !== 'cancelled')) return undefined;
    seen.add(row.app);
    rows.push({ app: row.app, outcome: row.outcome, ...(row.attempted === undefined ? {} : { attempted: row.attempted }),
      ...(row.launched === undefined ? {} : { launched: row.launched }), ...(row.reason === undefined ? {} : { reason: row.reason }) });
  }
  return rows;
}
function project(body: unknown): Record<string, unknown> | undefined {
  if (!object(body) || typeof body.invocationId !== 'string' || !uuid.test(body.invocationId) ||
    !count(body.recoveries) || !count(body.consecutiveFailures) || !count(body.totalFailedCycles)) return undefined;
  const common = { kind: body.kind, recoveries: body.recoveries, consecutiveFailures: body.consecutiveFailures, totalFailedCycles: body.totalFailedCycles };
  if (body.kind === 'apps-watch.observation.v1') {
    const observedState = state(body.observedState), rows = diagnostics(body.diagnostics);
    if (!count(body.cycle) || body.cycle < 1 || typeof body.healthy !== 'boolean' || observedState === undefined ||
      (body.diagnostics !== undefined && (rows === undefined || rows === null))) return undefined;
    // A healthy claim must agree with the observed state and diagnostic rows.
    if (body.healthy && (!Array.isArray(observedState) || !observedState.length || observedState.some(row => !row.observedRunning) ||
      (Array.isArray(rows) && rows.some(row => row.outcome !== 'running' && row.outcome !== 'launched')))) return undefined;
    return { ...common, cycle: body.cycle, healthy: body.healthy, observedState, ...(rows === undefined ? {} : { diagnostics: rows }) };
  }
  if (body.kind === 'apps-watch.summary.v1') {
    const lastObservedState = state(body.lastObservedState), rows = diagnostics(body.lastDiagnostics);
    if (!Array.isArray(body.apps) || !body.apps.length || body.apps.length > FLEET_APPS.length || !body.apps.every(app) ||
      new Set(body.apps).size !== body.apps.length || !['completed', 'failed', 'cancelled'].includes(String(body.outcome)) ||
      !count(body.cycles) || lastObservedState === undefined || (body.lastDiagnostics !== undefined && rows === undefined)) return undefined;
    return { ...common, apps: body.apps, outcome: body.outcome, cycles: body.cycles, lastObservedState,
      ...(rows === undefined ? {} : { lastDiagnostics: rows }) };
  }
  return undefined;
}

export function readAppsRecoveryHistory(root: string, after: number, limit: number, invocationId?: string) {
  const events: Record<string, unknown>[] = [];
  let cursor = after, scanned = 0;
  while (scanned < BUS_INBOX_MAX_MESSAGES) {
    const page = listBusInboxAfter(cursor, Math.min(BUS_INBOX_MAX_READ, BUS_INBOX_MAX_MESSAGES - scanned), { root });
    if (page.status !== 'ok') return { v: 1 as const, availability: page.status === 'invalid' ? 'invalid-cursor' : 'unavailable', events: [], nextCursor: after, hasMore: false };
    for (const row of page.messages) {
      scanned++;
      cursor = row.cursor;
      const body = row.envelope.body;
      if (row.envelope.from !== 'apps-watch' || row.envelope.to !== 'leaders' || !object(body) ||
        (invocationId !== undefined && body.invocationId !== invocationId)) continue;
      const data = project(body);
      if (data) events.push({ cursor: row.cursor, receivedAt: row.receivedAt, invocationId: body.invocationId, ...data });
      if (events.length === limit) return { v: 1 as const, availability: 'available', events, nextCursor: cursor, hasMore: true };
    }
    const previous = cursor;
    cursor = page.nextCursor;
    if (page.messages.length < Math.min(BUS_INBOX_MAX_READ, BUS_INBOX_MAX_MESSAGES - (scanned - page.messages.length)) || cursor === previous && !page.messages.length)
      return { v: 1 as const, availability: 'available', events, nextCursor: cursor, hasMore: false };
  }
  return { v: 1 as const, availability: 'available', events, nextCursor: cursor, hasMore: true };
}
