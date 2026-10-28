/** Local, single-server station metrics. Rates are jobs/hour; W is observed
 * arrival-to-completion time in hours (not an M/M/1 forecast). Each row is one
 * station visit. Missing completion/start timestamps represent unfinished work.
 */
export interface QueueVisit {
  station: string;
  arrivedAt: string;
  startedAt?: string;
  completedAt?: string;
}
export interface QueueStationMetrics {
  station: string;
  arrivals: number;
  completions: number;
  lambda: number;
  mu: number | null;
  rho: number | null;
  W: number | null;
}
export interface QueueReport {
  schema: 'phantom-queue-report/v1';
  window: { start: string; end: string; hours: number } | null;
  units: { rates: 'jobs/hour'; W: 'hours' };
  stations: QueueStationMetrics[];
  bottleneck: string | null;
}

function timestamp(value: unknown, field: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field}: expected an ISO timestamp with timezone`);
  }
  return Date.parse(value);
}

/** Accept a JSON array, JSONL visits, or {start,end,events} for an explicit
 * observation window. Without bounds, use earliest arrival/latest timestamp.
 * Explicit windows must contain every visit; partial-window censoring is not
 * inferred. Unknown service rates and empty windows remain null, never Infinity.
 */
export function queueReportFromText(text: string): QueueReport {
  const trimmed = text.trim();
  let input: unknown = [];
  if (trimmed) {
    try { input = JSON.parse(trimmed); }
    catch {
      input = trimmed.split(/\r?\n/).filter(line => line.trim()).map((line, i) => {
        try { return JSON.parse(line) as unknown; }
        catch { throw new Error(`Invalid events JSON on line ${i + 1}`); }
      });
    }
  }
  let rows: unknown = input;
  let start: number | undefined;
  let end: number | undefined;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const envelope = input as Record<string, unknown>;
    if ('events' in envelope) {
      rows = envelope['events'];
      start = timestamp(envelope['start'], 'start');
      end = timestamp(envelope['end'], 'end');
    } else { rows = [input]; }
  }
  if (!Array.isArray(rows)) throw new Error('Expected an events array, JSONL visits, or {start,end,events}');
  const visits = rows.map((row: unknown, i) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`Event ${i + 1}: expected a visit object`);
    const r = row as Record<string, unknown>;
    if (typeof r['station'] !== 'string' || !r['station'].trim() || [...r['station']].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) throw new Error(`Event ${i + 1}: invalid station`);
    const arrived = timestamp(r['arrivedAt'], `Event ${i + 1} arrivedAt`);
    const started = r['startedAt'] === undefined ? undefined : timestamp(r['startedAt'], `Event ${i + 1} startedAt`);
    const completed = r['completedAt'] === undefined ? undefined : timestamp(r['completedAt'], `Event ${i + 1} completedAt`);
    if ((started !== undefined && started < arrived) || (completed !== undefined && (started === undefined || completed <= started))) {
      throw new Error(`Event ${i + 1}: require arrivedAt <= startedAt < completedAt`);
    }
    return { station: r['station'], arrived, started, completed };
  });
  if (start === undefined && visits.length) {
    start = visits.reduce((min, v) => Math.min(min, v.arrived), Infinity);
    end = visits.reduce((max, v) => Math.max(max, v.completed ?? v.started ?? v.arrived), -Infinity);
  }
  if (start !== undefined && (end === undefined || end <= start)) throw new Error('Observation window must have positive duration');
  if (start !== undefined && end !== undefined && visits.some(v => v.arrived < start || (v.completed ?? v.started ?? v.arrived) > end)) {
    throw new Error('Events must lie inside the observation window');
  }
  const hours = start !== undefined && end !== undefined ? (end - start) / 3_600_000 : 0;
  const groups = new Map<string, typeof visits>();
  for (const visit of visits) {
    const group = groups.get(visit.station) ?? [];
    group.push(visit);
    groups.set(visit.station, group);
  }
  const stations = [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([station, group]): QueueStationMetrics => {
    const complete = group.filter(v => v.completed !== undefined);
    const serviceHours = complete.reduce((sum, v) => sum + (v.completed! - v.started!) / 3_600_000, 0);
    const lambda = group.length / hours;
    const mu = complete.length ? complete.length / serviceHours : null;
    return { station, arrivals: group.length, completions: complete.length, lambda, mu,
      rho: mu === null ? null : lambda / mu,
      W: complete.length ? complete.reduce((sum, v) => sum + (v.completed! - v.arrived) / 3_600_000, 0) / complete.length : null };
  });
  const bottleneck = stations.reduce<QueueStationMetrics | null>((best, station) =>
    station.rho !== null && (best === null || station.rho > best.rho!) ? station : best, null);
  return { schema: 'phantom-queue-report/v1',
    window: start !== undefined && end !== undefined ? { start: new Date(start).toISOString(), end: new Date(end).toISOString(), hours } : null,
    units: { rates: 'jobs/hour', W: 'hours' }, stations, bottleneck: bottleneck?.station ?? null };
}
