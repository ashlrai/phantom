/**
 * `phm host top`: one read-only snapshot of what is using this Mac, in plain buckets, with one suggestion.
 * It only reads (ps, vm_stat, sysctl, lsappinfo, statfs and the fleet sampler's disk history). It never kills,
 * pauses or quits anything, and it never suggests quitting Phantom or the app in front. Anything it cannot
 * read is null and named in `gaps`.
 */
import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import { homedir, totalmem } from 'node:os';
import { join } from 'node:path';
import { defaultMacAppsProbe } from '../apps-known.js';
import { parsePressureLevel, parseSwapUsage, parseVmStat } from '../run/host-headroom.js';
import { readSource } from './runs-parked-queue.js';
import {
  HOST_DISK_FLOOR_GB, HOST_TOP_BUCKETS, HOST_TOP_SCHEMA, diskTrend, hostTopMemory,
  type HostDiskSample, type HostTopBucket, type HostTopBucketId, type HostTopReport,
} from './host-top-view.js';
import {
  HOST_LOAD_MODEL_COMMAND, HOST_LOAD_SYSTEM_PATH, baseName, parseHostPs, plainName, readHostLoad, readHostLoadJobRoots, readHostPs,
  type HostLoad, type HostLoadItem, type HostLoadJobRoot, type HostPsRow,
} from './host-load.js';

export * from './host-top-view.js';

export interface HostTopInput {
  psText: string | null;
  jobRoots: readonly HostLoadJobRoot[] | null;
  load: Pick<HostLoad, 'load1' | 'load5' | 'cores'>;
  /** Text of `vm_stat`, `sysctl vm.swapusage` and `sysctl -n kern.memorystatus_vm_pressure_level`; null when unread. */
  vmStatText?: string | null; swapText?: string | null; pressureText?: string | null;
  totalBytes?: number | null;
  /** Bundle path of the app in front; null when unknown. */
  frontApp?: string | null;
  /** This process: it and its children count as Phantom. */
  selfPid?: number;
  /** Free-disk readings (the sampler's history plus a live one); empty means none were readable. */
  diskSamples?: readonly HostDiskSample[];
  /** The floor in GB the free-disk trend measures to; default HOST_DISK_FLOOR_GB. */
  floorGb?: number;
  now?: number;
}

const APP_WORDS: ReadonlyArray<[HostTopBucketId, RegExp]> = [
  ['claude', /\bclaude\b/i], ['codex', /\bcodex\b/i], ['chatgpt', /\bchatgpt\b/i], ['cursor', /\bcursor\b/i], ['grok', /\bgrok\b/i], ['chrome', /\bchrome\b/i],
];
const INDEXING = /^(?:mds|mds_stores|mdworker\w*|mdsync|corespotlightd|spotlightknowledged|photoanalysisd|mediaanalysisd)$/;
const round1 = (value: number): number => Math.round(value * 10) / 10;
const using = (bucket: HostTopBucket): string => `using ${hostTopMemory(bucket.rssMb)} and ${Math.round(bucket.cpuPercent)}% CPU`;
const def = (id: HostTopBucketId) => HOST_TOP_BUCKETS.find(bucket => bucket.id === id)!;

/** What a command is by itself: a bucket and, for other apps, the app name. Null means its parent decides. */
function own(comm: string): [HostTopBucketId, string | null] | null {
  const app = /\/([^/]+)\.app\/Contents\//.exec(comm)?.[1], base = baseName(comm);
  if (HOST_LOAD_MODEL_COMMAND.test(base)) return ['local-models', null];
  if (/docker|containerd/i.test(`${app ?? ''} ${base}`)) return ['docker', null];
  if (/\bphantom\b/i.test(app ?? '') || /^(?:phm|ashlr|phantom)$/.test(base)) return ['phantom', null];
  const known = APP_WORDS.find(([id, word]) => app ? word.test(app) : base === id);
  if (known) return [known[0], null];
  if (INDEXING.test(base)) return ['indexing', null];
  return app ? ['other-apps', app] : null;
}

/** Pure: builds the report from canned text. Never runs a command. */
export function buildHostTop(input: HostTopInput): HostTopReport {
  const rows = parseHostPs(input.psText);
  const rootJob = new Map((input.jobRoots ?? []).map(root => [root.pid, root.jobId]));
  // A process under a fleet job root is a fleet worker whatever its name; otherwise the nearest of itself and its parents that has a bucket decides.
  const place = (row: HostPsRow): [HostTopBucketId, string | null] => {
    let inherited: [HostTopBucketId, string | null] | null = null;
    const seen = new Set<number>();
    for (let at: HostPsRow | undefined = row; at && !seen.has(at.pid); at = rows.get(at.ppid)) {
      seen.add(at.pid);
      const job = rootJob.get(at.pid);
      if (job !== undefined) return ['fleet-workers', job];
      inherited ??= at.pid === input.selfPid ? ['phantom', null] : own(at.comm);
    }
    return inherited ?? [row.pid <= 1 || HOST_LOAD_SYSTEM_PATH.test(row.comm) ? 'system' : 'other', null];
  };
  const items = new Map<HostTopBucketId, Map<string, HostLoadItem>>(HOST_TOP_BUCKETS.map(bucket => [bucket.id, new Map()]));
  for (const row of rows.values()) {
    const [id, label] = place(row), name = plainName(label ?? baseName(row.comm)), bucket = items.get(id)!;
    const item = bucket.get(name) ?? { name, cpuPercent: 0, rssMb: 0, processes: 0 };
    item.cpuPercent += row.cpu; item.rssMb += row.rssKb / 1024; item.processes++;
    bucket.set(name, item);
  }
  const { cores } = input.load, totalBytes = input.totalBytes ?? null;
  const sum = <T,>(list: readonly T[], pick: (item: T) => number) => list.reduce((total, item) => total + pick(item), 0);
  const raw = HOST_TOP_BUCKETS.map(({ id, name }) => {
    const all = [...items.get(id)!.values()].sort((a, b) => b.cpuPercent + b.rssMb / 100 - a.cpuPercent - a.rssMb / 100 || a.name.localeCompare(b.name));
    return { id, name, cpuPercent: round1(sum(all, item => item.cpuPercent)), rssMb: Math.round(sum(all, item => item.rssMb)), processes: sum(all, item => item.processes),
      items: all.slice(0, 3).map(item => ({ ...item, cpuPercent: round1(item.cpuPercent), rssMb: Math.round(item.rssMb) })) };
  });
  const totals = { cpuPercent: round1(sum(raw, bucket => bucket.cpuPercent)), rssMb: sum(raw, bucket => bucket.rssMb), processes: sum(raw, bucket => bucket.processes) };
  // Shares are of the whole Mac when its size is known, else of everything that is running.
  const cpuWhole = cores ? cores * 100 : totals.cpuPercent, memWhole = totalBytes ? totalBytes / 1024 / 1024 : totals.rssMb;
  const share = (part: number, whole: number) => whole > 0 ? Math.min(1, part / whole) : 0;
  const buckets: HostTopBucket[] = raw.map((bucket, order) => ({ bucket, order, score: Math.max(share(bucket.cpuPercent, cpuWhole), share(bucket.rssMb, memWhole)) }))
    .sort((a, b) => Number(b.bucket.processes > 0) - Number(a.bucket.processes > 0) || b.score - a.score || a.order - b.order)
    .map(({ bucket, score }) => ({ ...bucket, sharePercent: Math.round(score * 100) }));

  const front = input.frontApp ? own(`${input.frontApp.replace(/\/+$/, '')}/Contents/MacOS/app`) : null;
  const frontApp = input.frontApp ? plainName(baseName(input.frontApp.replace(/\/+$/, '')).replace(/\.app$/, '')) : null;
  /** The advice for a bucket, or why there is none. Phantom and the app in front never get advice. */
  const advise = (bucket: HostTopBucket): { advice: string | null; why: string } => {
    const { action, advice } = def(bucket.id);
    if (bucket.id === 'phantom') return { advice: null, why: 'No change is suggested for Phantom itself.' };
    if (front?.[0] === bucket.id) return { advice: null, why: 'It is the app in front, so no change is suggested.' };
    if (action === 'quit' && frontApp === null) return { advice: null, why: 'The app in front is unknown, so quitting is not suggested.' };
    return { advice, why: bucket.id === 'other' && bucket.items[0] ? `The busiest is ${bucket.items[0].name}.` : 'There is nothing to quit there.' };
  };
  const live = buckets.filter(bucket => bucket.processes > 0), biggest = live[0] ?? null;
  let suggestion: HostTopReport['suggestion'] = { line: 'What is using this Mac is unknown: the process list could not be read.', bucket: null, action: null };
  if (biggest && biggest.sharePercent < 10) {
    suggestion = { ...suggestion, line: `Nothing is using much of this Mac. The largest is ${biggest.name}, ${using(biggest)}.` };
  } else if (biggest) {
    const first = advise(biggest), line = `${def(biggest.id).says} ${using(biggest)}`;
    const next = first.advice ? undefined : live.slice(1).find(bucket => bucket.sharePercent >= 10 && advise(bucket).advice);
    const target = first.advice ? biggest : next;
    suggestion = {
      line: first.advice ? `${line}; ${first.advice}.` : `${line}. ${first.why}${next ? ` Next: ${def(next.id).says} ${using(next)}; ${advise(next).advice}.` : ''}`,
      bucket: target?.id ?? null, action: target ? def(target.id).action : null,
    };
  }

  const level = input.pressureText == null ? null : parsePressureLevel(input.pressureText);
  const pressure = level === null ? null : level === 1 ? 'normal' : level === 2 ? 'warning' : 'critical';
  const swap = input.swapText == null ? null : parseSwapUsage(input.swapText);
  const free = input.vmStatText == null || !totalBytes ? null : parseVmStat(input.vmStatText, totalBytes);
  const disk = diskTrend(input.diskSamples ?? [], input.floorGb ?? HOST_DISK_FLOOR_GB, input.now ?? Date.now());
  const { load1, load5 } = input.load;
  const gaps: string[] = [];
  if (rows.size === 0) gaps.push('The process list is unavailable, so what is using this Mac is unknown.');
  else if (input.jobRoots === null) gaps.push('Fleet job roots are unknown, so fleet workers are counted under other buckets.');
  else if (input.jobRoots.length === 0) gaps.push('No fleet job roots are registered, so any fleet workers are counted under other buckets.');
  if (frontApp === null) gaps.push('The app in front is unknown.');
  if (load1 === null || load5 === null) gaps.push('Load is unknown.');
  if (pressure === null) gaps.push('Memory pressure is unknown.');
  if (swap === null) gaps.push('Swap used is unknown.');
  if (free === null) gaps.push('Free memory is unknown.');
  if (disk.freeGb === null) gaps.push('Free disk is unknown.');
  return {
    schema: HOST_TOP_SCHEMA, version: 1, generatedAt: new Date(input.now ?? Date.now()).toISOString(),
    state: rows.size === 0 ? 'unknown' : gaps.length ? 'partial' : 'known',
    host: { load1, load5, cores, pressure, swapUsedGb: swap === null ? null : round1(swap), memoryFreePercent: free === null ? null : Math.round(free), disk },
    totals, buckets, frontApp, biggest: biggest?.id ?? null, suggestion,
    gaps: rows.size === 0 ? gaps : [...gaps, 'Memory is resident memory added up per process, so shared memory is counted more than once.',
      'Tools started through node or python count under their parent app, or under Other.'],
  };
}

/** Rows of the fleet sampler's history (`queue/disk-growth-history.json`, written as {at, free_gb}); anything else is skipped. */
export function parseDiskHistory(text: string | null): HostDiskSample[] {
  let rows: unknown;
  try { rows = JSON.parse(text ?? ''); } catch { return []; }
  if (!Array.isArray(rows)) return [];
  const samples: HostDiskSample[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const { at, free_gb: freeGb } = row as Record<string, unknown>;
    if (typeof at === 'number' && Number.isFinite(at) && typeof freeGb === 'number' && Number.isFinite(freeGb)) samples.push({ at, freeGb });
  }
  return samples;
}

export async function readLiveDiskSample(): Promise<HostDiskSample | null> {
  try {
    const { bavail, bsize } = await statfs(homedir());
    if (!Number.isFinite(bavail) || !Number.isFinite(bsize) || bavail < 0 || bsize <= 0) return null;
    return { at: Math.floor(Date.now() / 1000), freeGb: (bavail * bsize) / 1e9 };
  } catch { return null; }
}

/** The sampler's history plus one live reading of the same volume; empty when neither is readable. */
export async function readDiskSamples(runsDir: string, live: () => Promise<HostDiskSample | null> = readLiveDiskSample): Promise<HostDiskSample[]> {
  let text: string | null = null;
  try {
    const source = await readSource(join(runsDir, 'queue', 'disk-growth-history.json'), 5 * 1024 * 1024, false);
    if (source.state === 'healthy') text = source.text;
  } catch { /* No readable history. */ }
  const reading = await live().catch(() => null);
  return reading ? [...parseDiskHistory(text), reading] : parseDiskHistory(text);
}

export interface HostTopDeps {
  /** Returns the text of `ps -axo pid,ppid,pcpu,rss,comm`, or null. Tests inject text. */
  ps?: () => Promise<string | null>;
  jobRoots?: () => HostLoadJobRoot[] | null;
  load?: () => HostLoad;
  /** Runs one fixed read-only command and returns its text, or null. */
  run?: (file: string, args: string[]) => Promise<string | null>;
  /** Bundle path of the app in front, or null. */
  frontApp?: () => Promise<string | null>;
  /** Free-disk readings for the trend; the default reads the sampler's history plus one live reading. */
  diskSamples?: () => Promise<HostDiskSample[]>;
  /** Runs dir holding queue/disk-growth-history.json. Default: ASHLR_RUNS_DIR, then ~/.ashlr-runs. */
  runsDir?: string;
  /** The floor in GB the free-disk trend measures to; default HOST_DISK_FLOOR_GB. */
  floorGb?: number;
  totalBytes?: number; selfPid?: number; now?: () => number;
}

export const runRead = (file: string, args: string[]): Promise<string | null> => new Promise(resolve => {
  if (process.platform !== 'darwin') { resolve(null); return; }
  try {
    execFile(file, args, { timeout: 5000, maxBuffer: 1024 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C' } }, (error, stdout) => resolve(error ? null : stdout));
  } catch { resolve(null); }
});

/** The one impure entry: reads everything at once, then hands the text to buildHostTop. Never throws, never acts. */
export async function readHostTopReport(deps: HostTopDeps = {}): Promise<HostTopReport> {
  const run = deps.run ?? runRead;
  const quiet = <T,>(read: () => Promise<T | null>): Promise<T | null> => { try { return read().catch(() => null); } catch { return Promise.resolve(null); } };
  const [psText, vmStatText, swapText, pressureText, frontApp, diskSamples] = await Promise.all([
    quiet(deps.ps ?? readHostPs), quiet(() => run('/usr/bin/vm_stat', [])), quiet(() => run('/usr/sbin/sysctl', ['vm.swapusage'])),
    quiet(() => run('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'])),
    quiet(deps.frontApp ?? (() => defaultMacAppsProbe()?.frontmost() ?? Promise.resolve(null))),
    quiet(() => (deps.diskSamples ?? (() => readDiskSamples(deps.runsDir ?? defaultRunsDir())))()),
  ]);
  let jobRoots: HostLoadJobRoot[] | null = null;
  try { jobRoots = (deps.jobRoots ?? readHostLoadJobRoots)(); } catch { /* Unknown job roots. */ }
  return buildHostTop({ psText, jobRoots, load: (deps.load ?? readHostLoad)(), vmStatText, swapText, pressureText, frontApp,
    diskSamples: diskSamples ?? [], floorGb: deps.floorGb,
    totalBytes: deps.totalBytes ?? totalmem(), selfPid: deps.selfPid ?? process.pid, now: (deps.now ?? Date.now)() });
}

/** ASHLR_RUNS_DIR overrides ~/.ashlr-runs — the fleet runs-dir convention fleet-runs-api uses. */
export function defaultRunsDir(): string {
  return process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
}
