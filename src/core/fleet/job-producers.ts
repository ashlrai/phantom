/**
 * `phm jobs producers`: who queued the jobs that started, hour by hour. Pure; the caller passes the
 * jobs ledger lines and the router queue text. A job's producer is the `src=` tag on its queue line
 * (or a `src`/`producer` field on its launch row); with neither it is `unknown`, never guessed.
 */
export const PRODUCER_WINDOW_HOURS = 6;
export const UNKNOWN_PRODUCER = 'unknown';

export interface ProducerRow { producer: string; starts: number; jobs: number; hourly: number[] }
export interface JobProducersReport {
  schema: 'jobs.producers.v1'; version: 1; window_hours: number; known: boolean;
  /** Queue file state: unreadable means every producer comes from launch rows or is unknown. */
  queue_known: boolean;
  starts: number;
  /** Start counts per hour, index 0 is the most recent hour (now-1h..now), index 5 the oldest. */
  hourly: number[];
  producers: ProducerRow[];
  summary: string;
}

const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const tag = (value: unknown): string | null => typeof value === 'string' && TAG.test(value.trim()) ? value.trim() : null;

/** Job id to producer, from queue lines such as `- READY RQ-X (P1, pool=devin, src=leader): ...`. */
export function queueProducers(queueText: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of queueText.split(/\r?\n/)) {
    const id = /^\s*-\s+[A-Z]+\s+(RQ-[\w-]+)/.exec(line)?.[1];
    const src = id ? /(?:^|[\s(,])src=([^\s,;)]+)/.exec(line)?.[1] : undefined;
    if (id && src && tag(src) && !map.has(id)) map.set(id, src);
  }
  return map;
}

export function unknownJobProducers(hours = PRODUCER_WINDOW_HOURS): JobProducersReport {
  return { schema: 'jobs.producers.v1', version: 1, window_hours: hours, known: false, queue_known: false, starts: 0,
    hourly: Array.from({ length: Math.ceil(hours) }, () => 0), producers: [], summary: 'Job producers: unknown (job metrics file unreadable)' };
}

/** Count each `launch` row in the window once, by producer and hour. `queue` null means the queue file was unreadable. */
export function jobProducers(lines: Iterable<string>, queue: Map<string, string> | null, now: number, hours = PRODUCER_WINDOW_HOURS): JobProducersReport {
  if (!Number.isFinite(hours) || hours <= 0) throw new RangeError('Hours must be positive.');
  const buckets = Math.ceil(hours);
  const hourly = Array.from({ length: buckets }, () => 0);
  const groups = new Map<string, { starts: number; jobs: Set<string>; hourly: number[] }>();
  const start = now - hours * 3_600_000;
  for (const line of lines) {
    let row: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      row = value as Record<string, unknown>;
    } catch { continue; }
    if (row.event !== 'launch' || typeof row.job !== 'string' || !row.job) continue;
    const at = typeof row.ts === 'string' ? Date.parse(row.ts.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : NaN;
    if (!Number.isFinite(at) || at > now || at < start) continue;
    const hour = Math.min(buckets - 1, Math.floor((now - at) / 3_600_000));
    const producer = tag(row.src) ?? tag(row.producer) ?? queue?.get(row.job) ?? UNKNOWN_PRODUCER;
    const group = groups.get(producer) ?? { starts: 0, jobs: new Set<string>(), hourly: Array.from({ length: buckets }, () => 0) };
    group.starts++; group.jobs.add(row.job); group.hourly[hour]!++; hourly[hour]!++;
    groups.set(producer, group);
  }
  const producers = [...groups].map(([producer, g]) => ({ producer, starts: g.starts, jobs: g.jobs.size, hourly: g.hourly }))
    // Known producers first by volume; unknown is always last so it never hides a named producer.
    .sort((a, b) => Number(a.producer === UNKNOWN_PRODUCER) - Number(b.producer === UNKNOWN_PRODUCER) || b.starts - a.starts || a.producer.localeCompare(b.producer));
  const starts = hourly.reduce((a, b) => a + b, 0);
  const unknown = groups.get(UNKNOWN_PRODUCER)?.starts ?? 0;
  const summary = starts === 0 ? `No job starts in the last ${hours} hours`
    : `${starts} job starts in the last ${hours} hours from ${producers.filter(p => p.producer !== UNKNOWN_PRODUCER).length} producers; ${unknown} unattributed`;
  return { schema: 'jobs.producers.v1', version: 1, window_hours: hours, known: true, queue_known: queue !== null, starts, hourly, producers, summary };
}

export function jobProducerLines(report: JobProducersReport): string[] {
  if (!report.known) return [report.summary];
  return [report.summary,
    ...(report.queue_known ? [] : ['Queue file unreadable: producers come from launch rows only.']),
    ...(report.starts ? [`Starts per hour, newest first: ${report.hourly.join(' ')}`] : []),
    ...report.producers.map(row => `  ${row.producer}: ${row.starts} starts, ${row.jobs} jobs; per hour ${row.hourly.join(' ')}`)];
}
