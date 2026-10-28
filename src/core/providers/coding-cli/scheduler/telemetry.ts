/**
 * Opt-in scheduler telemetry. The default sink is a no-op. A PostHog capture
 * sink runs only when a caller supplies a host, an API key, and enabled: true.
 * The key is not written into the event properties.
 */

import type { ScheduleResult } from './solve.js';
import type { SchedulerPoolId } from './types.js';

export const SCHEDULER_EVENTS = [
  'phantom_pool_burndown',
  'phantom_grok_ultra_runway',
  'phantom_pool_value_per_dollar',
] as const;

export type SchedulerEventName = (typeof SCHEDULER_EVENTS)[number];

export type EventProperty = string | number | boolean | null;

export interface SchedulerEvent {
  event: SchedulerEventName;
  timestamp: string;
  distinctId: string;
  properties: Readonly<Record<string, EventProperty>>;
}

export interface SchedulerTelemetry {
  enabled: boolean;
  events: SchedulerEvent[];
  emit(event: SchedulerEvent): void;
}

/** Disabled telemetry records nothing and calls no sink. */
export function createTelemetry(options?: {
  enabled?: boolean;
  distinctId?: string;
  sink?: (event: SchedulerEvent) => void;
}): SchedulerTelemetry {
  const enabled = options?.enabled === true;
  const events: SchedulerEvent[] = [];
  const sink = options?.sink;
  return {
    enabled,
    events,
    emit(event) {
      if (!enabled) return;
      events.push(event);
      sink?.(event);
    },
  };
}

export function eventsFromSchedule(result: ScheduleResult, nowMs: number, distinctId = 'phantom-router'): SchedulerEvent[] {
  const timestamp = new Date(nowMs).toISOString();
  const burn: SchedulerEvent = {
    event: 'phantom_pool_burndown',
    timestamp,
    distinctId,
    properties: {
      pool_id: 'grok-ultra-weekly',
      remaining_fraction: result.ultra.remaining,
      used_fraction: result.ultra.usedFraction,
      unsplit_used_fraction: result.ultra.unsplitUsedFraction,
      orchestrator_used: result.ultra.orchestrator,
      cloud_agent_used: result.ultra.cloudAgent,
      reset_at: new Date(result.ultra.resetAtMs).toISOString(),
      estimate: true,
      source: result.ultra.source,
      extra_usage_credits: result.ultra.extraUsageCredits,
      is_reading: false,
      projection: 'derived',
      projected_landing: result.poolSeries.find((series) => series.poolId === 'grok-ultra-weekly')?.projectedLanding ?? null,
      uncertainty: result.poolSeries.find((series) => series.poolId === 'grok-ultra-weekly')?.uncertainty ?? null,
      stale: result.poolSeries.find((series) => series.poolId === 'grok-ultra-weekly')?.stale ?? false,
    },
  };
  const runway: SchedulerEvent = {
    event: 'phantom_grok_ultra_runway',
    timestamp,
    distinctId,
    properties: {
      remaining_fraction: result.ultra.remaining,
      hours_to_reset: Math.max(0, (result.ultra.resetAtMs - nowMs) / 3_600_000),
      runway_hours: result.runwayHours,
      orchestrator_used: result.ultra.orchestrator,
      cloud_agent_used: result.ultra.cloudAgent,
      estimate: true,
      quota_readable_from_api: false,
    },
  };
  const byPool = new Map<SchedulerPoolId, { value: number; cost: number; jobs: number }>();
  for (const assignment of result.assignments) {
    const current = byPool.get(assignment.poolId) ?? { value: 0, cost: 0, jobs: 0 };
    current.value += assignment.netValue;
    current.cost += assignment.monetaryCost;
    current.jobs += 1;
    byPool.set(assignment.poolId, current);
  }
  const valueEvents: SchedulerEvent[] = [...byPool.entries()].map(([poolId, row]) => ({
    event: 'phantom_pool_value_per_dollar' as const,
    timestamp,
    distinctId,
    properties: {
      pool_id: poolId,
      expected_value: row.value,
      jobs: row.jobs,
      monetary_cost: row.cost,
      value_per_dollar: row.cost > 0 ? row.value / row.cost : null,
    },
  }));
  return [burn, runway, ...valueEvents];
}

export function emitSchedule(telemetry: SchedulerTelemetry, result: ScheduleResult, nowMs: number): SchedulerEvent[] {
  const events = eventsFromSchedule(result, nowMs);
  if (!telemetry.enabled) return [];
  for (const event of events) telemetry.emit(event);
  return events;
}

/**
 * PostHog capture. Host must be an https PostHog origin. The API key is sent
 * as the capture body field and is not copied into properties.
 */
export function createPosthogSink(options: {
  host: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): (event: SchedulerEvent) => void {
  const host = options.host.replace(/\/$/, '');
  const fetchImpl = options.fetchImpl ?? fetch;
  return (event) => {
    void fetchImpl(`${host}/capture/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: options.apiKey,
        event: event.event,
        distinct_id: event.distinctId,
        timestamp: event.timestamp,
        properties: event.properties,
      }),
    }).catch(() => undefined);
  };
}
