/**
 * Real-state readers for the status digest. Reuses the existing readers (runs
 * dir lane state, merge truth, release facts, NEEDS-MASON, MASON-INBOX); any
 * reader that throws or reports itself unavailable becomes an "unknown" fact.
 */
import { join } from 'node:path';
import { readInstalledBundleVersion, versionNewer } from '../app-update-status.js';
import { readPeerLedger, type PeerLedgerReport } from '../agentnet/peer-ledger.js';
import { gatherBriefFacts, type BriefFacts } from '../comms/leader-brief.js';
import { inspectBusWorkClaims, type BusWorkClaimsInspection } from '../fleet/bus-work-claims.js';
import { readNeedsMason } from '../fleet/needs-mason-resolve.js';
import { readFleetRunsDirState, type FleetRunsDirState } from '../fleet/runs-dir-state.js';
import { readInboxEntries, type InboxEntry } from '../fleet/mason-inbox.js';
import { defaultReleasePublicReader, verifyLatestWorkbenchRelease } from '../release-public-facts.js';
import { readBlocker, type DigestBlocker } from '../fleet/digest-blocker.js';
import { readMergeLatency, type MergeLatencyReport } from '../fleet/merge-latency.js';
import { readDiskLowLine } from '../fleet/host-disk.js';
import { DIGEST_GAP_MINUTES, readFleetGaps } from '../fleet/sleep-gaps.js';
import { readNodeResults, type NodeResultsSummary } from '../drive/nodes/results-read.js';
import type { Fact, StatusDigestInput, StatusDigestPeers, StatusDigestWorkClaims } from './status-digest.js';

export interface StatusDigestSources {
  installedVersion: () => string | null;
  /** Newest published release with its desktop asset; throws when unreadable. */
  publishedVersion: (nowMs: number) => Promise<string>;
  mergeFacts: (sinceMs: number, nowMs: number) => Promise<Pick<BriefFacts, 'shipped' | 'mergeCountUnavailable'>>;
  /** True open-to-merge time over the last 24h from the job metrics file under the runs dir. Override with undefined to drop the line. */
  mergeLatency?: (runsDir: string, nowMs: number) => Promise<MergeLatencyReport>;
  runsState: (runsDir: string, nowMs: number) => Promise<Pick<FleetRunsDirState, 'lanes' | 'sources' | 'runsDirPresent'>>;
  needs: (runsDir: string) => { status: string; items: Array<{ text: string }> };
  inbox: (runsDir: string) => Promise<{ sourceState: string; entries: InboxEntry[] }>;
  /** Read-only bus claims table snapshot; gather counts it against nowMs. Override with undefined to drop the claims line. */
  workClaims?: (nowMs: number) => BusWorkClaimsInspection;
  /** Read-only peer bus ledger; a throw becomes an unknown Peers line. */
  peers?: (nowMs: number) => PeerLedgerReport;
  /** Read-only node runner results on this computer; a throw becomes an unknown Node runs line. */
  nodeRuns?: (nowMs: number) => NodeResultsSummary;
  /** The one plain line for the longest gap over 30 minutes that ended in the last 6 hours and left work waiting; null when none. */
  gapLine?: (runsDir: string, nowMs: number) => Promise<string | null>;
  /** The `disk_low` line from recorded free-disk samples when under 24 hours remain before the lane freeze line; null when fine or unknown. */
  diskLine?: (runsDir: string, nowMs: number) => Promise<string | null>;
  /** The single biggest cost in the last hour (asleep, host load, empty queue, drained pool, low disk); lanes are the ones the digest already read. */
  /** The `supply_low` line when a pool at risk of waste has under an hour of work queued; null when none or unknown. */
  supplyLine?: (runsDir: string, nowMs: number) => Promise<string | null>;
  /** Worst judged source yield, or null for unknown/low sample. */
  yieldLine?: (runsDir: string, nowMs: number) => Promise<string | null>;
  /** The top `pools.waste.v1` alert as one line; also raises the Asks card when the fix needs Mason. Null when none. */
  wasteLine?: (runsDir: string, nowMs: number) => Promise<string | null>;
  /** The `Not live yet` line from `fleet.drift.v1` when merged fleet files are not installed; null when all live or unreadable. */
  notLiveLine?: (runsDir: string, nowMs: number) => Promise<string | null>;
  blocker?: (runsDir: string, nowMs: number, lanes: Array<{ lane: string; running: number; target: number; held: boolean }> | null) => Promise<DigestBlocker>;
}

const HOUR = 3_600_000;
const NEEDS_READER_UNAVAILABLE = 'NEEDS-MASON.md could not be read';
/** The hard limits: secrets, money, outside sends, data destruction. Everything else is left out. */
const HARD_LIMIT = /\b(?:secrets?|tokens?|api[- ]?keys?|credentials?|passwords?|2fa|mfa|payments?|billing|invoice|purchase|spend|pay|refund|wire|outside send|external send|send (?:an? )?(?:email|message|dm)|publicly|announce|delete|destroy|wipe|purge|force[- ]push|drop table|data loss)\b|\$\d/i;
export const isHardLimitAsk = (text: string): boolean => HARD_LIMIT.test(text);

const defaults: StatusDigestSources = {
  installedVersion: readInstalledBundleVersion,
  publishedVersion: async nowMs => {
    const release = await verifyLatestWorkbenchRelease(defaultReleasePublicReader(), nowMs, AbortSignal.timeout(20_000));
    if (!release.macDownloadUrl) throw new Error('newest published release has no desktop asset');
    return release.version;
  },
  mergeFacts: (sinceMs, nowMs) => gatherBriefFacts(sinceMs, nowMs),
  mergeLatency: (runsDir, nowMs) => readMergeLatency({ metricsPath: join(runsDir, 'metrics', 'jobs.jsonl'), hours: 24, by: 'lane', now: nowMs }),
  runsState: (runsDir, nowMs) => readFleetRunsDirState({ runsDir, now: () => nowMs }),
  needs: runsDir => readNeedsMason({ runsDir }),
  inbox: runsDir => readInboxEntries({ runsDir, limit: 200 }),
  workClaims: () => inspectBusWorkClaims(),
  peers: nowMs => readPeerLedger({ now: () => nowMs }),
  nodeRuns: nowMs => readNodeResults({ nowMs }),
  gapLine: async (runsDir, nowMs) => {
    const report = await readFleetGaps({ runsDir, now: nowMs, sinceMs: 6 * HOUR, minMinutes: DIGEST_GAP_MINUTES + 1, claudeLeftPct: null });
    const worst = report.gaps.filter(g => g.lostWork !== false).sort((a, b) => b.minutes - a.minutes)[0];
    return worst?.line ?? null;
  },
  diskLine: readDiskLowLine,
  supplyLine: async (runsDir, nowMs) => {
    const { readQueueSupply, supplyLowLine } = await import('../fleet/queue-supply.js');
    return supplyLowLine(await readQueueSupply({ runsDir, now: () => nowMs }));
  },
  wasteLine: async (runsDir, nowMs) => {
    const { readPoolsWaste, wasteDigestLine } = await import('../fleet/pools-waste.js');
    const waste = await readPoolsWaste({ runsDir, now: () => nowMs });
    await (await import('../fleet/asks-sync.js')).syncAsks({ runsDir, now: () => nowMs }).catch(() => null);
    return wasteDigestLine(waste);
  },
  notLiveLine: async runsDir => {
    const { findFleetRepo, fleetDrift, notLiveLine } = await import('../fleet/drift.js');
    const { access } = await import('node:fs/promises');
    const bin = process.env.ASHLR_RUNS_BIN || join(runsDir, 'bin');
    const repo = await findFleetRepo();
    // No runtime directory means this is not a fleet host: nothing to compare, so no line.
    return repo && await access(bin).then(() => true, () => false) ? notLiveLine(await fleetDrift(repo, bin)) : null;
  },
  yieldLine: async (runsDir, nowMs) => {
    const { readYieldBy, yieldDigestLine } = await import('../fleet/yield-by.js');
    return yieldDigestLine(await readYieldBy({ by: 'source', now: nowMs, metrics: join(runsDir, 'metrics', 'jobs.jsonl'), queue: join(runsDir, 'queue', 'router-queue.md') }));
  },
  blocker: readBlocker,
};

function gatherNodeRuns(read: ((nowMs: number) => NodeResultsSummary) | undefined, nowMs: number): NodeResultsSummary | undefined {
  if (read === undefined) return undefined;
  try { return read(nowMs); } catch {
    return { v: 1, authority: 'none', status: 'unavailable', asOf: new Date(nowMs).toISOString(), windowMs: 0, inWindow: 0, newest: null, unreadable: 0, truncated: false, reason: 'reader-failed' };
  }
}

/** Maps the peer ledger to the digest shape; tightest is the first pair with no budget left (the ledger sorts by remaining). */
export function summarizePeerLedger(report: PeerLedgerReport): StatusDigestPeers {
  const limited = report.pairs.filter(pair => pair.remaining === 0);
  const first = limited[0];
  return {
    status: report.status,
    rateLimited: limited.length,
    tightest: first ? `${first.fromAgent} → ${first.target}` : null,
    nearCap: report.origins.filter(origin => origin.nearCap).length,
    ...(report.reason ? { reason: report.reason } : {}),
  };
}

function gatherPeers(read: ((nowMs: number) => PeerLedgerReport) | undefined, nowMs: number): StatusDigestPeers | undefined {
  if (read === undefined) return undefined;
  try { return summarizePeerLedger(read(nowMs)); } catch {
    return { status: 'unavailable', reason: 'peer ledger reader failed', rateLimited: 0, tightest: null, nearCap: 0 };
  }
}

/** Counts the snapshot at nowMs: 'missing' → null, 'unavailable' → throw (the caller's fact() keeps the reason). */
function countWorkClaims(inspection: BusWorkClaimsInspection, nowMs: number): StatusDigestWorkClaims | null {
  if (inspection.source === 'unavailable') throw new Error('unavailable');
  if (inspection.source === 'missing') return null;
  const live = inspection.claims.filter(claim => claim.completedAt === null && claim.leaseUntil > nowMs);
  const expired = inspection.claims.filter(claim => claim.completedAt === null && claim.leaseUntil <= nowMs).length;
  return {
    live: live.length,
    completed: inspection.claims.length - live.length - expired,
    expired,
    owners: new Set(live.map(claim => claim.owner)).size,
    asOfMs: nowMs,
  };
}

const ET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** Inbox headings carry "YYYY-MM-DD HH:MM" Eastern wall time. */
export function inboxAtMs(at: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(at)) return null;
  for (const offsetHours of [4, 5]) {
    const ms = Date.parse(`${at.replace(' ', 'T')}:00Z`) + offsetHours * HOUR;
    const p = Object.fromEntries(ET.formatToParts(ms).map(part => [part.type, part.value]));
    if (`${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` === at) return ms;
  }
  return null;
}

async function fact<T>(read: () => Promise<T> | T, reason: string): Promise<Fact<T>> {
  try { return { ok: true, value: await read() }; } catch { return { ok: false, reason }; }
}

export async function gatherStatusDigestInput(runsDir: string, now: Date, overrides: Partial<StatusDigestSources> = {}): Promise<StatusDigestInput> {
  const src = { ...defaults, ...overrides };
  const nowMs = now.getTime();
  const readClaims = src.workClaims;
  const merged = (hours: number): Promise<Fact<number>> => fact(async () => {
    const facts = await src.mergeFacts(nowMs - hours * HOUR, nowMs);
    if (facts.mergeCountUnavailable) throw new Error('unavailable');
    return facts.shipped.filter(item => /^ashlrai\/phantom#\d+/.test(item.text)).length;
  }, 'GitHub merge count unavailable or incomplete');

  const readMergeTime = src.mergeLatency;
  const mergeTime: StatusDigestInput['mergeTime'] = readMergeTime === undefined ? undefined : await fact(async () => {
    const report = await readMergeTime(runsDir, nowMs);
    if (report.metrics !== 'ok' || !report.open_to_merge) throw new Error('unreadable');
    return { medianSeconds: report.open_to_merge.p50_s, known: report.open_to_merge.known, merged: report.merged ?? 0 };
  }, 'job metrics file not readable');
  const [installed, published, hour, day, runs, inbox, workClaims] = await Promise.all([
    fact(() => { const v = src.installedVersion(); if (!v) throw new Error('none'); return v; }, 'installed app version not readable'),
    fact(() => src.publishedVersion(nowMs), 'published release not readable'),
    merged(1), merged(24),
    fact(() => src.runsState(runsDir, nowMs), 'lane state not readable'),
    fact(() => src.inbox(runsDir), 'MASON-INBOX.md not readable'),
    readClaims === undefined ? Promise.resolve(undefined) : fact(() => countWorkClaims(readClaims(nowMs), nowMs), 'bus claims table could not be read'),
  ]);

  const lanes: Fact<StatusDigestInput['lanes'] extends Fact<infer L> ? L : never> = !runs.ok ? runs
    : runs.value.sources.status !== 'healthy' ? { ok: false, reason: runs.value.runsDirPresent ? 'queue/status.json missing or invalid' : 'runs dir missing' }
      : { ok: true, value: runs.value.lanes.map(({ lane, running, target, held, heldReason }) => ({ lane, running, target, held, heldReason })) };

  const needsFact = await fact(() => {
    const result = src.needs(runsDir);
    if (result.status !== 'available' && result.status !== 'missing') throw new Error(NEEDS_READER_UNAVAILABLE);
    return result.items.filter(item => isHardLimitAsk(item.text)).length;
  }, NEEDS_READER_UNAVAILABLE);

  let topP0: StatusDigestInput['topP0'];
  if (!inbox.ok) topP0 = inbox;
  else if (inbox.value.sourceState === 'degraded') topP0 = { ok: false, reason: 'MASON-INBOX.md not readable' };
  else {
    // parseInbox returns newest first.
    const entry = inbox.value.entries.find(e => e.priority === 'P0' && e.text.trim());
    const at = entry ? inboxAtMs(entry.at) : null;
    topP0 = { ok: true, value: entry ? { text: entry.text, ageMs: at === null ? null : Math.max(0, nowMs - at) } : null };
  }

  const gap = await fact(() => src.gapLine?.(runsDir, nowMs) ?? null, 'gap check failed');
  const disk = await fact(() => src.diskLine?.(runsDir, nowMs) ?? null, 'disk check failed');
  const yieldFact = await fact(() => src.yieldLine?.(runsDir, nowMs) ?? null, 'yield check failed');
  const supply = await fact(() => src.supplyLine?.(runsDir, nowMs) ?? null, 'supply check failed');
  const waste = await fact(() => src.wasteLine?.(runsDir, nowMs) ?? null, 'waste check failed');
  const notLive = await fact(() => src.notLiveLine?.(runsDir, nowMs) ?? null, 'drift check failed');
  const blocker = await fact(() => src.blocker?.(runsDir, nowMs, lanes.ok ? lanes.value : null) ?? undefined, 'blocker check failed');
  const updatePending = installed.ok && published.ok ? versionNewer(published.value, installed.value) : null;
  return { installedVersion: installed, publishedVersion: published, updatePending, mergesLastHour: hour, mergesLast24h: day, ...(mergeTime ? { mergeTime } : {}), lanes, needsMason: needsFact, topP0, workClaims, peers: gatherPeers(src.peers, nowMs), nodeRuns: gatherNodeRuns(src.nodeRuns, nowMs), ...(gap.ok && gap.value ? { gapLine: gap.value } : {}), ...(disk.ok && disk.value ? { diskLine: disk.value } : {}), ...(supply.ok && supply.value ? { supplyLine: supply.value } : {}), ...(yieldFact.ok && yieldFact.value ? { yieldLine: yieldFact.value } : {}), ...(waste.ok && waste.value ? { wasteLine: waste.value } : {}), ...(notLive.ok && notLive.value ? { notLiveLine: notLive.value } : {}), ...(blocker.ok && blocker.value ? { blocker: blocker.value } : {}) };
}
