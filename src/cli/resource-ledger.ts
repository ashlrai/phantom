import { isDeepStrictEqual } from 'node:util';
import { readResourceLedger, type ResourceLedgerV1 } from '../core/fleet/runs-resource-ledger.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const value = (input: string | number | boolean | null): string => input === null ? 'unknown' : String(input);
const LANE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SPEND_GLOBAL = ['rowsToday', 'errorsToday', 'tokensInToday', 'tokensOutToday', 'usdToday', 'usdWeek', 'lastAt', 'models', 'modelUsageTodayOmitted'].map(key => `apiSpend.${key}`);
type LedgerView = ResourceLedgerV1 & {
  laneFilter?: { lane: unknown; global: string[] };
  modelFilter?: { model: unknown; displayed: number | null; selectionOmitted: number | null; global: string[] };
};

function selectLedger(ledger: ResourceLedgerV1, lane: string | undefined, model: string | undefined): LedgerView {
  let view: LedgerView = ledger;
  if (lane !== undefined) {
    view = { ...view, lanes: ledger.lanes.filter(row => row.lane === lane),
      laneFilter: { lane: sanitizePublicJson(lane), global: ['generatedAt', 'asOf', 'sources', ...(model === undefined ? ['apiSpend'] : SPEND_GLOBAL), 'jobsMalformedRows'] } };
  }
  if (model !== undefined) {
    const spend = ledger.apiSpend;
    const selected = spend?.modelUsageToday.filter(row => row.model === model);
    view = { ...view, apiSpend: spend === null ? null : { ...spend, modelUsageToday: selected! },
      modelFilter: { model: sanitizePublicJson(model), displayed: selected?.length ?? null,
        selectionOmitted: selected === undefined ? null : spend!.modelUsageToday.length - selected.length, global: SPEND_GLOBAL } };
  }
  return view;
}

function printLedger(ledger: LedgerView): void {
  console.log(`Resource ledger (generated: ${ledger.generatedAt}; observed: ${value(ledger.asOf)})`);
  if (ledger.laneFilter !== undefined) {
    console.log(`Lane filter: ${ledger.laneFilter.lane}; sources and API spend ${ledger.modelFilter ? 'totals are global' : 'are global'}`);
  }
  if (ledger.modelFilter !== undefined) console.log(`Model filter: ${ledger.modelFilter.model}; API spend totals and model list are global`);
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
    console.log(`\nAPI spend: ${ledger.modelFilter ? 'global totals: ' : ''}today ${value(spend.usdToday)} USD; week ${value(spend.usdWeek)} USD; rows ${spend.rowsToday}; errors ${spend.errorsToday}`);
    console.log(`  Tokens in/out today: ${spend.tokensInToday}/${spend.tokensOutToday}; last observed: ${value(spend.lastAt)}; models: ${spend.models.length ? spend.models.join(', ') : 'none reported'}`);
    for (const model of spend.modelUsageToday ?? []) {
      console.log(`  ${model.model}: rows ${model.rows}; errors ${model.errors}; tokens in/out ${model.inputTokens}/${model.outputTokens}; ${value(model.usd)} USD; last observed: ${model.lastAt}`);
    }
    if (ledger.modelFilter !== undefined) {
      console.log(`  Model selection: ${ledger.modelFilter.displayed} displayed; ${ledger.modelFilter.selectionOmitted} omitted by selection${ledger.modelFilter.displayed === 0 ? '; no matching model in reader output' : ''}`);
    }
    if (spend.modelUsageTodayOmitted > 0) console.log(`  Model usage omitted: ${spend.modelUsageTodayOmitted}`);
  }
}

export async function cmdResourceLedger(
  args: string[],
  read: () => Promise<ResourceLedgerV1> = readResourceLedger,
  signal?: AbortSignal,
  now: () => number = Date.now,
): Promise<number> {
  let json = false;
  let help = false;
  let watch = false;
  let changesOnly = false;
  let interval: number | undefined;
  let maxSamples: number | undefined;
  let lane: string | undefined;
  let model: string | undefined;
  let freshSeconds: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if ((arg === '--help' || arg === '-h') && !help) help = true;
    else if (arg === '--watch' && !watch) watch = true;
    else if (arg === '--changes-only' && !changesOnly) changesOnly = true;
    else if (arg === '--lane' && lane === undefined) {
      const raw = args[++i];
      if (raw === undefined || !LANE.test(raw)) {
        process.stderr.write('Invalid ledger arguments; use phm resources ledger --help.\n');
        return 2;
      }
      lane = raw;
    }
    else if (arg === '--model' && model === undefined) {
      const raw = args[++i];
      if (raw === undefined || !MODEL.test(raw)) {
        process.stderr.write('Invalid ledger arguments; use phm resources ledger --help.\n');
        return 2;
      }
      model = raw;
    }
    else if (arg === '--check-fresh-seconds' && freshSeconds === undefined) {
      const raw = args[++i];
      const parsed = Number(raw);
      if (raw === undefined || !/^\d+$/.test(raw) || !Number.isSafeInteger(parsed)) {
        process.stderr.write('Invalid ledger arguments; use phm resources ledger --help.\n');
        return 2;
      }
      freshSeconds = parsed;
    }
    else if (arg === '--interval-ms' && interval === undefined) {
      const raw = args[++i];
      if (!raw || !/^\d+$/.test(raw) || Number(raw) < 1000 || Number(raw) > 60000) {
        process.stderr.write('Invalid ledger arguments; use phm resources ledger --help.\n');
        return 2;
      }
      interval = Number(raw);
    }
    else if (arg === '--max-samples' && maxSamples === undefined) {
      const raw = args[++i];
      if (!raw || !/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 10000) {
        process.stderr.write('Invalid ledger arguments; use phm resources ledger --help.\n');
        return 2;
      }
      maxSamples = Number(raw);
    }
    else {
      process.stderr.write('Invalid ledger arguments; use phm resources ledger --help.\n');
      return 2;
    }
  }
  if (((interval !== undefined || maxSamples !== undefined) && !watch) || (changesOnly && (!watch || !json)) || (watch && freshSeconds !== undefined)) {
    process.stderr.write('Invalid ledger arguments; use phm resources ledger --help.\n');
    return 2;
  }
  if (help) {
    console.log('Usage: phm resources ledger [--json] [--watch [--interval-ms 1000..60000] [--max-samples 1..10000] [--changes-only]] [--check-fresh-seconds N] [--lane <lane>] [--model <exact-model-id>] [--help|-h]');
    console.log('Read the live resource ledger, including source health and observation time.');
    console.log('Watch reads sequentially (default interval: 5000 ms); JSON output is one object per line.');
    console.log('--max-samples stops after that many successful observations, including suppressed snapshots; read errors do not count.');
    console.log('--changes-only requires --watch --json and suppresses snapshots that differ only in generatedAt.');
    console.log('JSONL example: phm resources ledger --watch --max-samples 2 --json');
    console.log('--lane keeps only matching lane rows; sources, API spend and other fields stay global.');
    console.log('--model selects exact matches from the reader’s model usage rows; API spend totals remain global.');
    console.log('Reader omissions are separate from selection omissions; a missing match may be among omitted rows.');
    console.log('--check-fresh-seconds N checks global status asOf against the current clock (N is a nonnegative safe integer).');
    console.log('One-shot only: the versioned freshnessCheck reports age in seconds and pass, stale or unknown.');
    console.log('Exit 1 for stale, missing/invalid or future asOf; the check does not assess individual lanes or API spend.');
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
      let samples = 0;
      let previous: Omit<LedgerView, 'generatedAt'> | undefined;
      while (!stop.signal.aborted) {
        let ledger: ResourceLedgerV1 | undefined;
        try { ledger = await read(); } catch {
          if (json) console.log(JSON.stringify({ v: 1, error: 'resource_ledger_read_failed' }));
          else process.stderr.write('Unable to read resource ledger.\n');
        }
        if (ledger) {
          const view = selectLedger(ledger, lane, model);
          if (changesOnly) {
            const { generatedAt: _generatedAt, ...comparable } = view;
            if (previous === undefined || !isDeepStrictEqual(previous, comparable)) {
              console.log(JSON.stringify(view));
              previous = structuredClone(comparable);
            }
          } else if (json) console.log(JSON.stringify(view));
          else printLedger(view);
          samples++;
        }
        if (stop.signal.aborted || samples === maxSamples) break;
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
    const view = selectLedger(await read(), lane, model);
    if (freshSeconds === undefined) {
      if (json) console.log(JSON.stringify(view, null, 2));
      else printLedger(view);
      return 0;
    }
    const observed = view.asOf === null ? NaN : Date.parse(view.asOf);
    const age = (now() - observed) / 1000;
    const observedAgeSeconds = Number.isFinite(age) ? age : null;
    const result = observedAgeSeconds === null || observedAgeSeconds < 0 ? 'unknown'
      : observedAgeSeconds > freshSeconds ? 'stale' : 'pass';
    const freshnessCheck = { v: 1, maxAgeSeconds: freshSeconds, observedAgeSeconds, result };
    if (json) console.log(JSON.stringify({ ...view, freshnessCheck }, null, 2));
    else {
      printLedger(view);
      console.log(`\nFreshness check v1: ${result}; observed age ${value(observedAgeSeconds)} seconds; maximum ${freshSeconds} seconds (global status asOf)`);
    }
    return result === 'pass' ? 0 : 1;
  } catch {
    process.stderr.write('Unable to read resource ledger.\n');
    return 1;
  }
}
