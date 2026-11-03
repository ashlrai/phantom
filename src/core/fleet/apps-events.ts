/** Normalized reader over apps-watch bus events with invocation filtering. */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { listBusInboxAfter, type BusInboxPage } from './bus-inbox.js';
import type { BusEnvelope } from './bus-envelope.js';

const VALID_KINDS = new Set(['apps-watch.observation.v1', 'apps-watch.summary.v1']);
const KNOWN_OUTCOMES = new Set([
  'running', 'launched', 'unavailable', 'launch-failed', 'timeout',
  'cancelled', 'unattempted', 'unknown', 'completed', 'failed',
]);

export interface AppsWatchEventNormalized {
  kind: 'apps-watch.observation.v1' | 'apps-watch.summary.v1';
  invocationId: string;
}
export interface AppsWatchEventObservedNormalized extends AppsWatchEventNormalized {
  kind: 'apps-watch.observation.v1';
  cycle: number;
  healthy: boolean;
  recoveries: number;
  consecutiveFailures: number;
  totalFailedCycles: number;
  observedState: { app: string; observedRunning: boolean | null }[] | null;
  diagnostics: { app: string; outcome: string; attempted?: boolean; launched?: boolean; reason?: string }[] | null;
}
export interface AppsWatchEventSummaryNormalized extends AppsWatchEventNormalized {
  kind: 'apps-watch.summary.v1';
  apps: string[];
  outcome: string;
  cycles: number;
  recoveries: number;
  consecutiveFailures: number;
  totalFailedCycles: number;
  lastObservedState: { app: string; observedRunning: boolean | null }[] | null;
  lastDiagnostics: { app: string; outcome: string; attempted?: boolean; launched?: boolean; reason?: string }[] | null;
}
export type NormalizedEvent = AppsWatchEventObservedNormalized | AppsWatchEventSummaryNormalized;
export interface AppsEventsResult {
  v: number;
  status: 'ok' | 'empty' | 'invalid' | 'unavailable' | 'retryable' | 'full' | 'conflict';
  events: NormalizedEvent[];
  nextCursor: number;
  scanned: number;
  invalidEvents: number;
  invocationFilter?: string;
}

/** Validate and normalize an observation event from the bus body. */
function normalizeObservation(body: unknown): NormalizedEvent | null {
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  if (obj.kind !== 'apps-watch.observation.v1') return null;
  if (typeof obj.invocationId !== 'string' || obj.invocationId.length === 0) return null;
  const safeInt = (v: unknown): number | null =>
    Number.isSafeInteger(v) && v >= 0 ? v : null;
  const cycle = safeInt(obj.cycle);
  const recoveries = safeInt(obj.recoveries);
  const consecutiveFailures = safeInt(obj.consecutiveFailures);
  const totalFailedCycles = safeInt(obj.totalFailedCycles);
  if (cycle === null || !Number.isSafeInteger(obj.healthy) ||
      recoveries === null || consecutiveFailures === null || totalFailedCycles === null) return null;
  const observedState = obj.observedState === null ? null :
    !Array.isArray(obj.observedState) ? null :
    obj.observedState.every(row =>
      row && typeof row === 'object' &&
      typeof (row as Record<string, unknown>).app === 'string' &&
      ((row as Record<string, unknown>).observedRunning === null ||
       typeof (row as Record<string, unknown>).observedRunning === 'boolean'))
      ? (obj.observedState as { app: string; observedRunning: boolean | null }[])
      : null;
  if (observedState === null && obj.observedState !== undefined && obj.observedState !== null) return null;
  const diagnostics = obj.diagnostics === undefined || obj.diagnostics === null ? null :
    !Array.isArray(obj.diagnostics) ? null :
    obj.diagnostics.every(diag =>
      diag && typeof diag === 'object' &&
      typeof (diag as Record<string, unknown>).app === 'string' &&
      KNOWN_OUTCOMES.has((diag as Record<string, unknown>).outcome))
      ? (obj.diagnostics as { app: string; outcome: string; attempted?: boolean; launched?: boolean; reason?: string }[]).map(d => ({
          app: (d as Record<string, unknown>).app,
          outcome: (d as Record<string, unknown>).outcome,
          attempted: (d as Record<string, unknown>).attempted,
          launched: (d as Record<string, unknown>).launched,
          reason: (d as Record<string, unknown>).reason,
        }))
      : null;
  return {
    kind: 'apps-watch.observation.v1',
    invocationId: obj.invocationId as string,
    cycle, healthy: obj.healthy as boolean, recoveries, consecutiveFailures,
    totalFailedCycles, observedState,
    diagnostics: diagnostics ? diagnostics.filter(d => d.app.length > 0) : null,
  };
}

/** Validate and normalize a summary event from the bus body. */
function normalizeSummary(body: unknown): NormalizedEvent | null {
  if (!body || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  if (obj.kind !== 'apps-watch.summary.v1') return null;
  if (typeof obj.invocationId !== 'string' || obj.invocationId.length === 0) return null;
  const apps = !Array.isArray(obj.apps) ? null :
    obj.apps.every(a => typeof a === 'string' && a.length > 0) ? (obj.apps as string[]) : null;
  const safeInt = (v: unknown): number | null =>
    Number.isSafeInteger(v) && v >= 0 ? v : null;
  const cycles = safeInt(obj.cycles);
  const recoveries = safeInt(obj.recoveries);
  const consecutiveFailures = safeInt(obj.consecutiveFailures);
  const totalFailedCycles = safeInt(obj.totalFailedCycles);
  const outcome = typeof obj.outcome === 'string' && KNOWN_OUTCOMES.has(obj.outcome) ? obj.outcome : null;
  if (apps === null || cycles === null || outcome === null ||
      recoveries === null || consecutiveFailures === null || totalFailedCycles === null) return null;
  const lastObservedState = obj.lastObservedState === null ? null :
    !Array.isArray(obj.lastObservedState) ? null :
    obj.lastObservedState.every(row =>
      row && typeof row === 'object' &&
      typeof (row as Record<string, unknown>).app === 'string' &&
      ((row as Record<string, unknown>).observedRunning === null ||
       typeof (row as Record<string, unknown>).observedRunning === 'boolean'))
      ? (obj.lastObservedState as { app: string; observedRunning: boolean | null }[])
      : null;
  if (lastObservedState === null && obj.lastObservedState !== undefined && obj.lastObservedState !== null) return null;
  const lastDiagnostics = normalizeDiagnosticsRaw(obj.lastDiagnostics);
  return {
    kind: 'apps-watch.summary.v1',
    invocationId: obj.invocationId as string,
    apps, outcome, cycles, recoveries, consecutiveFailures, totalFailedCycles,
    lastObservedState, lastDiagnostics,
  };
}

function normalizeDiagnosticsRaw(d: unknown): { app: string; outcome: string; attempted?: boolean; launched?: boolean; reason?: string }[] | null {
  if (!Array.isArray(d)) return null;
  return d.filter(diag =>
    diag && typeof diag === 'object' &&
    typeof (diag as Record<string, unknown>).app === 'string' &&
    typeof (diag as Record<string, unknown>).outcome === 'string' &&
    KNOWN_OUTCOMES.has((diag as Record<string, unknown>).outcome))
    .map(diag => {
      const r = diag as Record<string, unknown>;
      return { app: r.app, outcome: r.outcome, attempted: r.attempted, launched: r.launched, reason: r.reason };
    });
}

/** Read and normalize app-watch events from the bus inbox. */
export function readAppsEvents(
  after: number, limit: number, options: { root?: string; invocationId?: string; now?: () => number } = {},
): AppsEventsResult {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    return { v: 1, status: 'invalid', events: [], nextCursor: 0, scanned: 0, invalidEvents: 0 };
  }
  const resolvedRoot = options.root ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const normalizedFilter = options.invocationId ? String(options.invocationId) : undefined;
  const page = listBusInboxAfter(after, limit, { root: resolvedRoot, now: options.now });
  if (page.status !== 'ok') return { v: 1, status: page.status, events: [], nextCursor: 0, scanned: 0, invalidEvents: 0 };
  const events: NormalizedEvent[] = [];
  let invalidEvents = 0;
  for (const row of page.messages) {
    const envelope = row.envelope;
    if (envelope.from !== 'apps-watch') continue;
    const body = envelope.body;
    if (!body || typeof body !== 'object') { invalidEvents++; continue; }
    const obj = body as Record<string, unknown>;
    if (typeof obj.kind !== 'string' || !VALID_KINDS.has(obj.kind)) continue;
    if (typeof obj.invocationId !== 'string' || obj.invocationId.length === 0) { invalidEvents++; continue; }
    if (normalizedFilter && obj.invocationId !== normalizedFilter) continue;
    const normalized = obj.kind === 'apps-watch.observation.v1'
      ? normalizeObservation(obj) : normalizeSummary(obj);
    if (normalized) {
      events.push(normalized);
    } else {
      invalidEvents++;
    }
  }
  return {
    v: 1,
    status: events.length > 0 ? 'ok' : 'empty',
    events,
    nextCursor: page.nextCursor,
    scanned: page.messages.length,
    invalidEvents,
    ...(normalizedFilter ? { invocationFilter: normalizedFilter } : {}),
  };
}
