/** Bounded, local-only first read for a leader pass. Unknown readings stay null. */
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { readChiefOfStaffSnapshot } from '../../cli/fleet-chief-of-staff.js';
import { runsRoot, readTail } from '../metrics/loop-collect.js';
import { scrubSecrets } from '../util/scrub.js';
import { writePrivateFileAtomic } from '../verse/preferences.js';
import { ledgerRows, ledgerEventName, ledgerPhase, ledgerPrUrl, ledgerStateTokens } from './empty-cause.js';
import { collapseFamily } from './family-yield.js';
import { readGuardianGlance } from './guardian-glance.js';
import { readFleetPace } from './pace-verdict.js';
import { buildMergeLatency } from './merge-latency.js';
import { LIVE_JOBS_FILE, type LiveJobsReport } from './live-jobs.js';
import { parseReadyRows } from './ready-row-edit.js';
import { parseStopFile, stopFilePath, stoppedFamilies } from './stop-file.js';
import { readSource } from './runs-parked-queue.js';
import { readHostFamilies } from './host-families.js';

export const LEADER_COMPACT_FILE = 'queue/leader-brief.json';
const clean = (s: string) => scrubSecrets(s).replace(/\s+/g, ' ').slice(0, 80);
type Counts = { family: string; launches: number; prs: number; merges: number; empty: number };

export async function readCompactBrief(runsDir = runsRoot(), now = Date.now(), hostLoadReader = readHostFamilies) {
  const cache = new Map<string, Promise<string>>();
  const sources: Record<string, string> = {};
  const read = (file: string): Promise<string> => {
    if (!cache.has(file)) cache.set(file, (async () => {
      const source = await readSource(file, 1024 * 1024, false);
      sources[file.startsWith(runsDir + '/') ? file.slice(runsDir.length + 1) : 'stopFile'] = source.state;
      if (source.state !== 'healthy') throw new Error('Unavailable source');
      return source.text;
    })());
    return cache.get(file)!;
  };
  const quiet = async <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);
  const [snapshot, tail, pace, guardian, liveText, stopText, ready, hostLoad] = await Promise.all([
    quiet(readChiefOfStaffSnapshot('auto', { runsDir, now: () => new Date(now), read })),
    readTail(join(runsDir, 'metrics/jobs.jsonl'), 8 * 1024 * 1024),
    quiet(readFleetPace({ runsDir, now: () => now })), quiet(readGuardianGlance(runsDir, now)),
    quiet(read(join(runsDir, LIVE_JOBS_FILE))), stopFilePath() ? quiet(read(stopFilePath()!)) : null,
    quiet(read(join(runsDir, 'queue/ready.tsv'))),
    hostLoadReader(),
  ]);
  sources.ledger = tail === null ? 'missing' : tail.truncated ? 'bounded tail' : 'healthy';
  sources.guardian = guardian?.length ? 'healthy' : 'missing';
  sources.pace = pace?.pools.length ? 'healthy' : 'missing';
  sources.stops = stopText === null ? 'unknown' : 'healthy';
  sources.hostLoad = hostLoad.state === 'known' ? 'healthy' : 'unknown';
  const rows = ledgerRows(tail?.text ?? '', now, 24).rows.sort((a, b) => a.at - b.at);
  const groups = new Map<string, Counts>(), seen = new Set<string>();
  for (const { row, id, at } of rows.filter(r => r.at >= now - 2 * 3_600_000)) {
    const family = collapseFamily(id)?.family ?? id, event = ledgerEventName(row), phase = ledgerPhase(row);
    const metric = phase === 'MERGED' || event === 'merged' ? 'merges'
      : row.empty === true || ledgerStateTokens(row).includes('EMPTY_DONE') || row.class === 'empty' ? 'empty'
      : event === 'launch' ? 'launches' : event === 'publish' && (row.class === 'pr' || ledgerPrUrl(row)) ? 'prs' : null;
    if (!metric) continue;
    const key = `${metric}:${metric === 'launches' || metric === 'empty' ? `${id}:${at}` : ledgerPrUrl(row) ?? id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const counts = groups.get(family) ?? { family: clean(family), launches: 0, prs: 0, merges: 0, empty: 0 };
    counts[metric]++; groups.set(family, counts);
  }
  const readyRows = ready === null ? null : parseReadyRows(ready);
  const lanes = (snapshot?.snapshot.lanes ?? []).map(l => {
    const finished = [...new Map(rows.filter(r => r.lane === l.lane && ledgerEventName(r.row) === 'finish').map(r => [`${r.id}:${r.at}`, r])).values()].slice(-20);
    return { lane: clean(l.lane), running: l.running, queued: readyRows?.filter(r => r.lane === l.lane).length ?? null,
      target: l.target, held: l.held, emptyRate: finished.length ? finished.filter(r => r.row.empty === true).length / finished.length : null };
  });
  const mergedPrs = [...new Map(ledgerRows(tail?.text ?? '', now, Infinity, true).rows
    .filter(({ row }) => ledgerPhase(row) === 'MERGED' || ledgerEventName(row) === 'merged')
    .flatMap(({ row, at }) => {
      const url = ledgerPrUrl(row), match = url?.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)$/);
      const mergedAt = typeof row.mergedAt === 'string' ? Date.parse(row.mergedAt) : at;
      return match && Number.isFinite(mergedAt) && mergedAt <= now
        ? [{ url: url!, repo: match[1]!, number: Number(match[2]), title: typeof row.title === 'string' ? clean(row.title) : '', at: new Date(mergedAt).toISOString() }] : [];
    }).sort((a, b) => a.at.localeCompare(b.at)).map(pr => [pr.url, pr])).values()]
    .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5);
  let live: LiveJobsReport | null = null;
  try { live = JSON.parse(liveText ?? 'null') as LiveJobsReport | null; } catch { sources[LIVE_JOBS_FILE] = 'degraded'; }
  const attention = (Array.isArray(live?.jobs) ? live.jobs : []).filter(j => j && typeof j.id === 'string' && typeof j.lane === 'string' && (j.status === 'stuck' || j.status === 'quiet'))
    .sort((a, b) => Number(b.status === 'stuck') - Number(a.status === 'stuck') || (Number(b.elapsed) || 0) - (Number(a.elapsed) || 0))
    .slice(0, 5).map(j => ({ id: clean(j.id), lane: clean(j.lane), status: j.status, elapsed: j.elapsed }));
  const stops = stopText === null ? [] : stoppedFamilies(parseStopFile(stopText), now).filter(s => s.until > now / 1000)
    .map(s => ({ family: clean(s.family), until: s.until }));
  const brief = {
    schema: 'leader.compact-brief.v1', at: new Date(now).toISOString(),
    state: lanes.length || tail || pace?.pools.length || guardian?.length ? 'ready' : 'no data', sources,
    windowHours: 2, emptyWindowHours: 24, lanes,
    headline: lanes.length && lanes.every(l => l.running !== null)
      ? `${lanes.reduce((sum, l) => sum + l.running!, 0)} jobs running across ${lanes.length} lanes.` : 'Running job counts are missing.',
    mergedPrs,
    pools: (pace?.pools ?? []).map(p => ({ pool: clean(p.pool), usedPct: p.usedPct, hoursToReset: p.hoursToReset,
      burnPerHour: p.recentPerHour, safeBurn: p.safeBurnPerHour ?? null, verdict: p.verdict ?? 'unknown' })),
    families: [...groups.values()].sort((a, b) => a.prs / Math.max(1, a.launches) - b.prs / Math.max(1, b.launches) || b.launches - a.launches || a.family.localeCompare(b.family)),
    attention, liveAt: typeof live?.generatedAt === 'string' ? clean(live.generatedAt) : null, main: (guardian ?? []).map(g => ({ repo: clean(g.repo), state: g.state, stale: g.stale })),
    medianOpenToMergeSeconds: buildMergeLatency({ ledger: tail?.text ?? null, now, hours: 24, by: 'repo', metricsPath: '' }).open_to_merge?.p50_s ?? null,
    hostLoad: { ...hostLoad, families: hostLoad.families.slice(0, 5), omitted: hostLoad.omitted + Math.max(0, hostLoad.families.length - 5) },
    stopped: stops, omitted: 0,
  };
  // Drop the lowest-priority rows, explicitly counting omissions, until the entire wire payload fits.
  const lists = [brief.families, brief.stopped, brief.main, brief.pools, brief.lanes, brief.attention, brief.mergedPrs];
  while (Buffer.byteLength(JSON.stringify(brief)) >= 8191) {
    const list = lists.find(a => a.length > 1) ?? lists.find(a => a.length);
    if (!list) break;
    list.pop(); brief.omitted++;
  }
  return brief;
}
type GeneratedBrief = Awaited<ReturnType<typeof readCompactBrief>>;
/** Older stored snapshots omit the desktop headline and merge list. */
export type CompactLeaderBrief = Omit<GeneratedBrief, 'headline' | 'mergedPrs'> & Partial<Pick<GeneratedBrief, 'headline' | 'mergedPrs'>>;
export async function writeCompactBrief(runsDir: string, now = Date.now(), file = join(runsDir, LEADER_COMPACT_FILE)) {
  const brief = await readCompactBrief(runsDir, now);
  await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
  writePrivateFileAtomic(file, JSON.stringify(brief) + '\n');
  return brief;
}
export function compactBriefLines(b: CompactLeaderBrief): string[] {
  const lines = [`Leader: ${b.state} (${b.at})`, `Lanes: ${b.lanes.length}; pools: ${b.pools.length}`,
    ...b.lanes.slice(0, 3).map(l => `${l.lane}: ${l.running ?? '?'}/${l.target ?? '?'}, ${l.queued ?? '?'} queued, held ${l.held ?? '?'}, empty ${l.emptyRate === null ? '?' : Math.round(l.emptyRate * 100) + '%'}`),
    ...b.pools.slice(0, 2).map(p => `${p.pool}: ${p.usedPct ?? '?'}%, reset ${p.hoursToReset ?? '?'}h, burn ${p.burnPerHour ?? '?'}/h, safe ${p.safeBurn ?? '?'}/h, ${p.verdict}`),
    ...b.families.slice(0, 2).map(f => `${f.family}: ${f.launches} launches, ${f.prs} PRs, ${f.merges} merges, ${f.empty} empty (2h)`),
    `Quiet/stuck: ${b.attention.map(j => j.id).join(', ') || (b.sources[LIVE_JOBS_FILE] === 'healthy' ? 'none recorded' : 'unknown')}`,
    `Main: ${b.main.map(g => `${g.repo} ${g.state}${g.stale ? ' stale' : ''}`).join(', ') || 'unknown'}`,
    `Median merge (24h): ${b.medianOpenToMergeSeconds ?? '?'}s`, `Stopped: ${b.sources.stops === 'healthy' ? b.stopped.length : 'unknown'}; omitted: ${b.omitted}`,
    `Sources: ${Object.values(b.sources).filter(s => s !== 'healthy').length} missing, degraded or bounded`];
  while (lines.length < 10) lines.push('No further data.');
  return lines;
}
