/**
 * Opt-in, in-memory recorder for scheduler telemetry events.
 *
 * Recovered from PR #5952 (pinned head 3d6c8fb7c7f7d52655fb3e0f13ef239686f7b886):
 *   scheduler/telemetry.ts SCHEDULER_EVENTS            -> RECORDED_SCHEDULER_EVENT_NAMES
 *   scheduler/telemetry.ts SchedulerEventName          -> RecordedSchedulerEventName
 *   scheduler/telemetry.ts EventProperty               -> RecordedEventProperty
 *   scheduler/telemetry.ts SchedulerEvent              -> RecordedSchedulerEvent
 *   scheduler/telemetry.ts SchedulerTelemetry          -> RecordedSchedulerTelemetry
 *   scheduler/telemetry.ts createTelemetry()           -> createRecordedTelemetry()
 *
 * Scope: a caller supplies structured events and the recorder keeps them locally, in
 * order, so a replay can read what was recorded. The recorder never builds events
 * itself. No PostHog sink, HTTP endpoint, network, environment read, file write,
 * projection of schedule results, or routing decision lives here.
 *
 * Semantics (matching the source):
 *   - Recording happens only when `enabled === true` (strict equality; any other value
 *     is disabled). The default is disabled.
 *   - A disabled recorder retains nothing and never calls the sink.
 *   - An enabled recorder appends each event to `events` (insertion order), then calls
 *     the optional synchronous `sink` once with that same event object. A sink that
 *     throws propagates the error to the emitter after the event is already retained.
 *   - The event object is stored by reference. Its `timestamp` and `properties` are
 *     not copied, normalised or validated.
 *
 * Divergences from the source: none. Event names are still a compile-time union; the
 * runtime does not check them (as in the source). The source's emitSchedule() and
 * eventsFromSchedule() are not recovered because they project a ScheduleResult.
 */

export const RECORDED_SCHEDULER_EVENT_NAMES = [
  'phantom_pool_burndown',
  'phantom_grok_ultra_runway',
  'phantom_pool_value_per_dollar',
] as const;

export type RecordedSchedulerEventName = (typeof RECORDED_SCHEDULER_EVENT_NAMES)[number];

export type RecordedEventProperty = string | number | boolean | null;

export interface RecordedSchedulerEvent {
  event: RecordedSchedulerEventName;
  /** ISO-8601 timestamp, supplied by the caller and stored unchanged. */
  timestamp: string;
  distinctId: string;
  properties: Readonly<Record<string, RecordedEventProperty>>;
}

export interface RecordedSchedulerTelemetry {
  /** True only when the recorder was created with `enabled: true`. */
  enabled: boolean;
  /** Retained events, in emission order. Always empty when disabled. */
  events: RecordedSchedulerEvent[];
  /** Retains the event and calls the sink when enabled; does nothing otherwise. */
  emit(event: RecordedSchedulerEvent): void;
}

export interface RecordedTelemetryOptions {
  /** Opt-in. Only the boolean `true` enables recording. Defaults to disabled. */
  enabled?: boolean;
  /** Optional synchronous observer, called once per retained event. */
  sink?: (event: RecordedSchedulerEvent) => void;
}

/** Disabled recorders record nothing and call no sink. */
export function createRecordedTelemetry(options?: RecordedTelemetryOptions): RecordedSchedulerTelemetry {
  const enabled = options?.enabled === true;
  const events: RecordedSchedulerEvent[] = [];
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
