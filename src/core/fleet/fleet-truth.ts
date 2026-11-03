/**
 * One shared answer to "what did the fleet ship, and what is it doing now".
 *
 * The authority ledger only records merges the Phantom authority path lands.
 * dispatchd fleet merges (fork publish.sh + gh auto-merge) never write there,
 * so every surface that counted ledger merges alone ("Shipped: nothing merged
 * today" in the Telegram recap, the fleet pulse, the desktop mergedToday)
 * under-reported by the whole fleet. This module is the single source those
 * surfaces read: merged PRs from GitHub across the owner's repos, unioned and
 * deduped by repo#number with the ledger merges, plus running/queued counts
 * from the runs dir.
 *
 * Honesty rule: when GitHub cannot be read, `mergeCountState` is
 * 'unavailable' and callers say "merge count unavailable", never "nothing
 * merged". Never throws. No tokens are read or logged; gh authenticates itself.
 */
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const FLEET_OWNER = 'ashlrai';
export const FLEET_TIME_ZONE = 'America/New_York';
const CACHE_MS = 120_000;
const GH_LIMIT = 1000;
const GH_TIMEOUT_MS = 30_000;
const GH_MAX_BUFFER = 8 * 1024 * 1024;
const ADMISSION_MAX_AGE_MS = 15 * 60_000;

export interface FleetMergedPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  mergedAtMs: number;
  source: 'gh' | 'ledger' | 'both';
}

export interface FleetTruth {
  windowStartMs: number;
  windowEndMs: number;
  /** Newest first, deduped by repo#number. */
  merged: FleetMergedPr[];
  /** 'ok' = GitHub answered; 'unavailable' = it did not (merged may then hold ledger merges only). */
  mergeCountState: 'ok' | 'unavailable';
  /** GitHub search caps at 1000; true means the count is a floor. */
  truncated: boolean;
  /** null = unknown. */
  running: number | null;
  queued: number | null;
}

export interface LedgerMerge {
  repo: string | null;
  number: number | null;
  title?: string | null;
  url?: string | null;
  atMs: number;
}

export type GhRunner = (args: string[]) => Promise<string>;

export interface FleetTruthOptions {
  nowMs?: number;
  /** Test seam; defaults to `gh` via execFile. */
  gh?: GhRunner;
  /** Merges recorded in the authority ledger inside the window. */
  ledgerMerges?: (sinceMs: number, untilMs: number) => Promise<LedgerMerge[]> | LedgerMerge[];
  runsDir?: string;
  /** Live job processes, used when admission.json is missing or stale. */
  liveWorkers?: () => Promise<number | null>;
  /** Bypass the 120s cache. */
  fresh?: boolean;
}

// ---------------------------------------------------------------------------
// Local-day boundary
// ---------------------------------------------------------------------------

function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const n = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - Math.floor(utcMs / 1000) * 1000;
}

/** UTC ms of 00:00 on the calendar day containing `nowMs` in `timeZone` (DST-safe). */
export function startOfDayInZone(nowMs: number, timeZone: string = FLEET_TIME_ZONE): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(nowMs));
    const n = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const wallMidnight = Date.UTC(n('year'), n('month') - 1, n('day'));
    // The offset can differ between the guess and the true instant across a DST change: settle in two passes.
    let guess = wallMidnight - zoneOffsetMs(wallMidnight, timeZone);
    guess = wallMidnight - zoneOffsetMs(guess, timeZone);
    return guess;
  } catch {
    const d = new Date(nowMs);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

const realGh: GhRunner = (args) =>
  new Promise((resolve, reject) => {
    try {
      execFile('gh', args, {
        cwd: homedir(),
        timeout: GH_TIMEOUT_MS,
        encoding: 'utf8',
        maxBuffer: GH_MAX_BUFFER,
        windowsHide: true,
        env: { ...process.env, GH_HOST: 'github.com', GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
      }, (err, stdout) => (err ? reject(new Error('gh unavailable')) : resolve(String(stdout))));
    } catch {
      reject(new Error('gh unavailable'));
    }
  });

interface GhRow {
  repo: string;
  number: number;
  title: string;
  url: string;
  mergedAtMs: number;
}

function parseGhRows(stdout: string): GhRow[] {
  const raw: unknown = JSON.parse(stdout);
  if (!Array.isArray(raw)) throw new Error('unexpected gh output');
  const rows: GhRow[] = [];
  for (const r of raw) {
    if (typeof r !== 'object' || r === null) continue;
    const row = r as Record<string, unknown>;
    const repo = (row['repository'] as Record<string, unknown> | undefined)?.['nameWithOwner'];
    const closed = typeof row['closedAt'] === 'string' ? Date.parse(row['closedAt']) : NaN;
    if (typeof repo !== 'string' || typeof row['number'] !== 'number' || !Number.isFinite(closed)) continue;
    rows.push({
      repo,
      number: row['number'],
      title: typeof row['title'] === 'string' ? row['title'] : '',
      url: typeof row['url'] === 'string' ? row['url'] : `https://github.com/${repo}/pull/${row['number']}`,
      mergedAtMs: closed,
    });
  }
  return rows;
}

const ghCache = new Map<string, { at: number; rows: GhRow[]; truncated: boolean }>();

/** Test hook: drop the 120s gh cache. */
export function resetFleetTruthCache(): void {
  ghCache.clear();
}

async function readGhMerges(sinceMs: number, nowMs: number, gh: GhRunner, fresh: boolean): Promise<{ rows: GhRow[]; truncated: boolean } | null> {
  // Open-ended on the right so one cached read serves every window that starts here.
  const key = new Date(sinceMs).toISOString();
  const hit = ghCache.get(key);
  if (!fresh && hit && nowMs >= hit.at && nowMs - hit.at < CACHE_MS) return hit;
  try {
    const stdout = await gh([
      'search', 'prs', '--owner', FLEET_OWNER, '--merged', '--merged-at', `>=${key.replace(/\.\d{3}Z$/, 'Z')}`,
      '--json', 'repository,number,title,url,closedAt', '--limit', String(GH_LIMIT),
    ]);
    const rows = parseGhRows(stdout);
    const entry = { at: nowMs, rows, truncated: rows.length >= GH_LIMIT };
    ghCache.set(key, entry);
    return entry;
  } catch {
    ghCache.delete(key);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Ledger + runs dir
// ---------------------------------------------------------------------------

async function defaultLedgerMerges(sinceMs: number, untilMs: number): Promise<LedgerMerge[]> {
  const { readLedger } = await import('../authority/ledger.js');
  const res = await readLedger({ sinceAt: new Date(sinceMs).toISOString(), kinds: ['merge:landed'] });
  const out: LedgerMerge[] = [];
  for (const e of res.entries) {
    const d = (e.data ?? {}) as unknown as Record<string, unknown>;
    const atMs = Date.parse(String(d['landedAt'] ?? e.at));
    if (!Number.isFinite(atMs) || atMs < sinceMs || atMs > untilMs) continue;
    const repo = typeof d['repo'] === 'string' ? (d['repo'] as string) : e.repo;
    out.push({ repo, number: typeof d['prNumber'] === 'number' ? (d['prNumber'] as number) : null, atMs });
  }
  return out;
}

function runsRoot(opts: FleetTruthOptions): string {
  return opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
}

async function readQueued(root: string): Promise<number | null> {
  try {
    const { parseReadyTsv } = await import('./lane-console.js');
    const text = await readFile(join(root, 'queue', 'ready.tsv'), 'utf8');
    return parseReadyTsv(text).rows.filter((r) => r.status === 'READY' && !/^PARKED[^.]*\./i.test(r.pool)).length;
  } catch {
    return null;
  }
}

async function readRunning(root: string, nowMs: number, liveWorkers: FleetTruthOptions['liveWorkers']): Promise<number | null> {
  try {
    const adm = JSON.parse(await readFile(join(root, 'queue', 'admission.json'), 'utf8')) as Record<string, unknown>;
    const ts = typeof adm['ts'] === 'string' ? Date.parse(adm['ts']) : NaN;
    const running = adm['running'];
    if (typeof running === 'number' && Number.isSafeInteger(running) && running >= 0 && Number.isFinite(ts) && nowMs - ts <= ADMISSION_MAX_AGE_MS) return running;
  } catch {
    // fall through to the live process table
  }
  try {
    if (liveWorkers) return await liveWorkers();
    const { listLiveWorkers } = await import('./runs-live-workers.js');
    const snap = await listLiveWorkers({ now: () => nowMs });
    return snap.sourceState === 'healthy' ? snap.workers.length : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

/** Merged PRs in [sinceMs, now] across the fleet's repos plus running/queued counts. Never throws. */
export async function getFleetTruth(sinceMs: number, opts: FleetTruthOptions = {}): Promise<FleetTruth> {
  const nowMs = opts.nowMs ?? Date.now();
  const root = runsRoot(opts);
  const gh = opts.gh ?? (process.env['ASHLR_FLEET_TRUTH_GH'] === 'off' ? null : realGh);

  const [ghRead, ledger, queued, running] = await Promise.all([
    gh ? readGhMerges(sinceMs, nowMs, gh, opts.fresh === true) : Promise.resolve(null),
    (async () => {
      try {
        return await (opts.ledgerMerges ?? defaultLedgerMerges)(sinceMs, nowMs);
      } catch {
        return [] as LedgerMerge[];
      }
    })(),
    readQueued(root),
    readRunning(root, nowMs, opts.liveWorkers),
  ]);

  const byKey = new Map<string, FleetMergedPr>();
  for (const r of ghRead?.rows ?? []) {
    if (r.mergedAtMs < sinceMs || r.mergedAtMs > nowMs) continue;
    byKey.set(`${r.repo.toLowerCase()}#${r.number}`, { ...r, source: 'gh' });
  }
  for (const m of ledger) {
    if (!m.repo || m.number === null) continue; // no identity to dedupe on; cannot be unioned safely
    const key = `${m.repo.toLowerCase()}#${m.number}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.source = existing.source === 'gh' ? 'both' : existing.source;
      continue;
    }
    byKey.set(key, {
      repo: m.repo,
      number: m.number,
      title: m.title ?? '',
      url: m.url ?? `https://github.com/${m.repo}/pull/${m.number}`,
      mergedAtMs: m.atMs,
      source: 'ledger',
    });
  }
  const merged = [...byKey.values()].sort((a, b) => b.mergedAtMs - a.mergedAtMs);
  // Ledger merges that carry no PR number still happened: count them so a gh outage never zeroes them out.
  const anonymous = ledger.filter((m) => !m.repo || m.number === null);
  for (const m of anonymous) {
    merged.push({ repo: m.repo ?? 'repo', number: 0, title: m.title ?? '', url: m.url ?? '', mergedAtMs: m.atMs, source: 'ledger' });
  }
  return {
    windowStartMs: sinceMs,
    windowEndMs: nowMs,
    merged,
    mergeCountState: ghRead ? 'ok' : 'unavailable',
    truncated: ghRead?.truncated ?? false,
    running,
    queued,
  };
}

/** Today (America/New_York) so far. The one definition every "merged today" surface uses. */
export function getFleetTruthToday(opts: FleetTruthOptions = {}): Promise<FleetTruth> {
  const nowMs = opts.nowMs ?? Date.now();
  return getFleetTruth(startOfDayInZone(nowMs), { ...opts, nowMs });
}
