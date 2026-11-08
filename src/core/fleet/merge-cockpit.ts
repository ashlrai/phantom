/**
 * merge-cockpit.ts — the rebase treadmill as one read-only, loopback-safe
 * snapshot: conflicting bridge PRs per repo, rebase-job coverage, triage→close
 * latency and merge rate, all projected from `~/.ashlr-runs` state. No gh, no
 * git, no network; every source is bounded and reports its own health.
 *
 * Evidence model (each file fails independently):
 *   queue/*.queuegen-state.json  queuegen's emitted map: "<owner>/<repo>#<pr>"
 *                                -> {id, at-ms}. An `RQ-REBASE-` id is durable
 *                                proof the fleet triaged that PR as DIRTY at
 *                                `at` — the cockpit's "triage" timestamp.
 *   queue/ready.tsv              live router queue: active RQ-REBASE rows.
 *   queue/claimed.tsv            dispatchd's claimed (running) jobs.
 *   metrics/jobs.jsonl           job ledger: enqueue/claim/launch/finish rows
 *                                mark rebase work; `outcome` rows carry a PR
 *                                url (or pr/prUrl), a state (or outcome/status)
 *                                and `ttm_s` — merge rate and close evidence.
 *   queue/landed-closes.jsonl    `fleet landed-close` ledger (ashlrai/phantom
 *                                only — the writer is pinned to that repo).
 *   metrics/merge-events.jsonl   optional external ledger (conflict/merged/
 *                                closed per repo#pr); absent is fine.
 *
 * A conflict is "open" while it has no close evidence after its earliest
 * triage and is still fresh: triaged inside --hours or holding a live rebase
 * job. Coverage joins each open conflict's latest emitted rebase id to the
 * queue: the current head is covered, only a stale head is covered, the job
 * already ran (worked), or nothing covers it (uncovered). A second distinct
 * rebase id for the same PR is one more treadmill spin — counted, never
 * smoothed away.
 */
import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { parseReadyTsv } from './lane-console.js';
import { parseClaimedTsv } from './runs-dir-state.js';
import { readSource, type Source } from './runs-parked-queue.js';

export const MERGE_COCKPIT_SCHEMA = 'fleet.merge-cockpit.v1';
export const VERSE_FLEET_MERGE_COCKPIT_PATH = '/api/verse/fleet/merge-cockpit';
const DEFAULT_HOURS = 24;
const MAX_HOURS = 24 * 30;
const MAX_TSV_BYTES = 2 * 1024 * 1024;
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_STATE_FILES = 8;
const MAX_JOBS_TAIL = 16 * 1024 * 1024;
const MAX_LEDGER_TAIL = 1024 * 1024;

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
/** Queuegen's rebase id: RQ-REBASE-<shortRepo>-<pr>-<head7>. */
const REBASE_ID = /^RQ-REBASE-([A-Za-z0-9_.-]{1,60})-([1-9]\d{0,8})-([0-9a-f]{7})$/i;
const EMITTED_KEY = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d{0,8})$/;
const OWNER_NAME = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)\/?$/;
const LIVE_QUEUE_STATUS = /^(?:READY|RUNNING|CLAIMED|LAUNCHED|PARKED-[A-Za-z0-9_-]+(?:\.[A-Za-z0-9._@-]{0,63})?)$/;
/** `fleet landed-close` is pinned to this repo (src/cli/fleet-landed-close.ts). */
const LANDED_CLOSE_REPO = 'ashlrai/phantom';

export type SourceHealth = Source;

export interface LatencySummary { count: number; medianS: number | null; p90S: number | null; maxS: number | null }
export interface MergeCockpitRepo {
  repo: string;
  /** Conflicts on the treadmill now: unresolved and still fresh. */
  conflictsOpen: number;
  /** Distinct PRs the fleet triaged as DIRTY inside the window. */
  conflictsTriaged: number;
  /** Triaged conflicts with close evidence inside the window. */
  conflictsClosed: number;
  /** Earliest triage -> earliest close, seconds; closes inside the window. */
  triageToCloseS: LatencySummary | null;
  /** Open conflicts with no queuegen record — seen only through live queue rows. */
  conflictsUntracked: number;
  /** Per open conflict: is a rebase job covering its latest emitted head? Null when the queue is unreadable. */
  coverage: { current: number; staleHead: number; worked: number; uncovered: number } | null;
  rebase: {
    ready: number; running: number; parked: number;
    /** Distinct rebase job ids with any in-window evidence (queue or ledger). */
    spins: number;
    /** Distinct ids that reached launch or finish inside the window. */
    runs: number;
    /** PRs needing >= 2 distinct rebase ids — the treadmill spun again on a new head. */
    repeatPrs: number;
  };
  merges: { count: number; perHour: number; medianTtmS: number | null };
}
export interface MergeCockpitReport {
  schema: typeof MERGE_COCKPIT_SCHEMA;
  v: 1;
  generatedAt: string;
  hours: number;
  /** True when at least one local source was readable. */
  known: boolean;
  sources: Record<'ready' | 'claimed' | 'queuegenState' | 'jobs' | 'landedCloses' | 'mergeEvents', SourceHealth>;
  /** True when the jobs ledger read clipped its head — windowed counts may undercount. */
  jobsClipped: boolean;
  repos: MergeCockpitRepo[];
  totals: {
    conflictsOpen: number;
    conflictsTriaged: number;
    conflictsClosed: number;
    triageToCloseS: LatencySummary | null;
    rebase: MergeCockpitRepo['rebase'];
    merges: { count: number; perHour: number; medianTtmS: number | null };
  };
}

/** Raw text per source; null means the file failed to read (see `sources`). */
export interface MergeCockpitInput {
  readyTsv: string | null;
  claimedTsv: string | null;
  queuegenStates: string[];
  jobsJsonl: string | null;
  jobsClipped: boolean;
  landedClosesJsonl: string | null;
  mergeEventsJsonl: string | null;
  sources: MergeCockpitReport['sources'];
  hours?: number;
  now?: number;
}

const obj = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const jsonl = (line: string): Record<string, unknown> | null => {
  try { return obj(JSON.parse(line)); } catch { return null; }
};
const finiteMs = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v
    : typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null;

function percentile(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function latency(samples: number[]): LatencySummary {
  const values = samples.filter(v => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  return { count: values.length, medianS: values.length ? percentile(values, 50) : null,
    p90S: values.length ? percentile(values, 90) : null, maxS: values.length ? values[values.length - 1]! : null };
}

function median(values: number[]): number | null {
  const v = values.filter(n => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

interface Conflict {
  repo: string; pr: number;
  /** Queuegen emits (id != null) and merge-events conflicts (id null), ms. */
  triages: { at: number; id: string | null }[];
  /** Close evidence: outcome MERGED/CLOSED, merge-events close, landed-close. */
  closes: number[];
  /** Live queue/claimed rebase job ids for this PR. */
  activeIds: Set<string>;
  /** Rebase job ids with any ledger evidence in the window. */
  ledgerIds: Set<string>;
  /** Rebase job ids that reached launch/finish in the window. */
  workedIds: Set<string>;
}

const keyOf = (repo: string, pr: number) => `${repo.toLowerCase()}#${pr}`;

function conflictAt(map: Map<string, Conflict>, repo: string, pr: number): Conflict {
  const key = keyOf(repo, pr);
  let c = map.get(key);
  if (!c) {
    c = { repo, pr, triages: [], closes: [], activeIds: new Set(), ledgerIds: new Set(), workedIds: new Set() };
    map.set(key, c);
  }
  return c;
}

function parseRebaseId(id: string): { short: string; pr: number; head: string } | null {
  const m = REBASE_ID.exec(id);
  if (!m) return null;
  return { short: m[1]!.toLowerCase(), pr: Number(m[2]), head: m[3]!.toLowerCase() };
}

/**
 * ready.tsv rows, with status-first PARKED-* cells rewritten to `status=` form
 * — the same positional normalization readFleetQueue applies, so parked rebase
 * jobs surface with their real status instead of being misread positionally.
 */
export function parseQueueRows(text: string): ReturnType<typeof parseReadyTsv> {
  const lines = text.split('\n').map(raw => {
    const first = raw.replace(/\r$/, '').split('\t', 1)[0] ?? '';
    return /^PARKED-[A-Za-z0-9_-]+(?:\.[A-Za-z0-9._@-]{0,63})?$/.test(first) ? `status=${first}\t${raw.split('\t').slice(1).join('\t')}` : raw;
  });
  return parseReadyTsv(lines.join('\n'));
}

/** Queuegen state text -> emitted rows; malformed entries are skipped, never invented. */
export function parseQueuegenEmitted(text: string): { repo: string; pr: number; id: string; at: number }[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return []; }
  const emitted = obj(obj(parsed)?.['emitted']);
  if (!emitted) return [];
  const out: { repo: string; pr: number; id: string; at: number }[] = [];
  for (const [key, entry] of Object.entries(emitted)) {
    const k = EMITTED_KEY.exec(key);
    const e = obj(entry);
    if (!k || !e || typeof e['id'] !== 'string' || !JOB_ID.test(e['id'])
      || !Number.isSafeInteger(e['at']) || (e['at'] as number) < 0) continue;
    out.push({ repo: k[1]!.toLowerCase(), pr: Number(k[2]), id: e['id'], at: e['at'] as number });
  }
  return out;
}

interface JobsFacts {
  /** Any in-window ledger evidence per rebase job id. */
  rebaseSeen: Set<string>;
  /** Ids that reached launch or finish inside the window. */
  rebaseWorked: Set<string>;
  /** repo#pr -> earliest terminal outcome (MERGED or CLOSED) in window, ms. */
  closedAtByPr: Map<string, number>;
  /** repo -> merge count + ttm samples in window. */
  merges: Map<string, { count: number; ttm: number[] }>;
}

const pullUrl = (row: Record<string, unknown>): { repo: string; pr: number } | null => {
  for (const field of ['url', 'prUrl', 'pr']) {
    const value = row[field];
    if (typeof value !== 'string') continue;
    const m = PR_URL.exec(value);
    if (m) return { repo: m[1]!.toLowerCase(), pr: Number(m[2]) };
  }
  return null;
};

const REBASE_LEDGER_EVENTS = new Set(['enqueue', 'claim', 'batch_claim', 'launch', 'finish', 'outcome', 'publish']);
const REBASE_WORKED_EVENTS = new Set(['launch', 'finish']);

function scanJobs(text: string, windowStart: number, now: number): JobsFacts {
  const facts: JobsFacts = { rebaseSeen: new Set(), rebaseWorked: new Set(), closedAtByPr: new Map(), merges: new Map() };
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const row = jsonl(line);
    if (!row) continue;
    const at = finiteMs(row['ts']);
    if (at === null || at > now) continue;
    const event = typeof row['event'] === 'string' ? row['event'] : null;
    const job = typeof row['job'] === 'string' ? row['job'] : null;
    if (job && parseRebaseId(job) && at >= windowStart && event !== null && REBASE_LEDGER_EVENTS.has(event)) {
      facts.rebaseSeen.add(job);
      if (REBASE_WORKED_EVENTS.has(event)) facts.rebaseWorked.add(job);
    }
    const state = typeof row['state'] === 'string' ? row['state'].toUpperCase()
      : typeof row['outcome'] === 'string' ? row['outcome'].toUpperCase()
        : typeof row['status'] === 'string' ? row['status'].toUpperCase() : null;
    const isOutcome = event === 'outcome' || (state !== null && ['MERGED', 'CLOSED'].includes(state));
    if (!isOutcome || at < windowStart) continue;
    const url = pullUrl(row);
    if (url && state !== null) {
      const key = keyOf(url.repo, url.pr);
      facts.closedAtByPr.set(key, Math.min(at, facts.closedAtByPr.get(key) ?? Infinity));
    }
    if (state !== 'MERGED') continue;
    const mergeRepo = url?.repo ?? (typeof row['repo'] === 'string' && OWNER_NAME.test(row['repo'].toLowerCase()) ? row['repo'].toLowerCase() : null);
    if (mergeRepo === null) continue;
    const bucket = facts.merges.get(mergeRepo) ?? { count: 0, ttm: [] };
    bucket.count++;
    const ttm = row['ttm_s'];
    if (typeof ttm === 'number' && Number.isFinite(ttm) && ttm >= 0) bucket.ttm.push(ttm);
    facts.merges.set(mergeRepo, bucket);
  }
  return facts;
}

/**
 * The pure report builder — shared by the CLI verb and the Verse API. Texts
 * come from bounded reads; nothing here touches fs, gh or git.
 */
export function buildMergeCockpit(input: MergeCockpitInput): MergeCockpitReport {
  const now = input.now ?? Date.now();
  const hours = Number.isFinite(input.hours) && input.hours! > 0
    ? Math.min(input.hours!, MAX_HOURS) : DEFAULT_HOURS;
  const windowStart = now - hours * 3_600_000;

  // ── queuegen state: triage records + the short-name -> owner/name map ──────
  const emitted: { repo: string; pr: number; id: string; at: number }[] = [];
  for (const text of input.queuegenStates) emitted.push(...parseQueuegenEmitted(text));
  const byShort = new Map<string, string | null>();
  for (const e of emitted) {
    const short = e.repo.split('/')[1]!;
    const existing = byShort.get(short);
    if (existing === undefined) byShort.set(short, e.repo);
    else if (existing !== e.repo) byShort.set(short, null); // owner collision: refuse to guess
  }
  const repoFor = (shortOrFull: string): string | null => {
    const clean = shortOrFull.trim().toLowerCase();
    if (OWNER_NAME.test(clean)) return clean;
    const resolved = byShort.get(clean);
    return resolved === undefined ? null : resolved;
  };

  const conflicts = new Map<string, Conflict>();
  for (const e of emitted) {
    if (e.at > now) continue;
    const parsed = parseRebaseId(e.id);
    if (!parsed || parsed.pr !== e.pr || parsed.short !== e.repo.split('/')[1]!.toLowerCase()) continue;
    conflictAt(conflicts, e.repo, e.pr).triages.push({ at: e.at, id: e.id });
  }

  // ── merge-events ledger (optional): conflict + close evidence ────────────
  if (input.mergeEventsJsonl !== null) {
    for (const line of input.mergeEventsJsonl.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const row = jsonl(line);
      if (!row || typeof row['repo'] !== 'string' || !OWNER_NAME.test(row['repo'].toLowerCase())
        || !Number.isSafeInteger(row['pr']) || (row['pr'] as number) < 1) continue;
      const at = finiteMs(row['at']);
      if (at === null || at > now) continue;
      const repo = row['repo'].toLowerCase();
      if (row['type'] === 'conflict') conflictAt(conflicts, repo, row['pr'] as number).triages.push({ at, id: null });
      else if (row['type'] === 'merged' || row['type'] === 'closed') conflictAt(conflicts, repo, row['pr'] as number).closes.push(at);
    }
  }

  // ── live queue + claimed rows: active rebase jobs ────────────────────────
  const queueReadable = input.readyTsv !== null || input.claimedTsv !== null;
  const liveStatus = new Map<string, { ready: number; running: number; parked: number }>();
  const bump = (repo: string, kind: 'ready' | 'running' | 'parked') => {
    const entry = liveStatus.get(repo) ?? { ready: 0, running: 0, parked: 0 };
    entry[kind]++;
    liveStatus.set(repo, entry);
  };
  if (input.readyTsv !== null) {
    for (const row of parseQueueRows(input.readyTsv).rows) {
      if (!row.id || !LIVE_QUEUE_STATUS.test(row.status)) continue;
      const parsed = parseRebaseId(row.id);
      if (!parsed) continue;
      const repo = repoFor(typeof row.repo === 'string' && row.repo.trim() ? row.repo : parsed.short);
      if (repo === null) continue;
      conflictAt(conflicts, repo, parsed.pr).activeIds.add(row.id);
      bump(repo, row.status.startsWith('PARKED-') ? 'parked' : row.status === 'READY' ? 'ready' : 'running');
    }
  }
  if (input.claimedTsv !== null) {
    for (const row of parseClaimedTsv(input.claimedTsv)) {
      const parsed = parseRebaseId(row.job);
      if (!parsed) continue;
      const repo = repoFor(parsed.short);
      if (repo === null) continue;
      conflictAt(conflicts, repo, parsed.pr).activeIds.add(row.job);
      bump(repo, 'running');
    }
  }

  // ── landed closes (phantom only) ─────────────────────────────────────────
  if (input.landedClosesJsonl !== null) {
    for (const line of input.landedClosesJsonl.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const row = jsonl(line);
      if (!row || row['outcome'] !== 'closed' || !Number.isSafeInteger(row['pr']) || (row['pr'] as number) < 1) continue;
      const at = finiteMs(row['at']);
      if (at === null || at > now) continue;
      conflictAt(conflicts, LANDED_CLOSE_REPO, row['pr'] as number).closes.push(at);
    }
  }

  // ── jobs ledger: merges, close evidence, rebase runs ─────────────────────
  const jobs = input.jobsJsonl !== null ? scanJobs(input.jobsJsonl, windowStart, now) : null;
  if (jobs) {
    for (const [key, at] of jobs.closedAtByPr) conflicts.get(key)?.closes.push(at);
    for (const id of jobs.rebaseSeen) {
      const parsed = parseRebaseId(id)!;
      const repo = repoFor(parsed.short);
      if (repo === null) continue;
      const c = conflictAt(conflicts, repo, parsed.pr);
      c.ledgerIds.add(id);
      if (jobs.rebaseWorked.has(id)) c.workedIds.add(id);
    }
  }

  // ── per-conflict classification ──────────────────────────────────────────
  interface RepoAcc {
    open: number; triaged: number; closed: number; untracked: number;
    cover: { current: number; staleHead: number; worked: number; uncovered: number };
    closeSamples: number[];
  }
  const acc = new Map<string, RepoAcc>();
  const repoAcc = (repo: string): RepoAcc => {
    let a = acc.get(repo);
    if (!a) {
      a = { open: 0, triaged: 0, closed: 0, untracked: 0,
        cover: { current: 0, staleHead: 0, worked: 0, uncovered: 0 }, closeSamples: [] };
      acc.set(repo, a);
    }
    return a;
  };
  // Distinct rebase ids seen per repo#pr across live rows and the ledger.
  const spins = new Map<string, Map<string, Set<string>>>(); // repo -> pr -> ids
  const spin = (repo: string, pr: number, ids: Iterable<string>) => {
    let prs = spins.get(repo);
    if (!prs) { prs = new Map(); spins.set(repo, prs); }
    const key = String(pr);
    const set = prs.get(key) ?? new Set<string>();
    for (const id of ids) set.add(id);
    prs.set(key, set);
  };

  for (const c of conflicts.values()) {
    const a = repoAcc(c.repo);
    const triages = c.triages.sort((x, y) => x.at - y.at);
    const firstTriage = triages[0]?.at;
    const lastTriage = triages.at(-1);
    c.closes.sort((x, y) => x - y);
    if (firstTriage !== undefined && firstTriage >= windowStart) a.triaged++;
    spin(c.repo, c.pr, c.activeIds);
    spin(c.repo, c.pr, c.ledgerIds);
    // Closed = first close evidence inside the window at or after the first
    // triage; the sample is first-triage -> that close, in seconds.
    const close = firstTriage === undefined
      ? undefined : c.closes.find(at => at >= firstTriage && at >= windowStart);
    if (close !== undefined) {
      a.closed++;
      a.closeSamples.push(Math.round((close - firstTriage!) / 1000));
      continue;
    }
    const fresh = (lastTriage?.at ?? 0) >= windowStart || c.activeIds.size > 0;
    if (!fresh) continue; // old record with no close evidence: not on the treadmill
    a.open++;
    if (triages.length === 0) a.untracked++;
    if (queueReadable) {
      const latestId = lastTriage?.id ?? null;
      if ([...c.activeIds].some(id => latestId === null || id === latestId)) a.cover.current++;
      else if (c.activeIds.size > 0) a.cover.staleHead++;
      else if (c.workedIds.size > 0) a.cover.worked++;
      else a.cover.uncovered++;
    }
  }

  const repos: MergeCockpitRepo[] = [];
  const mergeFacts = jobs?.merges ?? new Map<string, { count: number; ttm: number[] }>();
  for (const repo of new Set([...acc.keys(), ...liveStatus.keys(), ...mergeFacts.keys()])) {
    const a = acc.get(repo) ?? { open: 0, triaged: 0, closed: 0, untracked: 0,
      cover: { current: 0, staleHead: 0, worked: 0, uncovered: 0 }, closeSamples: [] };
    const live = liveStatus.get(repo) ?? { ready: 0, running: 0, parked: 0 };
    const prSpins = spins.get(repo) ?? new Map<string, Set<string>>();
    const merge = mergeFacts.get(repo) ?? { count: 0, ttm: [] };
    const runs = new Set<string>();
    if (jobs) for (const c of conflicts.values()) {
      if (c.repo !== repo) continue;
      for (const id of c.workedIds) runs.add(id);
    }
    repos.push({
      repo,
      conflictsOpen: a.open,
      conflictsTriaged: a.triaged,
      conflictsClosed: a.closed,
      triageToCloseS: a.closeSamples.length ? latency(a.closeSamples) : null,
      conflictsUntracked: a.untracked,
      coverage: queueReadable ? { ...a.cover } : null,
      rebase: {
        ready: live.ready, running: live.running, parked: live.parked,
        spins: [...prSpins.values()].reduce((n, set) => n + set.size, 0),
        runs: runs.size,
        repeatPrs: [...prSpins.values()].filter(set => set.size > 1).length,
      },
      merges: { count: merge.count, perHour: merge.count / hours, medianTtmS: median(merge.ttm) },
    });
  }
  repos.sort((a, b) => a.repo.localeCompare(b.repo));

  const pooledClose = repos.flatMap(r => (acc.get(r.repo)?.closeSamples ?? []));
  const pooledTtm = [...mergeFacts.values()].flatMap(m => m.ttm);
  const sum = (pick: (r: MergeCockpitRepo) => number) => repos.reduce((n, r) => n + pick(r), 0);
  return {
    schema: MERGE_COCKPIT_SCHEMA, v: 1, generatedAt: new Date(now).toISOString(), hours,
    known: Object.values(input.sources).some(s => s === 'healthy'),
    sources: input.sources,
    jobsClipped: input.jobsClipped,
    repos,
    totals: {
      conflictsOpen: sum(r => r.conflictsOpen),
      conflictsTriaged: sum(r => r.conflictsTriaged),
      conflictsClosed: sum(r => r.conflictsClosed),
      triageToCloseS: pooledClose.length ? latency(pooledClose) : null,
      rebase: {
        ready: sum(r => r.rebase.ready), running: sum(r => r.rebase.running), parked: sum(r => r.rebase.parked),
        spins: sum(r => r.rebase.spins), runs: sum(r => r.rebase.runs), repeatPrs: sum(r => r.rebase.repeatPrs),
      },
      merges: { count: sum(r => r.merges.count), perHour: sum(r => r.merges.count) / hours, medianTtmS: median(pooledTtm) },
    },
  };
}

/** Tail read with a clipped flag, same descriptor-bound shape as runs-dir-state.read. */
async function readTail(path: string, max: number): Promise<{ state: SourceHealth; text: string; clipped: boolean }> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile()) return { state: 'degraded', text: '', clipped: false };
    const start = Math.max(0, info.size - max);
    const buf = Buffer.alloc(Math.min(info.size, max));
    let len = 0;
    while (len < buf.length) {
      const { bytesRead } = await file.read(buf, len, buf.length - len, start + len);
      if (!bytesRead) break;
      len += bytesRead;
    }
    let text = buf.subarray(0, len).toString('utf8');
    if (start > 0) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
    return { state: 'healthy', text, clipped: start > 0 };
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'degraded', text: '', clipped: false };
  } finally { await file?.close().catch(() => undefined); }
}

/** Every readable `*.queuegen-state.json` under queue/ (bounded count and bytes). */
async function readQueuegenStates(queueDir: string): Promise<{ state: SourceHealth; texts: string[] }> {
  let names: string[];
  try {
    names = (await readdir(queueDir, { withFileTypes: true }))
      .filter(e => e.isFile() && e.name.endsWith('.queuegen-state.json') && e.name.length <= 200)
      .map(e => e.name).sort().slice(0, MAX_STATE_FILES);
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'degraded', texts: [] };
  }
  if (names.length === 0) return { state: 'missing', texts: [] };
  const texts: string[] = [];
  let state: SourceHealth = 'healthy';
  for (const name of names) {
    const read = await readSource(join(queueDir, name), MAX_STATE_BYTES, false);
    if (read.state !== 'healthy') { state = 'degraded'; continue; }
    texts.push(read.text);
  }
  return { state: texts.length === 0 ? 'degraded' : state, texts };
}

/** Bounded, read-only projection of the runs dir into a cockpit report. Never throws. */
export async function readMergeCockpit(opts: { runsDir?: string; hours?: number; now?: number } = {}): Promise<MergeCockpitReport> {
  const root = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  const queueDir = join(root, 'queue');
  const [ready, claimed, states, jobs, closes, events] = await Promise.all([
    readSource(join(queueDir, 'ready.tsv'), MAX_TSV_BYTES, false),
    readSource(join(queueDir, 'claimed.tsv'), MAX_TSV_BYTES, false),
    readQueuegenStates(queueDir),
    readTail(join(root, 'metrics', 'jobs.jsonl'), MAX_JOBS_TAIL),
    readTail(join(queueDir, 'landed-closes.jsonl'), MAX_LEDGER_TAIL),
    readTail(join(root, 'metrics', 'merge-events.jsonl'), MAX_LEDGER_TAIL),
  ]);
  return buildMergeCockpit({
    readyTsv: ready.state === 'healthy' ? ready.text : null,
    claimedTsv: claimed.state === 'healthy' ? claimed.text : null,
    queuegenStates: states.texts,
    jobsJsonl: jobs.state === 'healthy' ? jobs.text : null,
    jobsClipped: jobs.clipped,
    landedClosesJsonl: closes.state === 'healthy' ? closes.text : null,
    mergeEventsJsonl: events.state === 'healthy' ? events.text : null,
    sources: {
      ready: ready.state, claimed: claimed.state, queuegenState: states.state,
      jobs: jobs.state, landedCloses: closes.state, mergeEvents: events.state,
    },
    hours: opts.hours,
    now: opts.now,
  });
}
