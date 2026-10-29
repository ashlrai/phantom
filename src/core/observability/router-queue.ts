/** Metadata-only observations. Stations describe evidence, never grant authority. */
import { createHash } from 'node:crypto';

export const QUEUE_STATIONS = [
  'planned', 'READY', 'claimed', 'publish', 'pr-ci', 'merge-queue', 'merged', 'released', 'fix-main',
] as const;
export type QueueStation = typeof QUEUE_STATIONS[number];
export interface QueueJob { jobId: string; repo: string; attempt: string }
export interface QueueRow extends QueueJob { status: 'planned' | 'READY' | 'claimed' | 'published' | 'done' }
export interface ClaimReceipt extends QueueJob { claimedAt: string }
export interface PublicationReceipt extends QueueJob { publishedAt: string; pr: number; headSha: string }
export interface StationEvent extends QueueJob {
  schemaVersion: 1;
  eventId: string;
  station: QueueStation;
  observedAt: string;
  source: 'router-queue' | 'claim-ledger' | 'publish.sh' | 'github';
  evidence: Record<string, string | number>;
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid queue observation object');
  return value as Record<string, unknown>;
}
function token(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error('Invalid queue observation identifier');
  }
  return value;
}
export function sha(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) throw new Error('Invalid commit identity');
  return value;
}
export function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error('Invalid observation number');
  return value as number;
}
export function timestamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error('Invalid observation timestamp');
  }
  return value;
}
export function queueJob(value: unknown): QueueJob {
  const row = object(value);
  const repo = row['repo'];
  if (typeof repo !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repo)
    || repo.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid repository identity');
  return { jobId: token(row['jobId']), repo: repo.toLowerCase(), attempt: token(row['attempt']) };
}
export function publicationReceipt(value: unknown): PublicationReceipt {
  const row = object(value);
  return { ...queueJob(row), publishedAt: timestamp(row['publishedAt']), pr: positiveInteger(row['pr']), headSha: sha(row['headSha']) };
}
function rows(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 10_000) throw new Error('Invalid or oversized observation list');
  return value;
}
export function jobKey(job: QueueJob): string { return JSON.stringify([job.repo, job.jobId, job.attempt]); }

/** Rebuild an allowlisted payload; titles, bodies, paths, logs and credentials never persist. */
export function stationEvent(
  job: QueueJob, station: QueueStation, observedAt: string, source: StationEvent['source'],
  evidence: Record<string, string | number>,
): StationEvent {
  const identity = queueJob(job);
  const sorted = Object.fromEntries(Object.entries(evidence).sort(([a], [b]) => a.localeCompare(b)));
  const eventId = createHash('sha256').update(JSON.stringify([identity, station, source, sorted])).digest('hex');
  return { schemaVersion: 1, eventId, ...identity, station, observedAt: timestamp(observedAt), source, evidence: sorted };
}

const EVIDENCE_KEYS: Record<QueueStation, string[]> = {
  planned: [], READY: [], claimed: ['claimedAt'], publish: ['pr', 'headSha', 'publishedAt'],
  'pr-ci': ['pr', 'headSha', 'ci'], 'merge-queue': ['pr', 'headSha', 'entryId'],
  merged: ['pr', 'headSha', 'mergeSha'], released: ['pr', 'mergeSha', 'releaseId', 'tag'],
  'fix-main': ['pr', 'mergeSha', 'runId'],
};
const SOURCES: Record<QueueStation, StationEvent['source']> = {
  planned: 'router-queue', READY: 'router-queue', claimed: 'claim-ledger', publish: 'publish.sh',
  'pr-ci': 'github', 'merge-queue': 'github', merged: 'github', released: 'github', 'fix-main': 'github',
};
export function parseStationEvent(value: unknown): StationEvent {
  const row = object(value);
  const station = row['station'] as QueueStation;
  if (row['schemaVersion'] !== 1 || !QUEUE_STATIONS.includes(station) || row['source'] !== SOURCES[station]) {
    throw new Error('Invalid station event');
  }
  const evidence = object(row['evidence']);
  const keys = EVIDENCE_KEYS[station];
  if (Object.keys(evidence).sort().join(',') !== [...keys].sort().join(',')) throw new Error('Invalid station evidence');
  for (const [key, value] of Object.entries(evidence)) {
    if (['pr', 'releaseId', 'runId'].includes(key)) positiveInteger(value);
    else if (['headSha', 'mergeSha'].includes(key)) sha(value);
    else if (['claimedAt', 'publishedAt'].includes(key)) timestamp(value);
    else if (key === 'ci') {
      if (typeof value !== 'string' || !['pending', 'success', 'failure'].includes(value)) throw new Error('Invalid CI evidence');
    } else if (typeof value !== 'string' || value.length === 0 || value.length > 200 || !/^[A-Za-z0-9._/+=-]+$/.test(value)) {
      throw new Error('Invalid station evidence identity');
    }
  }
  const rebuilt = stationEvent(queueJob(row), station, timestamp(row['observedAt']), SOURCES[station], evidence as StationEvent['evidence']);
  if (row['eventId'] !== rebuilt.eventId || Object.keys(row).sort().join(',') !== Object.keys(rebuilt).sort().join(',')) {
    throw new Error('Invalid station event identity');
  }
  return rebuilt;
}

/** A snapshot diff is represented by deterministic event IDs; replay is harmless.
 * Never infer an unobserved READY/claim/publish from a later station. */
export function boxStationEvents(input: unknown, observedAt: string): StationEvent[] {
  const snapshot = object(input);
  if (snapshot['schemaVersion'] !== 1) throw new Error('Unsupported queue snapshot version');
  const events: StationEvent[] = [];
  const seen = new Set<string>();
  for (const value of rows(snapshot['queue'])) {
    const row = object(value); const job = queueJob(row); const key = jobKey(job);
    if (seen.has(key) || typeof row['status'] !== 'string' || !['planned', 'READY', 'claimed', 'published', 'done'].includes(row['status'])) {
      throw new Error('Duplicate job or invalid queue status');
    }
    seen.add(key);
    events.push(stationEvent(job, 'planned', observedAt, 'router-queue', {}));
    if (row['status'] === 'READY') events.push(stationEvent(job, 'READY', observedAt, 'router-queue', {}));
  }
  for (const value of rows(snapshot['claims'])) {
    const row = object(value);
    events.push(stationEvent(queueJob(row), 'claimed', observedAt, 'claim-ledger', { claimedAt: timestamp(row['claimedAt']) }));
  }
  for (const value of rows(snapshot['publications'])) {
    const row = publicationReceipt(value);
    events.push(stationEvent(row, 'publish', observedAt, 'publish.sh', { pr: row.pr, headSha: row.headSha, publishedAt: row.publishedAt }));
  }
  return events.map(parseStationEvent);
}

export function stationCoverage(events: StationEvent[], job: QueueJob): { seen: QueueStation[]; missing: QueueStation[]; complete: boolean } {
  const found = new Set(events.filter(event => jobKey(event) === jobKey(job)).map(event => event.station));
  const seen = QUEUE_STATIONS.filter(station => found.has(station));
  const missing = QUEUE_STATIONS.filter(station => !found.has(station));
  return { seen, missing, complete: missing.length === 0 };
}

/** A retry or a rewritten head needs a new attempt. Combining different delivery
 * identities must never make one job appear to have traversed every station. */
export function validateStationLineage(events: StationEvent[]): void {
  const pins = new Map<string, Record<string, string | number>>();
  for (const event of events) {
    const key = jobKey(event); const pin = pins.get(key) ?? {};
    for (const field of ['pr', 'headSha', 'mergeSha']) {
      const value = event.evidence[field];
      if (value === undefined) continue;
      if (pin[field] !== undefined && pin[field] !== value) throw new Error('Conflicting job attempt delivery identity');
      pin[field] = value;
    }
    pins.set(key, pin);
  }
}
