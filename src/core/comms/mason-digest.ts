/** `phm fleet mason-digest`: Mason's hourly update in plain words, at most six lines.
 *
 * Built only from readers other commands already use: the job metrics ledger (`phm throughput`), the lane
 * snapshot (`phm fleet lanes`), the latest release per guarded repo (`phm fleet pulse`), the spend snapshot
 * (`phm spend`) and the Needs-Mason ledger (`phm fleet needs-triage`). `buildMasonDigest` is pure.
 *
 * Posting goes through the existing owner-thread writer (`postOwnerNotice`) and nowhere else: it records one line
 * in Mason's own thread and calls no channel transport, so nothing is sent to anyone. The self-tick hook
 * (`tickMasonDigest`) posts at most once an hour, only when something changed, and stops when the live config
 * key `mason.digest.off` is 1. A number that could not be read is "unknown", never 0. */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { postOwnerNotice, type OwnerThreadOptions, type OwnerThreadResult } from './owner-thread.js';
import { createConfigReader } from '../fleet/dynconfig.js';
import { readNeedsMason } from '../fleet/needs-mason-resolve.js';
import { triageNeedsItems, type HardLimit } from '../fleet/needs-mason-triage.js';
import { readFleetMainHealth } from '../fleet/main-health.js';
import { readReleases, type PulseRelease } from '../fleet/pulse.js';
import { readSlots, type LaneSlotRead } from '../fleet/pulse-lanes.js';
import { readThroughput, THROUGHPUT_MAX_HOURS, type ThroughputReport } from '../fleet/throughput.js';
import { readUsageSpend, type SpendSnapshot } from '../usage/spend.js';

export const MASON_DIGEST_SCHEMA = 'phantom.mason.digest.v1' as const;
export const MASON_DIGEST_OFF_KEY = 'mason.digest.off';
export const MASON_DIGEST_LAST_FILE = 'queue/mason-digest-last.json';
export const MASON_DIGEST_MAX_LINES = 6;
const HOUR_MS = 3_600_000;
const POOLS_SHOWN = 3;

/** The asks that truly need Mason: passwords and sign-in, payment, device or signing approval. */
const ASK_WORDS: Partial<Record<HardLimit, string>> = { secrets: 'password or sign-in', money: 'payment', authority: 'device or signing approval' };

/** Every reader's output as it returned it; null when that reader failed. */
export interface MasonDigestInputs {
  throughput: ThroughputReport | null;
  slots: LaneSlotRead[] | null;
  releases: PulseRelease[] | null;
  spend: SpendSnapshot | null;
  asks: { id: string; limit: HardLimit }[] | null;
}

export interface MasonDigestPool { pool: string; used_percent: number; hours_to_reset: number | null }
export interface MasonDigest {
  schema: typeof MASON_DIGEST_SCHEMA;
  as_of: string;
  since: string;
  window_hours: number;
  merged: number | null;
  /** Median minutes from publish to merge; null when nothing merged or no publish time is known. */
  median_minutes_to_merge: number | null;
  releases_published: number | null;
  lanes_busy: number | null;
  lanes_target: number | null;
  /** The busiest pools first, at most three; empty when no pool could be read. */
  pools: MasonDigestPool[];
  /** Share of finished launches that were EMPTY, 0..1; null when unknown or none finished. */
  wasted_launch_rate: number | null;
  /** Open asks that truly need Mason; null when the ledger could not be read. */
  asks: number | null;
  ask_kinds: string[];
  /** The plain-words update, at most six lines. */
  lines: string[];
  /** True when something happened that Mason should hear about (merge, release or ask). */
  has_news: boolean;
  /** Same key means nothing changed since a digest with that key; hours-to-reset is left out on purpose. */
  change_key: string;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const sumKnown = (values: (number | null)[]): number | null => {
  const known = values.filter((v): v is number => v !== null);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
};
const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Whole hours for the throughput window: 1h up to the one-week ledger limit. */
export function digestWindowHours(sinceMs: number, now: number): number {
  return Math.min(THROUGHPUT_MAX_HOURS, Math.max(1, Math.ceil((now - sinceMs) / HOUR_MS)));
}

/** Pure: the digest for these inputs. `sinceMs` bounds which releases count. */
export function buildMasonDigest(inputs: MasonDigestInputs, now: number, sinceMs: number): MasonDigest {
  const hours = digestWindowHours(sinceMs, now);
  const report = inputs.throughput?.metrics === 'ok' ? inputs.throughput : null;
  const merged = report?.totals.merged ?? null;
  const medianS = report?.totals.median_publish_to_merge_s ?? null;
  const median = medianS === null ? null : Math.round(medianS / 60);
  const finished = report?.totals.finished ?? null;
  const wasted = finished === null || finished === 0 ? null : report?.totals.empty_rate ?? null;

  const dated = inputs.releases?.filter(r => r.publishedAt !== null && Number.isFinite(Date.parse(r.publishedAt))) ?? [];
  const releases = inputs.releases === null || dated.length === 0 ? null : dated.filter(r => Date.parse(r.publishedAt!) >= sinceMs).length;

  const busy = sumKnown((inputs.slots ?? []).map(s => s.running));
  const target = sumKnown((inputs.slots ?? []).map(s => s.capacity));

  const pools = (inputs.spend?.pools ?? [])
    .filter(p => p.unit === 'percent' && p.usedPercent !== null)
    .sort((a, b) => b.usedPercent! - a.usedPercent! || a.pool.localeCompare(b.pool))
    .slice(0, POOLS_SHOWN)
    .map((p): MasonDigestPool => ({ pool: p.pool, used_percent: Math.round(p.usedPercent!), hours_to_reset: p.hoursLeft === null ? null : round1(p.hoursLeft) }));

  const asks = inputs.asks === null ? null : inputs.asks.filter(a => ASK_WORDS[a.limit] !== undefined);
  const askKinds = [...new Set((asks ?? []).map(a => ASK_WORDS[a.limit]!))].sort();

  const window = hours === 1 ? 'the last hour' : `the last ${hours} hours`;
  const lines = [
    merged === null ? `Merged: unknown (the job ledger could not be read).`
      : `Merged: ${count(merged, 'PR')} in ${window}, median ${merged === 0 ? 'none' : median === null ? 'unknown' : `${median} min`} to merge.`,
    `Releases: ${releases === null ? 'unknown' : `${releases} published`}.`,
    `Lanes: ${busy === null ? 'unknown' : `${busy} busy`} of ${target === null ? 'unknown' : target} target.`,
    `Pools: ${pools.length === 0 ? 'unknown' : pools.map(p => `${p.pool} ${p.used_percent}% used, resets in ${p.hours_to_reset === null ? 'unknown' : `${p.hours_to_reset}h`}`).join('; ')}.`,
    `Wasted launches: ${wasted === null ? (finished === 0 ? 'none finished' : 'unknown') : `${Math.round(wasted * 100)}%`}.`,
    asks === null ? 'Needs you: unknown (the ask ledger could not be read).'
      : asks.length === 0 ? 'Needs you: nothing.' : `Needs you: ${asks.length} (${askKinds.join(', ')}).`,
  ];

  const hasNews = (merged ?? 0) > 0 || (releases ?? 0) > 0 || (asks?.length ?? 0) > 0;
  const changeKey = JSON.stringify([merged, median, releases, busy, target, pools.map(p => [p.pool, Math.round(p.used_percent / 5)]),
    wasted === null ? null : Math.round(wasted * 20), (asks ?? []).map(a => a.id).sort()]);
  return {
    schema: MASON_DIGEST_SCHEMA, as_of: new Date(now).toISOString(), since: new Date(sinceMs).toISOString(), window_hours: hours,
    merged, median_minutes_to_merge: median, releases_published: releases, lanes_busy: busy, lanes_target: target, pools,
    wasted_launch_rate: wasted, asks: asks === null ? null : asks.length, ask_kinds: askKinds,
    lines: lines.slice(0, MASON_DIGEST_MAX_LINES), has_news: hasNews, change_key: changeKey,
  };
}

export interface MasonDigestReaders {
  throughput: typeof readThroughput;
  slots: typeof readSlots;
  releases: typeof readReleases;
  spend: typeof readUsageSpend;
  asks: (runsDir: string) => { id: string; limit: HardLimit }[] | null;
}

const defaultAsks = (runsDir: string): { id: string; limit: HardLimit }[] | null => {
  const read = readNeedsMason({ runsDir });
  if (read.status === 'unavailable') return null;
  return triageNeedsItems(read.items).hardLimit.map(({ id, limit }) => ({ id, limit }));
};
const DEFAULT_READERS: MasonDigestReaders = { throughput: readThroughput, slots: readSlots, releases: readReleases, spend: readUsageSpend, asks: defaultAsks };

/** Read every input once. Read-only; a reader that fails leaves its numbers unknown. */
export async function readMasonDigestInputs(runsDir: string, now: number, sinceMs: number, readers: Partial<MasonDigestReaders> = {}): Promise<MasonDigestInputs> {
  const r = { ...DEFAULT_READERS, ...readers };
  const quiet = async <T>(read: () => Promise<T> | T): Promise<T | null> => { try { return await read(); } catch { return null; } };
  const throughput = await quiet(() => r.throughput({ runsDir, now, hours: digestWindowHours(sinceMs, now), by: 'lane', metricsPath: join(runsDir, 'metrics', 'jobs.jsonl') }));
  const [slots, spend, asks, main] = await Promise.all([
    quiet(() => r.slots()), quiet(() => r.spend(join(runsDir, 'queue', 'status.json'), now)), quiet(() => r.asks(runsDir)),
    quiet(() => readFleetMainHealth({ runsDir, now: () => now })),
  ]);
  const repos = main?.source === 'ok' ? main.repos.map(repo => repo.repo) : null;
  const releases = repos ? await quiet(() => r.releases(repos, now)) : null;
  return { throughput, slots, releases, spend, asks };
}

export async function readMasonDigest(opts: { runsDir: string; now: number; sinceMs: number; readers?: Partial<MasonDigestReaders> }): Promise<MasonDigest> {
  return buildMasonDigest(await readMasonDigestInputs(opts.runsDir, opts.now, opts.sinceMs, opts.readers), opts.now, opts.sinceMs);
}

/** What was last posted: when, and the change key it carried. */
export interface MasonDigestLast { at: number; key: string }
type LastRead = { state: 'none' } | { state: 'ok'; last: MasonDigestLast } | { state: 'unreadable' };

function readLast(runsDir: string): LastRead {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(runsDir, MASON_DIGEST_LAST_FILE), 'utf8'));
    const row = parsed as Partial<MasonDigestLast> | null;
    if (row && typeof row === 'object' && Number.isFinite(row.at) && typeof row.key === 'string') return { state: 'ok', last: { at: row.at as number, key: row.key } };
    return { state: 'unreadable' };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'none' } : { state: 'unreadable' };
  }
}

function writeLast(runsDir: string, last: MasonDigestLast): void {
  const path = join(runsDir, MASON_DIGEST_LAST_FILE);
  mkdirSync(join(runsDir, 'queue'), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(last), { mode: 0o600, flag: 'wx' }); renameSync(tmp, path); }
  finally { try { unlinkSync(tmp); } catch { /* already renamed */ } }
}

export type MasonDigestPostState =
  | 'posted' | 'duplicate' | 'dry-run' | 'quiet' | 'unchanged' | 'rate-limited' | 'off' | 'unavailable' | 'refused';
export interface MasonDigestPostResult { state: MasonDigestPostState; reason: string }

export interface MasonDigestPostOptions {
  runsDir: string;
  now: number;
  owner: OwnerThreadOptions;
  /** A manual `--post` skips the quiet and unchanged checks; the once-an-hour limit always holds. */
  force?: boolean;
  /** Seam for tests; production is the owner-thread writer. */
  post?: (input: { text: string; idempotencyKey: string }, options: OwnerThreadOptions) => Promise<OwnerThreadResult>;
}

/** One post at most per clock hour: the key doubles as the thread's own duplicate guard. */
export const masonDigestKey = (now: number): string => `mason-digest-${Math.floor(now / HOUR_MS)}`;

/** Post the digest into Mason's own thread, subject to the hourly limit. Never sends anywhere else. */
export async function postMasonDigest(digest: MasonDigest, opts: MasonDigestPostOptions): Promise<MasonDigestPostResult> {
  const prior = readLast(opts.runsDir);
  if (prior.state === 'unreadable') return { state: 'unavailable', reason: 'The last-post record could not be read, so the hourly limit cannot be checked.' };
  if (prior.state === 'ok' && opts.now - prior.last.at < HOUR_MS && prior.last.at <= opts.now) return { state: 'rate-limited', reason: 'A digest was posted less than an hour ago.' };
  if (!opts.force) {
    if (!digest.has_news) return { state: 'quiet', reason: 'Nothing merged, released or asked in the window.' };
    if (prior.state === 'ok' && prior.last.key === digest.change_key) return { state: 'unchanged', reason: 'Nothing changed since the last digest.' };
  }
  const result = await (opts.post ?? postOwnerNotice)({ text: digest.lines.join('\n'), idempotencyKey: masonDigestKey(opts.now) }, opts.owner);
  if (result.status === 'accepted' || result.status === 'duplicate') {
    try { writeLast(opts.runsDir, { at: opts.now, key: digest.change_key }); } catch { /* the hour key still stops a repeat */ }
    return { state: result.status === 'accepted' ? 'posted' : 'duplicate', reason: result.status === 'accepted' ? 'Posted to your thread.' : 'This hour\'s digest is already in your thread.' };
  }
  return { state: result.status === 'refused' ? 'refused' : 'unavailable', reason: 'reason' in result && typeof result.reason === 'string' ? result.reason : 'Your thread could not take the digest.' };
}

/** The kill switch: true off, false on, null when the live config could not be read (treated as off). */
export async function readMasonDigestOff(runsDir: string): Promise<boolean | null> {
  try {
    const resolved = await createConfigReader({ runsDir }).resolve();
    if (resolved.layers.live === 'degraded') return null;
    return resolved.values[MASON_DIGEST_OFF_KEY] === 1;
  } catch { return null; }
}

export interface MasonDigestTickOptions {
  runsDir: string;
  now: number;
  apply: boolean;
  owner: OwnerThreadOptions;
  readOff?: (runsDir: string) => Promise<boolean | null>;
  readers?: Partial<MasonDigestReaders>;
  post?: MasonDigestPostOptions['post'];
}
export interface MasonDigestTickReport extends MasonDigestPostResult { schema: 'phantom.mason.digest.tick.v1'; digest: MasonDigest | null }

/** The self-tick hook: kill switch, then the hourly limit (before any read), then quiet and changed checks. */
export async function tickMasonDigest(o: MasonDigestTickOptions): Promise<MasonDigestTickReport> {
  const done = (result: MasonDigestPostResult, digest: MasonDigest | null = null): MasonDigestTickReport =>
    ({ schema: 'phantom.mason.digest.tick.v1', ...result, digest });
  const off = await (o.readOff ?? readMasonDigestOff)(o.runsDir);
  if (off !== false) return done({ state: 'off', reason: off === true ? 'Switched off with mason.digest.off.' : 'The live config could not be read, so the digest stays off.' });
  if (!o.apply) return done({ state: 'dry-run', reason: 'Dry run: nothing is read or posted.' });
  const prior = readLast(o.runsDir);
  if (prior.state === 'ok' && o.now - prior.last.at >= 0 && o.now - prior.last.at < HOUR_MS) return done({ state: 'rate-limited', reason: 'A digest was posted less than an hour ago.' });
  const digest = await readMasonDigest({ runsDir: o.runsDir, now: o.now, sinceMs: o.now - HOUR_MS, readers: o.readers });
  return done(await postMasonDigest(digest, { runsDir: o.runsDir, now: o.now, owner: o.owner, post: o.post }), digest);
}

/** Plain text for the terminal: the lines as they would be posted. */
export const masonDigestText = (digest: MasonDigest): string => digest.lines.join('\n');
