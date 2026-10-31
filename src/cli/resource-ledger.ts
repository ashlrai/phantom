import { readResourceLedger, type ResourceLedgerV1 } from '../core/fleet/runs-resource-ledger.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const value = (input: string | number | boolean | null): string => input === null ? 'unknown' : String(input);
const LANE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
type LaneFiltered = ResourceLedgerV1 & { laneFilter?: { lane: unknown; global: string[] } };

function filterLane(ledger: ResourceLedgerV1, lane: string | undefined): LaneFiltered {
  if (lane === undefined) return ledger;
  return { ...ledger, lanes: ledger.lanes.filter(row => row.lane === lane),
    laneFilter: { lane: sanitizePublicJson(lane), global: ['generatedAt', 'asOf', 'sources', 'apiSpend', 'jobsMalformedRows'] } };
}

function printLedger(ledger: LaneFiltered): void {
  console.log(`Resource ledger (generated: ${ledger.generatedAt}; observed: ${value(ledger.asOf)})`);
  if (ledger.laneFilter !== undefined) {
    console.log(`Lane filter: ${ledger.laneFilter.lane}; sources and API spend are global`);
  }
  console.log(`Sources: status ${ledger.sources.status}; API spend ${ledger.sources.apiSpend}`);
  if (ledger.lanes.length === 0) console.log(ledger.laneFilter === undefined ? 'Lanes: none reported' : 'Lanes: none matching lane filter');
  for (const lane of ledger.lanes) {
    console.log(`\n${lane.lane}: running/target ${value(lane.running)}/${value(lane.target)}; held ${value(lane.held)}; window ${lane.window}`);
    if (lane.window === 'weekly') {
      console.log(`  Weekly usage: ${lane.usedPct === null ? 'unknown' : `${lane.usedPct}%`}`);
    } else if (lane.window === 'credits') {
      console.log(`  Credits remaining: ${value(lane.creditsRemaining)}`);
    } else {
      console.log('  Usage: unmetered / no reported window');
    }
    console.log(`  Reset: ${value(lane.resetAt)}; source: ${value(lane.source)}`);
    console.log(`  Burn: ${lane.burnPctPerHour === null ? 'unknown' : `${lane.burnPctPerHour}%/hour`}; tokens/hour (6h): ${value(lane.tokensPerHour6h)}; projected exhaustion: ${value(lane.projectedExhaustion)}`);
  }
  const spend = ledger.apiSpend;
  if (spend === null) {
    console.log('\nAPI spend: unknown');
  } else {
    console.log(`\nAPI spend: today ${value(spend.usdToday)} USD; week ${value(spend.usdWeek)} USD; rows ${spend.rowsToday}; errors ${spend.errorsToday}`);
    console.log(`  Tokens in/out today: ${spend.tokensInToday}/${spend.tokensOutToday}; last observed: ${value(spend.lastAt)}; models: ${spend.models.length ? spend.models.join(', ') : 'none reported'}`);
    for (const model of spend.modelUsageToday ?? []) {
      console.log(`  ${model.model}: rows ${model.rows}; errors ${model.errors}; tokens in/out ${model.inputTokens}/${model.outputTokens}; ${value(model.usd)} USD; last observed: ${model.lastAt}`);
    }
    if (spend.modelUsageTodayOmitted > 0) console.log(`  Model usage omitted: ${spend.modelUsageTodayOmitted}`);
  }
}

export async function cmdResourceLedger(
  args: string[],
  read: () => Promise<ResourceLedgerV1> = readResourceLedger,
  signal?: AbortSignal,
): Promise<number> {
  let json = false;
  let help = false;
  let watch = false;
  let interval: number | undefined;
  let lane: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if ((arg === '--help' || arg === '-h') && !help) help = true;
    else if (arg === '--watch' && !watch) watch = true;
    else if (arg === '--lane' && lane === undefined) {
      const raw = args[++i];
      if (raw === undefined || !LANE.test(raw)) {
        process.stderr.write('Invalid ledger arguments; use phm resources ledger --help.\n');
        return 2;
      }
      lane = raw;
    }
    else if (arg === '--interval-ms' && interval === undefined) {
      const raw = args[++i];
      if (!raw || !/^\d+$/.test(raw) || Number(raw) < 1000 || Number(raw) > 60000) {
        process.stderr.write('Invalid ledger arguments; use phm resources ledger --help.\n');
        return 2;
      }
      interval = Number(raw);
    }
    else {
      process.stderr.write('Invalid ledger arguments; use phm resources ledger --help.\n');
      return 2;
    }
  }
  if (interval !== undefined && !watch) {
    process.stderr.write('Invalid ledger arguments; use phm resources ledger --help.\n');
    return 2;
  }
  if (help) {
    console.log('Usage: phm resources ledger [--json] [--watch [--interval-ms 1000..60000]] [--lane <lane>] [--help|-h]');
    console.log('Read the live resource ledger, including source health and observation time.');
    console.log('Watch reads sequentially (default interval: 5000 ms); JSON output is one object per line.');
    console.log('--lane keeps only matching lane rows; sources, API spend and other fields stay global.');
    return 0;
  }
  if (watch) {
    const stop = new AbortController();
    const abort = () => stop.abort();
    process.on('SIGINT', abort);
    process.on('SIGTERM', abort);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      while (!stop.signal.aborted) {
        let ledger: ResourceLedgerV1 | undefined;
        try { ledger = await read(); } catch {
          if (json) console.log(JSON.stringify({ v: 1, error: 'resource_ledger_read_failed' }));
          else process.stderr.write('Unable to read resource ledger.\n');
        }
        if (ledger) {
          const view = filterLane(ledger, lane);
          if (json) console.log(JSON.stringify(view));
          else printLedger(view);
        }
        if (stop.signal.aborted) break;
        await new Promise<void>(resolve => {
          const finish = () => {
            clearTimeout(timer);
            stop.signal.removeEventListener('abort', finish);
            resolve();
          };
          const timer = setTimeout(finish, interval ?? 5000);
          stop.signal.addEventListener('abort', finish, { once: true });
        });
      }
      return 0;
    } finally {
      process.removeListener('SIGINT', abort);
      process.removeListener('SIGTERM', abort);
      signal?.removeEventListener('abort', abort);
    }
  }
  try {
    const view = filterLane(await read(), lane);
    if (json) console.log(JSON.stringify(view, null, 2));
    else printLedger(view);
    return 0;
  } catch {
    process.stderr.write('Unable to read resource ledger.\n');
    return 1;
  }
}
