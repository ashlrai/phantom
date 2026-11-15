/** Fleet telemetry contains measurements only. Task, repo and person text never leaves the host. */
import type { CodingFleetSnapshot } from './coding-snapshot.js';
import { createPosthogSink, posthogCaptureUrl, type SchedulerEvent } from '../providers/coding-cli/scheduler/telemetry.js';
import type { SchedulerConfig } from '../providers/coding-cli/scheduler/defaults.js';

export function fleetTelemetryEvents(snapshot: CodingFleetSnapshot): SchedulerEvent[] {
  const events: SchedulerEvent[] = [];
  const emit = (event: SchedulerEvent['event'], properties: SchedulerEvent['properties']): void => {
    events.push({ event, timestamp: snapshot.generated_at, distinctId: 'phantom-fleet', properties });
  };
  for (const pool of snapshot.pools) {
    emit('phantom_pool_burndown', {
      pool_id: pool.id, used_fraction: pool.used_pct === null ? null : pool.used_pct / 100,
      remaining_fraction: pool.remaining_pct === null ? null : pool.remaining_pct / 100,
      reset_at: pool.reset_at, projected_pct: pool.projected_pct, ideal_pct: pool.ideal_pct,
      age_seconds: pool.age_seconds, source: pool.source, estimate: pool.source === 'estimate',
      shared_consumer: pool.shared_with !== null,
    });
    if (pool.id === 'grok-ultra-weekly') {
      emit('phantom_grok_ultra_runway', {
        remaining_fraction: pool.remaining_pct === null ? null : pool.remaining_pct / 100,
        runway_hours: pool.runway_hours,
        hours_to_reset: pool.reset_at === null ? null : Math.max(0, (Date.parse(pool.reset_at) - Date.parse(snapshot.generated_at)) / 3_600_000),
        estimate: true, quota_readable_from_api: false,
      });
    }
    // Pool-unit costs cannot be converted to dollars without a priced ledger.
    emit('phantom_pool_value_per_dollar', { pool_id: pool.id, monetary_cost: null, value_per_dollar: null });
  }
  return events;
}

export function emitFleetTelemetry(snapshot: CodingFleetSnapshot, config: SchedulerConfig['posthog'], sink?: (event: SchedulerEvent) => void): number {
  if (!config.enabled) return 0;
  let target = sink;
  if (!target) {
    if (!config.host || !config.apiKey) return 0;
    if (posthogCaptureUrl(config.host) === null) return 0;
    target = createPosthogSink({ host: config.host, apiKey: config.apiKey });
  }
  const events = fleetTelemetryEvents(snapshot);
  for (const event of events) target(event);
  return events.length;
}
