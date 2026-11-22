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
import { compactMergeLatency, dispatchTick, objectRow } from './compact-brief-evidence.js';
import { parseLedgerTs } from '../metrics/loop.js';
import { LIVE_JOBS_FILE, type LiveJobsReport } from './live-jobs.js';
import { parseReadyRows } from './ready-row-edit.js';
import { parseStopFile, stopFilePath, stoppedFamilies } from './stop-file.js';
import { readSource } from './runs-parked-queue.js';
import { readHostFamilies } from './host-families.js';
import { mergeLatencyLine } from './git-merge-latency.js';

export const LEADER_COMPACT_FILE = 'queue/leader-brief.json';
const clean = (s: string) => scrubSecrets(s).replace(/\s+/g, ' ').slice(0, 80);
type Counts = { family: string; launches: number; prs: number; merges: number; empty: number };

export async function readCompactBrief(runsDir = runsRoot(), now = Date.now(), hostLoadReader = readHostFamilies) {
  const cache = new Map<string, Promise<string>>();
  const sources: Record<string, { state: string; why: string }> = {};
  const sourceState = (name: string, state: string, why: string) => { sources[name] = { state, why }; };
  const read = (file: string): Promise<string> => {
    if (!cache.has(file)) cache.set(file, (async () => {
      const source = await readSource(file, 1024 * 1024, file.endsWith('/metrics/jobs.jsonl'));
      sourceState(file.startsWith(runsDir + '/') ? file.slice(runsDir.length + 1) : 'stopFile', source.state,
        source.state === 'healthy' ? 'bounded local read' : source.state === 'missing' ? 'file does not exist' : 'unreadable, oversized or unsafe file');
      if (source.state !== 'healthy') throw new Error('Unavailable source');
      return source.text;
    })());
    return cache.get(file)!;
  };
  const quiet = async <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);
  const [snapshot, tail, pace, guardian, liveText, stopText, ready, hostLoad, log, slotsText, prsText] = await Promise.all([
    quiet(readChiefOfStaffSnapshot('auto', { runsDir, now: () => new Date(now), read })),
    readTail(join(runsDir, 'metrics/jobs.jsonl'), 8 * 1024 * 1024),
    quiet(readFleetPace({ runsDir, now: () => now })), quiet(readGuardianGlance(runsDir, now)),
    quiet(read(join(runsDir, LIVE_JOBS_FILE))), stopFilePath() ? quiet(read(stopFilePath()!)) : null,
    quiet(read(join(runsDir, 'queue/ready.tsv'))),
    hostLoadReader(),
    readTail(join(runsDir, 'dispatchd.log'), 256 * 1024),
    quiet(read(join(runsDir, 'queue/slots.json'))), quiet(read(join(runsDir, 'fleet/open-prs.json'))),
  ]);
  for (const [name, state] of Object.entries(snapshot?.sources ?? {})) if (state !== 'unavailable') sourceState(name, state,
    state === 'healthy' ? 'parsed local snapshot' : name === 'queue/status.json' ? 'last_tick missing, invalid or older than 60s'
      : state === 'bounded' ? 'last 1000 ledger rows' : 'invalid or incomplete rows in this source');
  sourceState('ledger', tail === null ? 'missing' : tail.truncated ? 'bounded tail' : 'healthy', tail === null ? 'job ledger unreadable' : 'at most 8 MiB of job ledger');
  sourceState('guardian', guardian?.length ? 'healthy' : 'missing', guardian?.length ? 'local guardian observations' : 'no guardian observations');
  const hasPace = pace?.pools.some(p => p.observedAt || p.usedPct !== null || (p.headroom?.slots ?? 0) > 0);
  sourceState('pace', hasPace ? 'healthy' : 'missing', hasPace ? 'recorded readings, status budget and usage history' : 'no pool budget readings');
  sourceState('stops', stopText === null ? 'unknown' : 'healthy', stopText === null ? 'stop file unavailable' : 'local stop file');
  sourceState('hostLoad', hostLoad.state === 'known' ? 'healthy' : 'unknown', hostLoad.state === 'known' ? 'local process observations' : 'host process readings unavailable');
  const tick = dispatchTick(log?.text ?? '', now);
  sourceState('dispatchd.log', log === null ? 'missing' : Object.keys(tick.running).length ? 'healthy' : 'unknown', log === null ? 'log missing or unreadable' : tick.why);
  const json = (text: string | null, name: string): unknown => {
    try { return JSON.parse(text ?? 'null'); } catch { sourceState(name, 'degraded', 'invalid JSON'); return null; }
  };
  const slotRoot = objectRow(json(slotsText, 'queue/slots.json')), slots = objectRow(slotRoot.lanes ?? slotRoot);
  const latency = await compactMergeLatency(runsDir, tail?.text ?? '', now, json(prsText, 'fleet/open-prs.json'), sources['fleet/open-prs.json']?.state === 'missing');
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
    const slot = objectRow(slots[l.lane]), pause = slot.pause_new_until;
    const pause_new_until = typeof pause === 'number' && Number.isFinite(pause) ? pause : (parseLedgerTs(pause) ?? 0) / 1000 || null;
    const held = slot.held === true || (pause_new_until !== null && pause_new_until > now / 1000) ? true
      : slot.held === false || slot.held === undefined && Object.keys(slot).length ? false : l.held;
    const queuedReady = readyRows?.filter(r => r.lane === l.lane && !r.id.startsWith('PARKED-') && r.id !== 'id').length ?? null;
    return { lane: clean(l.lane), running: tick.running[l.lane] ?? l.running, queued: queuedReady, queuedReady,
      target: l.target, held, pause_new_until, emptyRate: finished.length ? finished.filter(r => r.row.empty === true).length / finished.length : null };
  });
  const hungry = lanes.filter(l => l.held === false && l.running !== null && l.target !== null && l.queuedReady !== null
    && l.running < l.target / 2 && l.queuedReady < l.target - l.running).sort((a, b) => (b.target! - b.running!) - (a.target! - a.running!))[0];
  const headline = hungry ? `${hungry.lane} ${hungry.running}/${hungry.target} running, ${hungry.queuedReady} queued: supply-starved` : 'No measured supply-starved lane';
  let live: LiveJobsReport | null = null;
  try { live = JSON.parse(liveText ?? 'null') as LiveJobsReport | null; } catch { sourceState(LIVE_JOBS_FILE, 'degraded', 'invalid JSON'); }
  const attention = (Array.isArray(live?.jobs) ? live.jobs : []).filter(j => j && typeof j.id === 'string' && typeof j.lane === 'string' && (j.status === 'stuck' || j.status === 'quiet'))
    .sort((a, b) => Number(b.status === 'stuck') - Number(a.status === 'stuck') || (Number(b.elapsed) || 0) - (Number(a.elapsed) || 0))
    .slice(0, 5).map(j => ({ id: clean(j.id), lane: clean(j.lane), status: j.status, elapsed: j.elapsed }));
  const stops = stopText === null ? [] : stoppedFamilies(parseStopFile(stopText), now).filter(s => s.until > now / 1000)
    .map(s => ({ family: clean(s.family), until: s.until }));
  const brief = {
    schema: 'leader.compact-brief.v1', at: new Date(now).toISOString(), headline,
    state: lanes.length || tail || hasPace || guardian?.length ? 'ready' : 'no data', sources,
    windowHours: 2, emptyWindowHours: 24, lanes,
    pools: (pace?.pools ?? []).map(p => ({ pool: clean(p.pool), usedPct: p.usedPct, hoursToReset: p.hoursToReset,
      burnPerHour: p.recentPerHour, safeBurn: p.safeBurnPerHour ?? null, verdict: p.verdict === 'stale' || p.verdict === 'spent' ? p.line ?? p.verdict : p.verdict ?? 'unknown',
      headroom: p.headroom, source: p.source, ageHours: p.ageHours,
      why: p.verdict === 'unknown' ? [p.usedPct === null ? 'usage missing or stale' : '', p.hoursToReset === null || p.hoursToReset <= 0 ? 'reset missing or elapsed' : '', p.recentPerHour === null ? 'burn rate missing' : ''].filter(Boolean).join('; ') : 'usage, reset and burn rate known' })),
    families: [...groups.values()].sort((a, b) => a.prs / Math.max(1, a.launches) - b.prs / Math.max(1, b.launches) || b.launches - a.launches || a.family.localeCompare(b.family)),
    attention, liveAt: typeof live?.generatedAt === 'string' ? clean(live.generatedAt) : null, main: (guardian ?? []).map(g => ({ repo: clean(g.repo), state: g.state, stale: g.stale })),
    medianOpenToMergeSeconds: latency.seconds, mergeLatencySource: latency.source, mergeLatencyWhy: latency.why,
    mergeLatency: latency,
    hostLoad: { ...hostLoad, families: hostLoad.families.slice(0, 5), omitted: hostLoad.omitted + Math.max(0, hostLoad.families.length - 5) },
    stopped: stops, omitted: 0,
  };
  // Drop the lowest-priority rows, explicitly counting omissions, until the entire wire payload fits.
  const lists = [brief.families, brief.stopped, brief.main, brief.pools, brief.lanes, brief.attention];
  while (Buffer.byteLength(JSON.stringify(brief)) >= 8191) {
    const list = lists.find(a => a.length > 1) ?? lists.find(a => a.length);
    if (!list) break;
    list.pop(); brief.omitted++;
  }
  return brief;
}
export type CompactLeaderBrief = Awaited<ReturnType<typeof readCompactBrief>>;
export async function writeCompactBrief(runsDir: string, now = Date.now(), file = join(runsDir, LEADER_COMPACT_FILE)) {
  const brief = await readCompactBrief(runsDir, now);
  await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
  writePrivateFileAtomic(file, JSON.stringify(brief) + '\n');
  return brief;
}
export function compactBriefLines(b: CompactLeaderBrief): string[] {
  const lines = [b.headline, `Leader: ${b.state} (${b.at}); lanes: ${b.lanes.length}; pools: ${b.pools.length}`,
    ...b.lanes.slice(0, 3).map(l => `${l.lane}: ${l.running ?? '?'}/${l.target ?? '?'}, ${l.queued ?? '?'} queued, held ${l.held ?? '?'}, empty ${l.emptyRate === null ? '?' : Math.round(l.emptyRate * 100) + '%'}`),
    ...b.pools.slice(0, 2).map(p => `${p.pool}: ${p.usedPct ?? '?'}%, reset ${p.hoursToReset ?? '?'}h, burn ${p.burnPerHour ?? '?'}/h, safe ${p.safeBurn ?? '?'}/h, ${p.verdict}`),
    ...b.families.slice(0, 2).map(f => `${f.family}: ${f.launches} launches, ${f.prs} PRs, ${f.merges} merges, ${f.empty} empty (2h)`),
    `Quiet/stuck: ${b.attention.map(j => j.id).join(', ') || (b.sources[LIVE_JOBS_FILE]?.state === 'healthy' ? 'none recorded' : 'unknown')}`,
    `Main: ${b.main.map(g => `${g.repo} ${g.state}${g.stale ? ' stale' : ''}`).join(', ') || 'unknown'}`,
    mergeLatencyLine(b.mergeLatency), `Stopped: ${b.sources.stops?.state === 'healthy' ? b.stopped.length : 'unknown'}; omitted: ${b.omitted}`,
    `Sources: ${Object.values(b.sources).filter(s => s.state !== 'healthy').length} missing, degraded or bounded`];
  while (lines.length < 10) lines.push('No further data.');
  return lines;
}
