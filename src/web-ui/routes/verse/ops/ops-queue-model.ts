/** Local wire contract: the queue endpoint lands independently of this view. */
export interface ParkedGroup { reason: string; lane: string | null; count: number; jobs: string[] }
export interface PrecheckSkip { at: string; job: string; code: string; reason: string }
export interface FleetQueueV1 {
  v: 1;
  generatedAt: string;
  sources: Record<'ready' | 'skips', 'healthy' | 'missing' | 'degraded'>;
  total: number;
  ready: number;
  parked: number;
  malformed: number;
  byLane: Array<{ lane: string; ready: number; parked: number; phantom?: number; other?: number; otherRepos?: string[] }>;
  nextUp?: Array<{ lane: string; jobs: string[] }>;
  groups: ParkedGroup[];
  skips: PrecheckSkip[];
  skipsLast24h: number | null;
}

type Check<T> = (value: unknown) => value is T;
const str: Check<string> = (v): v is string => typeof v === 'string';
const num: Check<number> = (v): v is number => typeof v === 'number' && Number.isFinite(v);
const optional = <T>(check: Check<T>): Check<T | undefined> => (v): v is T | undefined => v === undefined || check(v);
const count: Check<number> = (v): v is number => num(v) && Number.isInteger(v) && v >= 0;
const nullable = <T>(check: Check<T>): Check<T | null> => (v): v is T | null => v === null || check(v);
const array = <T>(check: Check<T>): Check<T[]> => (v): v is T[] => Array.isArray(v) && v.every(check);
function shape<S extends Record<string, Check<unknown>>>(schema: S): Check<{ [K in keyof S]: S[K] extends Check<infer T> ? T : never }> {
  return (v): v is { [K in keyof S]: S[K] extends Check<infer T> ? T : never } =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
    && Object.entries(schema).every(([key, check]) => check((v as Record<string, unknown>)[key]));
}
const source: Check<FleetQueueV1['sources']['ready']> = (v): v is FleetQueueV1['sources']['ready'] =>
  v === 'healthy' || v === 'missing' || v === 'degraded';
export const isFleetQueue: Check<FleetQueueV1> = shape({
  v: (v): v is 1 => v === 1, generatedAt: str, sources: shape({ ready: source, skips: source }),
  total: num, ready: num, parked: num, malformed: num,
  byLane: array(shape({ lane: str, ready: num, parked: num, phantom: optional(count), other: optional(count), otherRepos: optional(array(str)) })),
  nextUp: optional(array(shape({ lane: str, jobs: array(str) }))),
  groups: array(shape({ reason: str, lane: nullable(str), count: num, jobs: array(str) })),
  skips: array(shape({ at: str, job: str, code: str, reason: str })), skipsLast24h: nullable(num),
});

const reasons: Record<string, { title: string; detail: string }> = {
  MERGERATE: { title: 'Merge rate gate', detail: "This lane's recent merge rate fell under the gate. Jobs wait until it recovers or a leader unparks them." },
  INVALID: { title: 'Invalid job line', detail: 'The queue line failed validation (lane, tier or prompt path). Fix the line or drop the job.' },
  SPLIT: { title: 'Needs splitting', detail: 'The job touches too many files for one worker. Split it into one-concern jobs.' },
  BYHAND: { title: 'Parked by hand', detail: 'A human or leader parked it on purpose.' },
};
export function explainReason(reason: string): { title: string; detail: string } {
  return Object.hasOwn(reasons, reason) ? reasons[reason] : { title: reason, detail: `Parked by dispatchd; reason code ${reason}.` };
}
export function explainSkip(code: string, reason: string): string {
  return code === '13' || code === 'files_and_tests_exist'
    ? 'Already done: every named file and test exists on master. Precheck dropped it before launch.'
    : reason;
}
export function queueTiles(data: FleetQueueV1): Array<[string, number | string]> {
  return [['Ready', data.ready], ['Parked', data.parked], ['Dropped by precheck 24h', data.skipsLast24h ?? '—'], ['Malformed lines', data.malformed]];
}
export function laneRows(data: FleetQueueV1): FleetQueueV1['byLane'] {
  return [...data.byLane].sort((a, b) => b.parked - a.parked);
}
