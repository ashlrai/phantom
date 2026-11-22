import { isJobControlAction } from '../core/fleet/job-control-types.js';
import { readEmptyJobs } from '../core/fleet/empty-jobs.js';

const usage = 'Usage: phm jobs order [--json] [--apply] [--runs-dir <dir>] | phm jobs live [--json] [--write <file>] | phm jobs tail <id> [--lines N] [--follow] [--json] [--runs-dir <abs>] | phm jobs pause|resume|stop|move <id> [--lane <lane>] [--dry-run] [--json] [--runs-dir <abs>] | phm jobs yield [--since 24h|7d] [--by source|lane|family] [--stop-list | --stop-file [--ttl-hours N] [--out PATH] [--dry-run]] [--json] | phm jobs cost [--since 24h] [--by lane|model] [--metrics <jobs.jsonl>] [--json] | phm jobs tokens --lane <lane> [--since 24h] [--metrics <jobs.jsonl>] [--json] | phm jobs empty-why [--lane <lane>] [--last N] [--since 24h] [--metrics <jobs.jsonl>] [--json] | phm jobs producers [--since 6h] [--metrics <jobs.jsonl>] [--queue <router-queue.md>] [--json] | phm jobs gaps [--since 24h] [--propose] [--json] | phm jobs lost [--since 24h] [--requeue-hint] [--json] | phm jobs state <id> [--json] | phm jobs empty [--json] [--since <hours>h] [--family F] [--lane L] [--by lane|reason] [--record] [--by-family [--apply [--dry-run] [--ttl-hours N] | --undo <family>]] | phm jobs retry-empty --dry-run|--apply [--json] [--file <router-queue.md>] | phm jobs stuck [--lane L] [--json] | phm jobs stranded [--since 24h] [--runs-dir <dir>] [--requeue [--apply]] [--json] | phm jobs dupcheck <prompt-file> [--repo <path>] [--json] | phm jobs skipped [--since 24h] [--json]';
export async function cmdJobs(args: string[], read = readEmptyJobs, readFamilies: (hours: number) => ReturnType<typeof import('../core/fleet/empty-families.js').readEmptyFamilies> = async hours => (await import('../core/fleet/empty-families.js')).readEmptyFamilies(hours)): Promise<number> {
  if (args[0] === 'order') return (await import('./jobs-order.js')).cmdJobsOrder(args.slice(1));
  if (args[0] === 'redfix-candidates') return (await import('./jobs-redfix-candidates.js')).cmdJobsRedfixCandidates(args.slice(1));
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(usage); return 0; }
  if (isJobControlAction(args[0])) return (await import('./job.js')).cmdJobControl(args[0], args.slice(1), 'jobs');
  if (args[0] === 'tail') return (await import('./job.js')).cmdJobTail(args.slice(1));
  if (args[0] === 'live') return (await import('./jobs-live.js')).cmdJobsLive(args.slice(1));
  if (args[0] === 'yield') return (await import('./jobs-yield.js')).cmdJobsYield(args.slice(1));
  if (args[0] === 'empty-why') return (await import('./jobs-yield.js')).cmdJobsYield(args.slice(1), undefined, Date.now(), true);
  if (args[0] === 'cost') return (await import('./jobs-cost.js')).cmdJobsCost(args.slice(1));
  if (args[0] === 'tokens') return (await import('./jobs-tokens.js')).cmdJobsTokens(args.slice(1));
  if (args[0] === 'producers') return (await import('./jobs-producers.js')).cmdJobsProducers(args.slice(1));
  if (args[0] === 'gaps') return (await import('./jobs-gaps.js')).cmdJobsGaps(args.slice(1));
  if (args[0] === 'lost') return (await import('./jobs-lost.js')).cmdJobsLost(args.slice(1));
  if (args[0] === 'stuck') return (await import('./jobs-stuck.js')).cmdJobsStuck(args.slice(1));
  if (args[0] === 'stranded') return (await import('./jobs-stranded.js')).cmdJobsStranded(args.slice(1));
  if (args[0] === 'dupcheck') return (await import('./jobs-dupcheck.js')).cmdJobsDupcheck(args.slice(1));
  if (args[0] === 'skipped') return (await import('./fleet-skipped.js')).cmdJobsSkipped(args.slice(1));
  if (args[0] === 'state') return cmdJobsState(args.slice(1));
  if (args[0] === 'retry-empty') return (await import('./jobs-retry-empty.js')).cmdJobsRetryEmpty(args.slice(1));
  if (args[0] !== 'empty') { console.error(usage); return 2; }
  let hours = 24;
  let json = false;
  let family: string | undefined;
  let lane: string | undefined;
  let by: 'lane' | 'reason' | undefined, record = false;
  let byFamily = false, apply = false, dryRun = false, ttl: number | null = null, undo: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--by-family') byFamily = true;
    else if (args[i] === '--record') record = true;
    else if (args[i] === '--by' && by === undefined) {
      const value = args[++i];
      if (value !== 'lane' && value !== 'reason') { console.error(usage); return 2; }
      by = value;
    }
    else if (args[i] === '--apply' && !apply) apply = true;
    else if (args[i] === '--dry-run' && !dryRun) dryRun = true;
    else if (args[i] === '--ttl-hours' && ttl === null) {
      ttl = /^\d+(\.\d+)?$/.test(args[++i] ?? '') ? Number(args[i]) : NaN;
      if (!(ttl > 0 && ttl <= 168)) { console.error(usage); return 2; }
    } else if (args[i] === '--undo' && undo === undefined) {
      undo = args[++i];
      if (!undo || !/^[A-Za-z0-9][A-Za-z0-9._*-]*$/.test(undo)) { console.error(usage); return 2; }
    }
    else if (args[i] === '--help' || args[i] === '-h') { console.log(usage); return 0; }
    else if (args[i] === '--since') {
      const match = /^(\d+(?:\.\d+)?)h$/.exec(args[++i] ?? '');
      if (!match || Number(match[1]) <= 0 || Number(match[1]) > 8760) { console.error(usage); return 2; }
      hours = Number(match[1]);
    } else if (args[i] === '--family' && family === undefined) {
      family = args[++i];
      if (!family || !/^[A-Za-z0-9][A-Za-z0-9._*-]*$/.test(family)) { console.error(usage); return 2; }
    } else if (args[i] === '--lane' && lane === undefined) {
      lane = args[++i];
      if (!lane || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(lane)) { console.error(usage); return 2; }
    } else { console.error(usage); return 2; }
  }
  if (byFamily && (by || record)) { console.error(usage); return 2; }
  if (!byFamily && (apply || dryRun || ttl !== null || undo !== undefined)) { console.error(usage); return 2; }
  if (byFamily && (dryRun || ttl !== null) && !apply) { console.error(usage); return 2; }
  if (byFamily && apply && undo !== undefined) { console.error(usage); return 2; }
  if (byFamily && undo !== undefined) {
    if (family || lane) { console.error(usage); return 2; }
    const { undoEmptyFamily } = await import('../core/fleet/empty-family-apply.js');
    const { runsRoot } = await import('../core/metrics/loop-collect.js');
    const undone = await undoEmptyFamily(runsRoot(), undo);
    if (json) console.log(JSON.stringify(undone));
    else if (!undone.known) console.error(undone.error);
    else console.log(undone.removed_ids.length || undone.removed_hints ? `Undone ${undo}: ${undone.removed_ids.length} retired ${undone.removed_ids.length === 1 ? 'id' : 'ids'} and ${undone.removed_hints} lane-avoid ${undone.removed_hints === 1 ? 'hint' : 'hints'} removed.` : `Nothing recorded for ${undo}.`);
    return undone.known ? 0 : 1;
  }
  if (byFamily && apply) {
    if (family || lane) { console.error(usage); return 2; }
    const { applyEmptyFamilies, formatEmptyApply, EMPTY_STOP_TTL_HOURS } = await import('../core/fleet/empty-family-apply.js');
    const { runsRoot } = await import('../core/metrics/loop-collect.js');
    const done = await applyEmptyFamilies({ runsDir: runsRoot(), apply: !dryRun, hours, ttlHours: ttl ?? EMPTY_STOP_TTL_HOURS, readReport: readFamilies });
    if (json) console.log(JSON.stringify(done));
    else for (const line of formatEmptyApply(done)) (done.known ? console.log : console.error)(line);
    return done.known ? 0 : 1;
  }
  if (byFamily) {
    if (family || lane) { console.error(usage); return 2; }
    const { formatEmptyFamilies } = await import('../core/fleet/empty-families.js');
    const grouped = await readFamilies(hours);
    if (!grouped) { console.error('Jobs ledger is unreadable.'); return 1; }
    if (json) console.log(JSON.stringify(grouped));
    else for (const line of formatEmptyFamilies(grouped)) console.log(line);
    return 0;
  }
  const report = await read(hours, undefined, undefined, undefined, { family, lane, quote: true });
  if (!report) { console.error('Jobs ledger is unreadable.'); return 1; }
  if (record && report.tagged?.length) {
    const { runsRoot } = await import('../core/metrics/loop-collect.js');
    const { recordEmptyTags } = await import('../core/fleet/empty-tags.js');
    await recordEmptyTags(runsRoot(), report.tagged).catch(() => 0);
    // A job the pre-launch gate let through that ended already_done: keep it so dupcheck's precision can be measured.
    await (await import('../core/queue/dupcheck-gate.js')).recordDupcheckOutcomes(runsRoot(), report.tagged).catch(() => 0);
  }
  if (json) console.log(JSON.stringify(report));
  else if (by && report.digest) for (const line of (await import('../core/fleet/empty-digest.js')).formatEmptyDigest(report.digest, by, hours)) console.log(line);
  else if (report.total === 0) console.log('No empty jobs.');
  else {
    console.log(`${report.total} empty jobs in the last ${hours} hours`);
    for (const row of report.final?.lanes ?? []) {
      const parts = Object.entries(row.reasons).filter(([, n]) => n > 0).map(([why, n]) => `${why} ${n}`);
      console.log(`Lane ${row.lane}: ${row.total} empty; ${parts.join(', ')}`);
    }
    for (const [why, list] of Object.entries(report.final?.examples ?? {})) {
      const quote = list?.[0]?.sentence;
      if (quote) console.log(`Newest ${why}: "${quote}" (${list![0]!.id})`);
    }
    for (const [label, groups] of [['Family', report.diagnosis?.families], ['Lane', report.diagnosis?.lanes]] as const) {
      for (const group of groups ?? []) console.log(`${label} ${group.name}: ${group.total} empty; ${group.topReason}; ${group.suggestion}`);
    }
    for (const job of report.diagnosis?.jobs ?? []) console.log(`${job.id} (${job.lane}): ${job.reason}`);
  }
  return 0;
}

async function cmdJobsState(args: string[]): Promise<number> {
  const json = args.includes('--json');
  const rest = args.filter(a => a !== '--json');
  if (rest.length !== 1 || rest[0]!.startsWith('-')) { console.error(usage); return 2; }
  const { readJobWorkState, formatWorkState } = await import('../core/fleet/job-work-state.js');
  let state;
  try { state = await readJobWorkState(rest[0]!); } catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 2; }
  if (json) console.log(JSON.stringify(state));
  else {
    console.log(formatWorkState(state));
    for (const line of state.evidence) console.log(`- ${line}`);
  }
  return state.state === 'UNKNOWN' ? 1 : 0;
}
