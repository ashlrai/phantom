#!/usr/bin/env -S npx tsx
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { readLeaderJournal, type DropIngestRow } from '../../src/core/fleet/leader-journal.js';
import { readFleetRunsDirState } from '../../src/core/fleet/runs-dir-state.js';

const MIN_WINDOW = 30 * 60_000, MAX_WINDOW = 60 * 60_000, MAX_CLAIMS = 10_000;
const usage = 'npx tsx examples/agents/leader-progress-check.ts [--before FILE | --wait-seconds 1-3600] [--save FILE] [--runs-dir ABSOLUTE_PATH]';
type Snapshot = {
  v: 1; observedAt: string; claimedHealthy: boolean; metricsHealthy: boolean; ingestHealthy: boolean;
  claimsComplete: boolean; publishesComplete: boolean; claims: string[]; publishes: string[]; ingest: string[];
};
type Dependencies = {
  journal: typeof readLeaderJournal; runs: typeof readFleetRunsDirState; now: () => number;
  wait: (ms: number, signal: AbortSignal) => Promise<void>; output: (text: string) => void;
  readBaseline: (path: string) => Promise<string>; save: (path: string, data: string) => Promise<void>;
};
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const claimKey = (row: { job: string; lane: string; tier: string; at: string }) => hash([row.job, row.lane, row.tier, row.at]);
const publishKey = (row: { job: string; lane: string | null; at: string }) => hash([row.job, row.lane, row.at]);
const ingestKey = (row: DropIngestRow) => hash([row.verb, row.file, row.reason]);
const isHashArray = (v: unknown, max: number): v is string[] => Array.isArray(v) && v.length <= max && v.every(x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x));
function baseline(text: string): Snapshot {
  if (Buffer.byteLength(text) > 800_000) throw new Error('invalid baseline');
  const v: unknown = JSON.parse(text);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('invalid baseline');
  const s = v as Record<string, unknown>;
  if (s.v !== 1 || typeof s.observedAt !== 'string' || !Number.isFinite(Date.parse(s.observedAt)) ||
    new Date(s.observedAt).toISOString() !== s.observedAt ||
    !['claimedHealthy', 'metricsHealthy', 'ingestHealthy', 'claimsComplete', 'publishesComplete'].every(k => typeof s[k] === 'boolean') ||
    !isHashArray(s.claims, MAX_CLAIMS) || !isHashArray(s.publishes, 50) || !isHashArray(s.ingest, 30)) throw new Error('invalid baseline');
  return s as Snapshot;
}
async function readFileBounded(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 800_000) throw new Error('invalid baseline');
    const bytes = Buffer.alloc(stat.size); let used = 0;
    while (used < bytes.length) { const r = await file.read(bytes, used, bytes.length - used, used); if (!r.bytesRead) break; used += r.bytesRead; }
    return bytes.subarray(0, used).toString('utf8');
  } finally { await file.close(); }
}
async function atomicSave(path: string, data: string): Promise<void> {
  const temp = join(dirname(resolve(path)), `.leader-progress-${randomUUID()}.tmp`);
  let created = false;
  try {
    const file = await open(temp, 'wx', 0o600); created = true;
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
    await rename(temp, path); created = false;
  } finally { if (created) await unlink(temp).catch(() => {}); }
}
async function observe(deps: Dependencies, runsDir?: string) {
  const now = deps.now();
  if (!Number.isFinite(now) || Math.abs(now) > 8.64e15) throw new Error('invalid clock');
  const [journal, runs] = await Promise.all([deps.journal({ runsDir, now: () => now }), deps.runs({ runsDir, now: () => now })]);
  const snapshot: Snapshot = {
    v: 1, observedAt: new Date(now).toISOString(), claimedHealthy: runs.sources.claimed === 'healthy',
    metricsHealthy: runs.sources.metrics === 'healthy', ingestHealthy: journal.sources.ingestLog === 'healthy' &&
      journal.ingest.every(row => row.verb !== '[redacted line]'),
    claimsComplete: runs.claimed.length <= MAX_CLAIMS, publishesComplete: runs.publishesLastHour.length < 50,
    claims: runs.claimed.slice(0, MAX_CLAIMS).map(claimKey), publishes: runs.publishesLastHour.map(publishKey),
    ingest: journal.ingest.map(ingestKey),
  };
  return { snapshot, journal, runs };
}
function rejectionDelta(before: Snapshot, current: ReturnType<typeof ingestKey>[], rows: DropIngestRow[]) {
  if (!before.ingestHealthy) return { continuity: 'unknown', rejections: [] };
  let added = -1;
  if (!before.ingest.length && current.length < 30) added = current.length;
  else for (let i = 0; i < current.length; i++) {
    const overlap = Math.min(30 - i, before.ingest.length);
    if (overlap && current.length - i === overlap && current.slice(i).every((x, j) => x === before.ingest[j])) { added = i; break; }
  }
  return { continuity: added < 0 ? 'unknown' : 'matched', rejections: added < 0 ? [] : rows.slice(0, added).filter(row => /^reject$/i.test(row.verb)) };
}

/** Compare public reader projections; injected I/O makes this runner import-safe and testable. */
export async function runLeaderProgressCheck(args: readonly string[], overrides: Partial<Dependencies> = {}): Promise<number> {
  const deps: Dependencies = { journal: readLeaderJournal, runs: readFleetRunsDirState, now: Date.now,
    wait: async (ms, signal) => { await delay(ms, undefined, { signal }); },
    output: text => { process.stdout.write(text); }, readBaseline: readFileBounded, save: atomicSave, ...overrides };
  const emit = (value: unknown) => deps.output(`${JSON.stringify(value)}\n`);
  const opts = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--help' && args.length === 1) { emit({ usage }); return 0; }
    const value = args[++i];
    if (!['--before', '--save', '--runs-dir', '--wait-seconds'].includes(key) || opts.has(key) || !value || value.startsWith('-') || value.length > 4096) {
      emit({ error: 'invalid arguments', usage }); return 2;
    }
    opts.set(key, value);
  }
  const waitText = opts.get('--wait-seconds');
  if ((waitText && (!/^[1-9]\d*$/.test(waitText) || Number(waitText) > 3600 || opts.has('--before'))) ||
    (opts.has('--runs-dir') && !isAbsolute(opts.get('--runs-dir')!))) { emit({ error: 'invalid arguments', usage }); return 2; }
  let before: Snapshot | undefined;
  if (opts.has('--before')) {
    try { before = baseline(await deps.readBaseline(opts.get('--before')!)); }
    catch { emit({ error: 'baseline unavailable or invalid' }); return 1; }
  }
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  if (waitText) { process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt); }
  try {
    const runsDir = opts.get('--runs-dir');
    if (waitText) { before = (await observe(deps, runsDir)).snapshot; await deps.wait(Number(waitText) * 1000, controller.signal); if (controller.signal.aborted) throw new Error('interrupted'); }
    const { snapshot, journal, runs } = await observe(deps, runsDir);
    const now = Date.parse(snapshot.observedAt), prior = before ? Date.parse(before.observedAt) : now;
    if (before && prior > now) { emit({ error: 'baseline is in the future' }); return 1; }
    const since = (at: string) => { const t = Date.parse(at); return Number.isFinite(t) && t > prior && t <= now; };
    const oldClaims = new Set(before?.claims), oldPublishes = new Set(before?.publishes);
    const claims = before && snapshot.claimedHealthy ? runs.claimed.filter(row => since(row.at) && !oldClaims.has(claimKey(row))).slice(0, 50) : [];
    const publishes = before && snapshot.metricsHealthy ? runs.publishesLastHour.filter(row => since(row.at) && !oldPublishes.has(publishKey(row))).slice(0, 50) : [];
    const ambiguous = before && (runs.claimed.some(row => !oldClaims.has(claimKey(row)) && !since(row.at)) ||
      runs.publishesLastHour.some(row => !oldPublishes.has(publishKey(row)) && !since(row.at)));
    const elapsed = now - prior;
    const enough = !!before && !ambiguous && elapsed >= MIN_WINDOW && elapsed <= MAX_WINDOW && before.claimedHealthy && before.metricsHealthy &&
      snapshot.claimedHealthy && snapshot.metricsHealthy && before.claimsComplete && snapshot.claimsComplete && snapshot.publishesComplete;
    const rejection = before && snapshot.ingestHealthy ? rejectionDelta(before, snapshot.ingest, journal.ingest) : { continuity: 'unknown', rejections: [] };
    emit({ v: 1, observedAt: snapshot.observedAt, before: before?.observedAt ?? null, elapsedMs: before ? elapsed : null,
      status: claims.length || publishes.length ? 'progress' : enough ? 'incident' : 'insufficient-history',
      claims, publishes, ingest: rejection, sources: { journal: journal.sources, runs: runs.sources } });
    if (opts.has('--save')) await deps.save(opts.get('--save')!, `${JSON.stringify(snapshot)}\n`);
    return 0;
  } catch {
    emit({ error: controller.signal.aborted ? 'interrupted' : 'observation or save failed' });
    return controller.signal.aborted ? 130 : 1;
  } finally { if (waitText) { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); } }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runLeaderProgressCheck(process.argv.slice(2));
}
