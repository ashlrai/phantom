const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether a healthy merge source confirms a backlog of recent publishes. */
export function mergeStallFacts(data: unknown, nowMs: number): data is { publishesLastHour: unknown[] } {
  return Number.isFinite(new Date(nowMs).getTime()) && record(data) && record(data.sources) && data.sources.merges === 'healthy'
    && record(data.mergesLastHour) && data.mergesLastHour.count === 0
    && Array.isArray(data.publishesLastHour) && data.publishesLastHour.length >= 3;
}
