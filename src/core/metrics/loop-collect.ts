/**
 * I/O half of the self-awareness loop (RQ-BETS-LANE-1). Reads real sources
 * only: the jobs ledger, slots/status/ready under queue/, the cost ledger,
 * GitHub (merged PRs and releases via the local `gh`), the installed bundle's
 * Info.plist, the node inventory and the Dot/Instinct teammate task store.
 * Every reader is injectable; a reader that fails yields a `missing` reason,
 * never a guessed value. Writes are private, atomic and limited to
 * <runs>/metrics/{loop-YYYYMMDD,selection-hints,bets-share}.json and a key
 * merge into <runs>/reports/morning-YYYYMMDD.json.
 */
import { execFile } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { lstat, open, readFile, stat } from 'node:fs/promises';
import { availableParallelism, homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../verse/preferences.js';
import { readConfiguredNodeProfiles } from '../drive/nodes/profiles.js';
import { buildNodesSnapshot, type NodesSnapshot } from '../nodes/view.js';
import { parseReadyRows } from '../fleet/ready-row-edit.js';
import { globalCap } from '../queue/admission.js';
import { betsCounts, betsShare, foldBets, isBetRow, type BetsShare, type BetsShareConfig } from './bets.js';
import {
  dayStamp, feedbackLoop, ideaToMerged, isMissing, jobTimelines, laneRows, LOOP_SCHEMA, mergedToInstalled, mergeMorning,
  missing, morningFields, nodeCapacityRow, selectionHints, slotLanes, throughput,
  type InstalledBundle, type LoopReport, type MergedPr, type Missing, type NodeCapacityRow, type ReleaseRef, type ResourceRow, type SelectionHints,
} from './loop.js';
import { buildLoopStages, LOOP_STAGES_DEFAULT_SINCE_MS, type LoopStagesReport } from './loop-stages.js';

const execFileAsync = promisify(execFile);
export const LOOP_REPO = 'ashlrai/phantom';
const JOBS_TAIL_BYTES = 16 * 1024 * 1024;
const SMALL_BYTES = 2 * 1024 * 1024;
const INFO_PLIST = '/Applications/Phantom.app/Contents/Info.plist';

export function runsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ASHLR_RUNS_DIR;
  return override && isAbsolute(override) ? override : join(homedir(), '.ashlr-runs');
}

/** A bounded tail read: the retained text and whether older bytes were cut at the cap. */
export interface TailRead { text: string; truncated: boolean }

/** Bounded tail read of a regular file (no symlink follow). Drops a leading partial line. Null when unreadable. */
export async function readTail(path: string, maxBytes: number): Promise<TailRead | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) return null;
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const size = (await handle.stat()).size;
      const start = Math.max(0, size - maxBytes);
      const buf = Buffer.alloc(size - start);
      await handle.read(buf, 0, buf.length, start);
      const text = buf.toString('utf8');
      return { text: start > 0 ? text.slice(text.indexOf('\n') + 1) : text, truncated: start > 0 };
    } finally { await handle.close(); }
  } catch { return null; }
}

export interface PeerTask { peer: string; state: string; result?: { status: string } }

export interface LoopReaders {
  runsDir: string;
  now: () => number;
  readText: (path: string, maxBytes: number) => Promise<TailRead | null>;
  /** `gh` stdout, or null on any failure. */
  gh: (args: string[]) => Promise<string | null>;
  installed: () => Promise<InstalledBundle | null>;
  nodes: () => NodesSnapshot | null;
  /** Dot and Instinct tasks, or null when the store is unreadable. */
  peerTasks: () => Promise<PeerTask[] | null>;
  ncpu: () => number;
}

const ghDefault = async (args: string[]): Promise<string | null> => {
  try { return (await execFileAsync('gh', args, { timeout: 30_000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' })).stdout; } catch { return null; }
};

/** Installed bundle version and install time (Info.plist mtime). Read-only: no signature or running-version check. */
const installedDefault = async (): Promise<InstalledBundle | null> => {
  if (process.platform !== 'darwin' || !existsSync(INFO_PLIST)) return null;
  try {
    const { stdout } = await execFileAsync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', INFO_PLIST], { timeout: 5000, maxBuffer: 128 * 1024, encoding: 'utf8' });
    const row = JSON.parse(stdout) as Record<string, unknown>;
    if (row.CFBundleIdentifier !== 'ai.ashlr.desktop' || typeof row.CFBundleShortVersionString !== 'string' || !/^\d+\.\d+\.\d+$/.test(row.CFBundleShortVersionString)) return null;
    return { version: row.CFBundleShortVersionString, installedAt: (await stat(INFO_PLIST)).mtimeMs };
  } catch { return null; }
};

export function defaultLoopReaders(env: NodeJS.ProcessEnv = process.env): LoopReaders {
  return {
    runsDir: runsRoot(env), now: Date.now,
    readText: readTail, gh: ghDefault, installed: installedDefault,
    nodes: () => { try { return buildNodesSnapshot({ profiles: readConfiguredNodeProfiles() }); } catch { return null; } },
    peerTasks: async () => {
      try {
        const { listTeammateTasks } = await import('../comms/imessage-teammate-tasks.js');
        return listTeammateTasks().tasks as PeerTask[];
      } catch { return null; }
    },
    ncpu: availableParallelism,
  };
}

const json = (text: string | null): unknown => { if (text === null) return null; try { return JSON.parse(text); } catch { return null; } };
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Latest cost-per-merged-PR reading from growth-cost-hourly.jsonl within 24h (the existing spend feed). */
export function latestCost(text: string | null, now: number): LoopReport['cost_per_merged_pr'] {
  if (text === null) return missing('metrics/growth-cost-hourly.jsonl unreadable or absent: no spend reader output');
  let best: { at: number; usd: number } | null = null;
  for (const line of text.split(/\r?\n/)) {
    const row = json(line.trim() || null);
    if (!isObj(row)) continue;
    const stamp = [row.t, row.ts, row.at, row.hour, row.time].find(v => typeof v === 'string' || typeof v === 'number');
    const at = typeof stamp === 'number' ? (stamp < 1e12 ? stamp * 1000 : stamp) : typeof stamp === 'string' ? Date.parse(stamp) : NaN;
    const usd = row.costPerMergedPrUsd;
    if (!Number.isFinite(at) || at > now || at < now - 24 * 3_600_000 || typeof usd !== 'number' || !Number.isFinite(usd) || usd < 0) continue;
    if (!best || at >= best.at) best = { at, usd };
  }
  return best ? { usd: Math.round(best.usd * 100) / 100, at: new Date(best.at).toISOString(), source: 'metrics/growth-cost-hourly.jsonl' }
    : missing('no costPerMergedPrUsd reading in metrics/growth-cost-hourly.jsonl within 24h');
}

/** Non-draft, non-prerelease releases from `gh api repos/<repo>/releases`. */
export function parseReleases(text: string | null): ReleaseRef[] | null {
  const rows = json(text);
  if (!Array.isArray(rows)) return null;
  return rows.filter(isObj).filter(r => r.draft !== true && r.prerelease !== true && typeof r.tag_name === 'string')
    .map(r => ({ tag: r.tag_name as string, createdAt: Date.parse(String(r.created_at)) })).filter(r => Number.isFinite(r.createdAt));
}

export function parseMergedPrs(text: string | null): MergedPr[] | null {
  const rows = json(text);
  if (!Array.isArray(rows)) return null;
  return rows.filter(isObj).map(r => ({ number: Number(r.number), mergedAt: Date.parse(String(r.mergedAt)) }))
    .filter(r => Number.isSafeInteger(r.number) && Number.isFinite(r.mergedAt));
}

export interface LoopReleases { releases: ReleaseRef[] | null; reason: string | null }

/** One release read with a plain reason when it fails. Shared by `phm metrics loop` and the desktop card so both show the same numbers. */
export async function readLoopReleases(gh: LoopReaders['gh']): Promise<LoopReleases> {
  const text = await gh(['api', `repos/${LOOP_REPO}/releases?per_page=40`]);
  if (text === null) return { releases: null, reason: 'GitHub releases could not be read (gh is missing or not signed in)' };
  const releases = parseReleases(text);
  if (!releases) return { releases: null, reason: 'GitHub returned releases in a shape this report does not know' };
  return releases.length ? { releases, reason: null } : { releases: null, reason: 'GitHub has no releases for this repo yet' };
}

export const LOOP_RELEASES_FRESH_MS = 10 * 60_000;
const FAILED_RETRY_MS = 60_000;
const releaseCache = new WeakMap<LoopReaders['gh'], { at: number; read: LoopReleases }>();

/** `readLoopReleases` kept for 10 minutes per reader (a failure for 1 minute, so a flaky read is retried soon but not on every poll). */
export async function readLoopReleasesCached(gh: LoopReaders['gh'], now: number): Promise<LoopReleases> {
  const hit = releaseCache.get(gh);
  if (hit && now >= hit.at && now - hit.at < (hit.read.releases ? LOOP_RELEASES_FRESH_MS : FAILED_RETRY_MS)) return hit.read;
  const read = await readLoopReleases(gh);
  releaseCache.set(gh, { at: now, read });
  return read;
}

export interface LoopCollection { report: LoopReport; share: BetsShare; hints: SelectionHints; jobsText: string | null; stages: LoopStagesReport }

export async function collectLoop(readers: LoopReaders, shareConfig: BetsShareConfig = {}, sinceMs = LOOP_STAGES_DEFAULT_SINCE_MS): Promise<LoopCollection> {
  const now = readers.now();
  const root = readers.runsDir;
  const path = (...p: string[]) => join(root, ...p);
  const sources: Record<string, string> = {};
  const [jobsRead, slotsRead, statusRead, readyRead, concurrencyRead, costRead, betsRead] = await Promise.all([
    readers.readText(path('metrics', 'jobs.jsonl'), JOBS_TAIL_BYTES),
    readers.readText(path('queue', 'slots.json'), SMALL_BYTES),
    readers.readText(path('queue', 'status.json'), SMALL_BYTES),
    readers.readText(path('queue', 'ready.tsv'), SMALL_BYTES),
    readers.readText(path('queue', 'concurrency.json'), SMALL_BYTES),
    readers.readText(path('metrics', 'growth-cost-hourly.jsonl'), SMALL_BYTES),
    readers.readText(path('metrics', 'bets.jsonl'), SMALL_BYTES),
  ]);
  const jobsText = jobsRead?.text ?? null, slotsText = slotsRead?.text ?? null, statusText = statusRead?.text ?? null;
  const readyText = readyRead?.text ?? null, concurrencyText = concurrencyRead?.text ?? null;
  const costText = costRead?.text ?? null, betsText = betsRead?.text ?? null;
  const mark = (name: string, ok: boolean) => { sources[name] = ok ? 'read' : 'missing'; };
  mark('metrics/jobs.jsonl', jobsText !== null); mark('queue/slots.json', slotsText !== null); mark('queue/status.json', statusText !== null);
  mark('queue/ready.tsv', readyText !== null); mark('metrics/growth-cost-hourly.jsonl', costText !== null); mark('metrics/bets.jsonl', betsText !== null);
  // A bounded tail that hit its cap folds only the newest bytes: name each cut source so counts read as lower bounds, never silent.
  const truncatedSources = ([
    ['metrics/jobs.jsonl', jobsRead], ['queue/slots.json', slotsRead], ['queue/status.json', statusRead],
    ['queue/ready.tsv', readyRead], ['queue/concurrency.json', concurrencyRead],
    ['metrics/growth-cost-hourly.jsonl', costRead], ['metrics/bets.jsonl', betsRead],
  ] as const).filter(([, read]) => read?.truncated === true).map(([name]) => name);

  const jobs = jobTimelines(jobsText, now);
  const rawSlots = json(slotsText);
  const slots = slotLanes(rawSlots);
  const status = json(statusText);
  const statusLanes = isObj(status) && isObj(status.lanes) ? status.lanes : null;
  const running: Record<string, number> | null = statusLanes ? Object.fromEntries(Object.entries(statusLanes)
    .map(([lane, r]) => [lane, isObj(r) && Number.isSafeInteger(r.running) ? r.running as number : 0])) : null;

  // GitHub: releases first, so the merged-PR search is bounded by the release before the installed one.
  const installed = await readers.installed();
  sources['Info.plist'] = installed ? 'read' : 'missing';
  const { releases, reason: releasesReason } = await readLoopReleases(readers.gh);
  sources['gh releases'] = releases ? 'read' : 'missing';
  let merged: MergedPr[] | null = null;
  if (releases) {
    const since = new Date(Math.min(...releases.map(r => r.createdAt))).toISOString().slice(0, 10);
    merged = parseMergedPrs(await readers.gh(['pr', 'list', '--repo', LOOP_REPO, '--state', 'merged', '--limit', '1000', '--search', `merged:>=${since}`, '--json', 'number,mergedAt']));
  }
  sources['gh merged prs'] = merged ? 'read' : 'missing';
  const m2i = merged === null ? missing('gh merged-PR or release read failed') : releases ? mergedToInstalled(merged, releases, installed) : missing('gh releases unreadable');

  // Capacity: the local dispatcher cap and live running, then every inventory node.
  const capacity: NodeCapacityRow[] = [];
  const concurrency = json(concurrencyText);
  const adaptive = isObj(concurrency) && concurrency.schema === 'dispatchd.concurrency.v1' && Number.isSafeInteger(concurrency.cap) ? concurrency.cap as number : null;
  const localCap = isObj(rawSlots) ? globalCap(isObj(rawSlots.lanes) ? { ...rawSlots.lanes, ...(rawSlots.hard_cap !== undefined ? { hard_cap: rawSlots.hard_cap } : {}) } : rawSlots, readers.ncpu(), adaptive).cap : null;
  const localRunning = running ? Object.values(running).reduce((a, b) => a + b, 0) : null;
  capacity.push(nodeCapacityRow('local', 'local', 'dispatcher', localCap, localRunning, { max: 'queue/slots.json unreadable', live: 'queue/status.json unreadable' }));
  const nodes = readers.nodes();
  sources['nodes inventory'] = nodes && !nodes.error ? 'read' : 'missing';
  for (const n of nodes?.nodes ?? []) {
    const live = n.status === 'ready' || n.status === 'stale' ? n.liveJobs.length : null;
    capacity.push(nodeCapacityRow(n.id, n.source, n.status, n.profile?.maxCliAgents ?? null, live,
      { max: 'node has no declared profile', live: `node ${n.status}: no live heartbeat` }));
  }

  const peers = await readers.peerTasks();
  sources['teammate tasks (Dot, Instinct)'] = peers ? 'read' : 'missing';
  const lanes = laneRows(jobs, slots, running, now);
  const resources: ResourceRow[] = [
    ...lanes.map(l => ({ resource: l.lane, kind: 'lane' as const, measured: !isMissing(l.merged_per_lane_hour),
      detail: { in_slots: l.inSlots, target: l.target, held: l.held, running: l.running, merged_6h: l.merged_6h, lane_hours_6h: l.lane_hours_6h } })),
    ...capacity.map(c => ({ resource: c.node, kind: 'node' as const, measured: !isMissing(c.spare), detail: isMissing(c.spare) ? c.spare : { max: c.max, live: c.live, spare: c.spare } })),
    ...(['dot', 'instinct'] as const).map(peer => {
      if (!peers) return { resource: peer, kind: 'peer' as const, measured: false, detail: missing('teammate task store unreadable') };
      const mine = peers.filter(t => t.peer === peer);
      return { resource: peer, kind: 'peer' as const, measured: true, detail: {
        tasks: mine.length, pending: mine.filter(t => ['queued', 'sending', 'pending'].includes(t.state)).length,
        done: mine.filter(t => t.result?.status === 'DONE').length, failed: mine.filter(t => t.result && t.result.status !== 'DONE').length,
      } };
    }),
  ];

  const folded = betsText === null ? null : foldBets(betsText);
  const report: LoopReport = {
    schema: LOOP_SCHEMA, at: new Date(now).toISOString(), sources, truncated_sources: truncatedSources,
    throughput: jobsText === null ? missing('metrics/jobs.jsonl unreadable') : throughput(jobs, now),
    idea_to_merged_minutes: jobsText === null ? missing('metrics/jobs.jsonl unreadable') : ideaToMerged(jobs, now),
    merged_to_installed_minutes: m2i,
    feedback_loop_minutes: feedbackLoop(jobs, m2i, LOOP_REPO, installed?.installedAt ?? null),
    cost_per_merged_pr: latestCost(costText, now),
    lanes, capacity_per_node: capacity, resources,
    bets: folded ? { ...betsCounts(folded.bets), active: folded.bets.filter(b => b.status === 'launched').map(b => b.id) }
      : { launched: 0, kept: 0, killed: 0, active: [] },
  };
  const readyBetRows = readyText === null ? null : parseReadyRows(readyText).filter(isBetRow).length;
  const free = localCap !== null && localRunning !== null ? Math.max(0, localCap - localRunning) : null;
  const share = betsShare({ freeSlots: free, readyBetRows }, shareConfig);
  const stages = buildLoopStages(jobsText, releases, now, sinceMs, releasesReason, jobsRead?.truncated);
  return { report, share, hints: selectionHints(report, share, stages), jobsText, stages };
}

export interface LoopWrites { loop: string; hints: string; share: string; morning: string | Missing }

/** Persist the loop artifacts. The morning file is merged key-wise; a corrupt one is left untouched and reported. */
export async function writeLoop(runsDir: string, c: LoopCollection, at: Date): Promise<LoopWrites> {
  const metrics = join(runsDir, 'metrics'), reports = join(runsDir, 'reports');
  ensurePrivateDirectory(metrics);
  const day = dayStamp(at);
  const loop = join(metrics, `loop-${day}.json`), hints = join(metrics, 'selection-hints.json'), share = join(metrics, 'bets-share.json');
  writePrivateFileAtomic(loop, `${JSON.stringify(c.report, null, 2)}\n`);
  writePrivateFileAtomic(hints, `${JSON.stringify(c.hints, null, 2)}\n`);
  writePrivateFileAtomic(share, `${JSON.stringify({ ...c.share, at: c.report.at }, null, 2)}\n`);
  ensurePrivateDirectory(reports);
  const morningPath = join(reports, `morning-${day}.json`);
  let existing: unknown = undefined;
  try { existing = JSON.parse(await readFile(morningPath, 'utf8')); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { loop, hints, share, morning: missing('existing morning file unparsable: left untouched') };
  }
  const merged = mergeMorning(existing, morningFields(c.report));
  if (!merged) return { loop, hints, share, morning: missing('existing morning file is not a JSON object: left untouched') };
  writePrivateFileAtomic(morningPath, `${JSON.stringify(merged, null, 2)}\n`);
  return { loop, hints, share, morning: morningPath };
}
