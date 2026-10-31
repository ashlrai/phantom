import { laneDeadSignals, type LaneDeadSignal } from '../core/fleet/lane-dead-signal.js';
import { readResourceLedger, type ResourceLedgerV1 } from '../core/fleet/runs-resource-ledger.js';

const value = (input: string | number | boolean | null): string => input === null ? 'unknown' : String(input);

/** Human-friendly summary of a lane's dead signal, for CLI output. */
export function formatDeadSignal(signal: LaneDeadSignal | null): string {
  if (signal === null) return 'unknown';
  return `state=${signal.state}; emptyFailures=${signal.emptyFailures}; lastFinishes=${signal.lastFinishes}`;
}

export { laneDeadSignals };
export type { LaneDeadSignal };

function printLedger(ledger: ResourceLedgerV1): void {
  console.log(`Resource ledger (generated: ${ledger.generatedAt}; observed: ${value(ledger.asOf)})`);
  console.log(`Sources: status ${ledger.sources.status}; API spend ${ledger.sources.apiSpend}`);
  if (ledger.lanes.length === 0) console.log('Lanes: none reported');
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
    console.log(`  Dead: ${formatDeadSignal(lane.deadSignal)}`);
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
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if ((arg === '--help' || arg === '-h') && !help) help = true;
    else if (arg === '--watch' && !watch) watch = true;
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
    console.log('Usage: phm resources ledger [--json] [--watch [--interval-ms 1000..60000]] [--help|-h]');
    console.log('Read the live resource ledger, including source health and observation time.');
    console.log('Watch reads sequentially (default interval: 5000 ms); JSON output is one object per line.');
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
          if (json) console.log(JSON.stringify(ledger));
          else printLedger(ledger);
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
    const ledger = await read();
    if (json) console.log(JSON.stringify(ledger, null, 2));
    else printLedger(ledger);
    return 0;
  } catch {
    process.stderr.write('Unable to read resource ledger.\n');
    return 1;
  }
}
