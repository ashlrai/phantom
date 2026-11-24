import { summarizeAdmission } from './admission-summary.js';
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
import { parseTickCost } from './tick-cost.js';
import { compactMergeLatency, dispatchTick, objectRow } from './compact-brief-evidence.js';
import { parseLedgerTs } from '../metrics/loop.js';
import { LIVE_JOBS_FILE, type LiveJobsSnapshot } from './live-jobs.js';
import { parseReadyRows } from './ready-row-edit.js';
import { parseStopFile, stopFilePath, stoppedFamilies } from './stop-file.js';
import { readSource } from './runs-parked-queue.js';
import { ioWaitLine, readHostFamilies } from './host-families.js';
import { readReleaseBacklog } from '../release/backlog.js';
import { openPrCount } from './open-prs.js';
import { mergeLatencyLine } from './git-merge-latency.js';
import { activeFamilyStops, type BriefFamily } from './family-auto-stop.js';
import { whyIdle } from './why-idle.js';
import { fleetGhosts } from './ghosts.js';

export const LEADER_COMPACT_FILE = 'queue/leader-brief.json';
const clean = (s: string) => scrubSecrets(s).replace(/\s+/g, ' ').slice(0, 80);

/** The brief's two-hour family rollup, shared with self-tick before display truncation. */
export function briefFamilyYield(text: string, now: number): BriefFamily[] {
  const groups = new Map<string, BriefFamily>(), seen = new Set<string>();
  for (const { row, id, at } of ledgerRows(text, now, 2).rows.sort((a, b) => a.at - b.at)) {
    const collapsed = collapseFamily(id), family = collapsed?.family ?? id, event = ledgerEventName(row), phase = ledgerPhase(row);
    const metric = phase === 'MERGED' || event === 'merged' ? 'merges'
      : row.empty === true || ledgerStateTokens(row).includes('EMPTY_DONE') || row.class === 'empty' ? 'empty'
      : event === 'launch' ? 'launches' : event === 'publish' && (row.class === 'pr' || ledgerPrUrl(row)) ? 'prs' : null;
    if (!metric) continue;
    const key = `${metric}:${metric === 'launches' || metric === 'empty' ? `${id}:${at}` : ledgerPrUrl(row) ?? id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const counts = groups.get(family) ?? { family, pattern: collapsed?.pattern ?? `^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, guarded: false, launches: 0, prs: 0, merges: 0, empty: 0 };
    counts.guarded ||= /Q8|FIXUP-|GUARDIAN|RELEASE/i.test(id) || /guardian/i.test(`${row.src ?? ''} ${row.source ?? ''}`);
    counts[metric]++; groups.set(family, counts);
  }
  return [...groups.values()];
}

/** EMPTY finishes in the last 24 hours, ranked by measured token waste. */
export function emptyTokenFamilies(text: string, now: number) {
  const groups = new Map<string, { family: string; tokens: number | null; unknownJobs: number; jobs: number }>();
  const seen = new Set<string>();
  for (const { row, id, at } of ledgerRows(text, now, 24).rows) {
    if (!(row.empty === true || ledgerStateTokens(row).includes('EMPTY_DONE') || row.class === 'empty')) continue;
    const key = `${id}:${at}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const family = clean(collapseFamily(id)?.family ?? id);
    const group = groups.get(family) ?? { family, tokens: null, unknownJobs: 0, jobs: 0 };
    const value = row.tokens_total ?? row.tokens ?? row.total_tokens;
    group.jobs++;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) group.tokens = (group.tokens ?? 0) + value;
    else group.unknownJobs++;
    groups.set(family, group);
  }
  return [...groups.values()].sort((a, b) => (b.tokens ?? -1) - (a.tokens ?? -1) || a.family.localeCompare(b.family));
}

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
  const [snapshot, tail, pace, guardian, liveText, stopText, ready, hostLoad, log, slotsText, prsText, familyStopText, admissionText] = await Promise.all([
    quiet(readChiefOfStaffSnapshot('auto', { runsDir, now: () => new Date(now), read })),
    readTail(join(runsDir, 'metrics/jobs.jsonl'), 8 * 1024 * 1024),
    quiet(readFleetPace({ runsDir, now: () => now })), quiet(readGuardianGlance(runsDir, now)),
    quiet(read(join(runsDir, LIVE_JOBS_FILE))), stopFilePath() ? quiet(read(stopFilePath()!)) : null,
    quiet(read(join(runsDir, 'queue/ready.tsv'))),
    hostLoadReader(),
    readTail(join(runsDir, 'dispatchd.log'), 256 * 1024),
    quiet(read(join(runsDir, 'queue/slots.json'))), quiet(read(join(runsDir, 'fleet/open-prs.json'))),
    quiet(read(join(runsDir, 'queue/family-stop.tsv'))),
    quiet(read(join(runsDir, 'queue/admission-ctl.json'))),
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
  const prs = json(prsText, 'fleet/open-prs.json'), openPrs = openPrCount(prs, now);
  const latency = await compactMergeLatency(runsDir, tail?.text ?? '', now, prs, sources['fleet/open-prs.json']?.state === 'missing');
  const rows = ledgerRows(tail?.text ?? '', now, 24).rows.sort((a, b) => a.at - b.at);
  // Reuse the bounded tail, including eventless outcomes and merges older than the rollup window.
  const mergeRows = ledgerRows(tail?.text ?? '', now, Infinity, true);
  if (tail && mergeRows.malformed) sourceState('ledger', 'degraded', 'invalid rows in bounded job ledger tail');
  const merges = new Map<string, { url: string; repo: string; number: number; title: string; at: string }>();
  for (const { row, at } of mergeRows.rows) {
    if (ledgerPhase(row) !== 'MERGED' && ledgerEventName(row) !== 'merged') continue;
    const url = ledgerPrUrl(row), match = url?.match(/^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[\w.-]{1,100})\/pull\/([1-9]\d*)$/);
    const mergedAt = row.mergedAt === undefined ? at : parseLedgerTs(row.mergedAt);
    if (!match || match[1]!.split('/').some(part => part === '.' || part === '..') || !Number.isSafeInteger(Number(match[2])) || mergedAt === null || mergedAt > now) continue;
    const observedAt = new Date(mergedAt).toISOString(), previous = merges.get(url!);
    if (!previous || observedAt >= previous.at) merges.set(url!, {
      url: url!, repo: match[1]!, number: Number(match[2]),
      title: typeof row.title === 'string' ? clean(row.title) : '', at: observedAt,
    });
  }
  const mergedPrs = [...merges.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5);
  const readyRows = ready === null ? null : parseReadyRows(ready);
  const ghosts = await fleetGhosts({ runsDir, now: () => now });
  const lanes = (snapshot?.snapshot.lanes ?? []).map(l => {
    const finished = [...new Map(rows.filter(r => r.lane === l.lane && ledgerEventName(r.row) === 'finish').map(r => [`${r.id}:${r.at}`, r])).values()].slice(-20);
    const slot = objectRow(slots[l.lane]), pause = slot.pause_new_until;
    const pause_new_until = typeof pause === 'number' && Number.isFinite(pause) ? pause : (parseLedgerTs(pause) ?? 0) / 1000 || null;
    const held = slot.held === true || (pause_new_until !== null && pause_new_until > now / 1000) ? true
      : slot.held === false || slot.held === undefined && Object.keys(slot).length ? false : l.held;
    const queuedReady = readyRows?.filter(r => r.lane === l.lane && !r.id.startsWith('PARKED-') && r.id !== 'id').length ?? null;
    return { lane: clean(l.lane), ghosts: ghosts.known ? ghosts.jobs.filter(j => j.lane === l.lane && j.state === 'ghost').length : null, running: tick.running[l.lane] ?? l.running, queued: queuedReady, queuedReady,
      target: l.target, held, pause_new_until, emptyRate: finished.length ? finished.filter(r => r.row.empty === true).length / finished.length : null };
  });
  const hungry = lanes.filter(l => l.held === false && l.running !== null && l.target !== null && l.queuedReady !== null
    && l.running < l.target / 2 && l.queuedReady < l.target - l.running).sort((a, b) => (b.target! - b.running!) - (a.target! - a.running!))[0];
  const headline = hungry ? `${hungry.lane} ${hungry.running}/${hungry.target} running, ${hungry.queuedReady} queued: supply-starved` : 'No measured supply-starved lane';
  const status = objectRow(json(await quiet(read(join(runsDir, 'queue/status.json'))), 'queue/status.json'));
  const admission = objectRow(status.admission), load = admission.load1, limit = admission.load_max;
  const fleetLoad = typeof load === 'number' && hostLoad.totalCpuPercent > 0 ? load * hostLoad.fleetCpuPercent / hostLoad.totalCpuPercent : null;
  const busy = hostLoad.families.filter(r => r.job === null && r.family !== 'leftover from finished jobs' && r.cpuPercent > 0).slice(0, 2).map(r => r.family).join(' and ');
  const hostLoadWarning = snapshot?.sources['queue/status.json'] === 'healthy' && admission.disabled === false
    && typeof load === 'number' && Number.isFinite(load) && typeof limit === 'number' && Number.isFinite(limit) && limit > 0
    && hostLoad.state === 'known' && load > limit && fleetLoad !== null && load - fleetLoad > fleetLoad
    ? `Mac busy with ${busy || 'unknown processes'} (load ${Math.round(load)}, fleet about ${Math.round(fleetLoad)}, CPU-share estimate): starts slowed` : null;
  const live = objectRow(json(liveText, LIVE_JOBS_FILE)) as Partial<LiveJobsSnapshot>;
  if (sources[LIVE_JOBS_FILE]?.state === 'healthy' && (live.known !== true || !Array.isArray(live.running)))
    sourceState(LIVE_JOBS_FILE, 'unknown', 'live job observations unavailable');
  const attention = (live.known === true && Array.isArray(live.running) ? live.running : []).filter(j => j && typeof j.id === 'string' && typeof j.lane === 'string' && (j.state === 'stuck' || j.state === 'quiet'))
    .sort((a, b) => Number(b.state === 'stuck') - Number(a.state === 'stuck') || (Number(b.elapsed) || 0) - (Number(a.elapsed) || 0))
    .slice(0, 5).map(j => ({ id: clean(j.id), lane: clean(j.lane), status: j.state, elapsed: j.elapsed }));
  const stops = stopText === null ? [] : stoppedFamilies(parseStopFile(stopText), now).filter(s => s.until > now / 1000)
    .map(s => ({ family: clean(s.family), until: s.until, why: s.why, auto: false }));
  stops.push(...activeFamilyStops(familyStopText ?? '', now).map(s => ({ ...s, family: clean(s.family) })));
  const release = await readReleaseBacklog({ now, cacheOnly: true });
  // Keep only facts that contribute to the first three explanations, before display rows are trimmed.
  const idleLanes: typeof lanes = [];
  const idleReasons = whyIdle({ at: new Date(now).toISOString(), lanes, attention, pools: [] });
  if (idleReasons.length) {
    const candidates = [...lanes.filter(l => l.held === true || (l.pause_new_until !== null && l.pause_new_until > now / 1000)),
      ...lanes.filter(l => l.held === false && !(l.pause_new_until !== null && l.pause_new_until > now / 1000) && l.queuedReady === 0)];
    for (const lane of candidates) {
      const before = whyIdle({ at: new Date(now).toISOString(), lanes: idleLanes, pools: [] });
      const after = whyIdle({ at: new Date(now).toISOString(), lanes: [...idleLanes, lane], pools: [] });
      if (JSON.stringify(before) !== JSON.stringify(after)) idleLanes.push(lane);
      if (idleLanes.length === 3) break;
    }
  }
  const idleEvidence = {
    lanes: idleLanes.map(({ lane, running, target, held, pause_new_until, queuedReady }) => ({ lane, running, target, held, pause_new_until, queuedReady })),
    attention: idleReasons.length ? attention.filter(j => j.status === 'stuck').map(({ lane, status }) => ({ lane, status })) : [],
  };
  const brief = {
    openPrs, mergedPrs,
    release: release.counts,
    releaseRepos: release.repos.map(r => ({ repo: r.repo, latestTag: r.latestTag, tagDate: r.releasedAt,
      commitsSinceTag: r.mergedCommits, state: r.verdict, reason: r.git?.reason ?? null, source: r.git?.source ?? (r.git ? 'local git' : 'GitHub cache') })),
    schema: 'leader.compact-brief.v1', at: new Date(now).toISOString(), headline, hostLoadWarning,
    state: openPrs !== null || lanes.length || tail || hasPace || guardian?.length ? 'ready' : 'no data', sources,
    windowHours: 2, emptyWindowHours: 24, lanes, admission: summarizeAdmission(admissionText, log?.text ?? null, now, slots),
    tickWallP95: parseTickCost(log?.text ?? null, now, 2, log?.truncated ?? false).tickWallP95,
    pools: (pace?.pools ?? []).map(p => ({ pool: clean(p.pool), usedPct: p.usedPct, hoursToReset: p.hoursToReset,
      burnPerHour: p.recentPerHour, safeBurn: p.safeBurnPerHour ?? null, verdict: p.verdict === 'stale' || p.verdict === 'spent' || p.verdict === 'free' ? p.line ?? p.verdict : p.verdict ?? 'unknown',
      headroom: p.headroom, source: p.source, ageHours: p.ageHours,
      why: p.verdict === 'unknown' ? [p.usedPct === null ? 'usage missing or stale' : '', p.hoursToReset === null || p.hoursToReset <= 0 ? 'reset missing or elapsed' : '', p.recentPerHour === null ? 'burn rate missing' : ''].filter(Boolean).join('; ') : 'usage, reset and burn rate known' })),
    families: briefFamilyYield(tail?.text ?? '', now).map(({ family, launches, prs, merges, empty }) => ({ family: clean(family), launches, prs, merges, empty })).sort((a, b) => a.prs / Math.max(1, a.launches) - b.prs / Math.max(1, b.launches) || b.launches - a.launches || a.family.localeCompare(b.family)),
    emptyTokenFamilies: tail === null ? null : emptyTokenFamilies(tail.text, now),
    attention, liveAt: typeof live?.generatedAt === 'string' ? clean(live.generatedAt) : null, main: (guardian ?? []).map(g => ({ repo: clean(g.repo), state: g.state, stale: g.stale })),
    medianOpenToMergeSeconds: latency.seconds, mergeLatencySource: latency.source, mergeLatencyWhy: latency.why,
    mergeLatency: latency,
    hostLoad: { ...hostLoad, leftovers: hostLoad.leftovers ? { ...hostLoad.leftovers, items: undefined } : undefined,
      families: hostLoad.families.slice(0, 8), omitted: hostLoad.omitted + Math.max(0, hostLoad.families.length - 8) },
    stopped: stops, omitted: Math.max(0, merges.size - mergedPrs.length),
    idleEvidence, whyIdle: idleReasons.map(clean),
  };
  // Drop the lowest-priority rows, explicitly counting omissions, until the entire wire payload fits.
  const lists = [brief.families, brief.stopped, brief.main, brief.pools, brief.lanes, brief.attention, brief.mergedPrs, brief.admission.perLane];
  while (Buffer.byteLength(JSON.stringify(brief)) >= 8191) {
    const list = lists.find(a => a.length > 1) ?? lists.find(a => a.length);
    if (list) { list.pop(); brief.omitted++; continue; }
    if (brief.emptyTokenFamilies && brief.emptyTokenFamilies.length > 3) { brief.emptyTokenFamilies.pop(); brief.omitted++; continue; }
    break;
  }
  return brief;
}
type GeneratedBrief = Awaited<ReturnType<typeof readCompactBrief>>;
/** Stored briefs written before merge projection recovery remain readable. */
export type CompactLeaderBrief = Omit<GeneratedBrief, 'mergedPrs' | 'tickWallP95' | 'idleEvidence'> & Partial<Pick<GeneratedBrief, 'mergedPrs' | 'tickWallP95' | 'idleEvidence'>>;
export async function writeCompactBrief(runsDir: string, now = Date.now(), file = join(runsDir, LEADER_COMPACT_FILE)) {
  const brief = await readCompactBrief(runsDir, now);
  await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
  writePrivateFileAtomic(file, JSON.stringify(brief) + '\n');
  return brief;
}
export function compactBriefLines(b: CompactLeaderBrief): string[] {
  const lines = [b.headline, ...(b.hostLoadWarning ? [b.hostLoadWarning] : []), b.admission.answer, `Leader: ${b.state} (${b.at}); lanes: ${b.lanes.length}; pools: ${b.pools.length}`,
    ...b.whyIdle,
    ...b.lanes.slice(0, 3 - b.whyIdle.length).map(l => `${l.lane}: ${l.running ?? '?'}/${l.target ?? '?'}, ${l.ghosts ?? '?'} ghosts, ${l.queued ?? '?'} queued, held ${l.held ?? '?'}, empty ${l.emptyRate === null ? '?' : Math.round(l.emptyRate * 100) + '%'}`),
    ...b.pools.slice(0, 2).map(p => `${p.pool}: ${p.usedPct ?? '?'}%, reset ${p.hoursToReset ?? '?'}h, burn ${p.burnPerHour ?? '?'}/h, safe ${p.safeBurn ?? '?'}/h, ${p.verdict}`),
    ...b.families.slice(0, 2).map(f => `${f.family}: ${f.launches} launches, ${f.prs} PRs, ${f.merges} merges, ${f.empty} empty (2h)`),
    ...(b.emptyTokenFamilies === null ? ['EMPTY tokens (24h): unknown'] : b.emptyTokenFamilies.slice(0, 3).map(f => `${f.family}: ${f.tokens === null ? 'unknown' : f.tokens} EMPTY tokens (24h), ${f.unknownJobs} jobs with unknown usage`)),
    ...b.stopped.filter(s => s.auto).map(s => `Stopped '${s.family}' for ${Math.ceil((s.until - Date.parse(b.at) / 1000) / 3600)} h: ${s.why}`),
    `Quiet/stuck: ${b.attention.map(j => j.id).join(', ') || (b.sources[LIVE_JOBS_FILE]?.state === 'healthy' ? 'none recorded' : 'unknown')}`,
    `Main: ${b.main.map(g => `${g.repo} ${g.state}${g.stale ? ' stale' : ''}`).join(', ') || 'unknown'}`,
    `Open PRs: ${b.openPrs ?? 'unknown'}`,
    `Release: ${b.release.due} due, ${b.release.stale} stale, ${b.release.unknown} unknown`,
    mergeLatencyLine(b.mergeLatency), b.hostLoad.blame, ioWaitLine(b.hostLoad), `Stopped: ${b.sources.stops?.state === 'healthy' ? b.stopped.length : 'unknown'}; omitted: ${b.omitted}`,
    `Sources: ${Object.values(b.sources).filter(s => s.state !== 'healthy').length} missing, degraded or bounded`];
  while (lines.length < 10) lines.push('No further data.');
  if (b.hostLoad.leftovers && b.hostLoad.leftovers.cpuPercent > 50) lines.push(`${b.hostLoad.leftovers.processes} leftover processes from finished jobs use ${b.hostLoad.leftovers.cpuPercent}% CPU (the fleet cleans these every 5 min)`);
  return lines;
}
