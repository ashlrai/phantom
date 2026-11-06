#!/usr/bin/env -S npx tsx
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readResourceLedger, type ResourceLedgerV1, type ResourceLaneRow } from '../../src/core/fleet/runs-resource-ledger.js';
import { scrubPrivateText } from '../../src/core/util/scrub.js';

type Sample = {
  sampledAt: string;
  generatedAt: string;
  statusAsOf: string | null;
  sources: ResourceLedgerV1['sources'];
  lane: Pick<ResourceLaneRow, 'window' | 'usedPct' | 'tokensPerHour6h' | 'running' | 'held' | 'source'> | null;
  observedAt: string | null;
  observationSource: string | null;
};

type Dependencies = {
  readLedger?: () => Promise<ResourceLedgerV1>;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  output?: (text: string) => void;
  signal?: AbortSignal;
};

function sample(ledger: ResourceLedgerV1, name: string, now: number): Sample {
  const row = ledger.lanes.find(item => item.lane === name);
  return {
    sampledAt: new Date(now).toISOString(), generatedAt: ledger.generatedAt,
    statusAsOf: ledger.asOf, sources: ledger.sources,
    lane: row ? { window: row.window, usedPct: row.usedPct, tokensPerHour6h: row.tokensPerHour6h,
      running: row.running, held: row.held, source: row.source } : null,
    observedAt: row ? (row.observation?.asOf ?? ledger.asOf) : null,
    observationSource: row ? (row.observation?.source ?? 'status') : null,
  };
}

function timestampChange(before: string | null, after: string | null) {
  if (!before || !after || !Number.isFinite(Date.parse(before)) || !Number.isFinite(Date.parse(after))) return 'missing';
  const delta = Date.parse(after) - Date.parse(before);
  return delta === 0 ? 'stale' : delta > 0 ? 'advanced' : 'reset';
}

function numericChange(before: number | null, after: number | null) {
  if (before === null || after === null) return { state: 'unknown', delta: null };
  const delta = after - before;
  return { state: delta === 0 ? 'unchanged' : delta > 0 ? 'increased' : 'decreased', delta };
}

/** Compare the ledger's observations without inferring a quota or an amount spent. */
export function usageDeltaProbe(name: string, before: Sample, after: Sample) {
  const first = before.lane;
  const second = after.lane;
  const comparable = first && second && first.window === second.window &&
    before.observationSource === after.observationSource && first.source === second.source;
  const usage = !first || !second ? { state: 'missing', deltaPct: null }
    : !comparable || first.window !== 'weekly' || first.usedPct === null || second.usedPct === null
      ? { state: 'unknown', deltaPct: null }
      : second.usedPct < first.usedPct ? { state: 'reset', deltaPct: null }
        : { state: second.usedPct === first.usedPct ? 'unchanged' : 'advanced', deltaPct: second.usedPct - first.usedPct };
  return {
    v: 1, lane: name, before, after,
    changes: {
      usage,
      tokensPerHour6h: comparable ? numericChange(first.tokensPerHour6h, second.tokensPerHour6h) : { state: 'unknown', delta: null },
      running: numericChange(first?.running ?? null, second?.running ?? null),
      observedAt: before.observationSource === after.observationSource
        ? timestampChange(before.observedAt, after.observedAt) : 'missing',
      statusAsOf: timestampChange(before.statusAsOf, after.statusAsOf),
    },
  };
}

function waitForInterval(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolveWait => {
    if (signal.aborted) { resolveWait(); return; }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolveWait();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** Sample twice; dependencies keep this runner import-safe and testable. */
export async function runUsageDeltaProbe(args: readonly string[], deps: Dependencies = {}): Promise<number> {
  const output = deps.output ?? ((text: string) => process.stdout.write(text));
  const emit = (value: unknown) => output(`${JSON.stringify(value)}\n`);
  let lane: string | undefined;
  let interval: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = args[++i];
    if (arg === '--lane' && lane === undefined && value && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value) && scrubPrivateText(value) === value) lane = value;
    else if (arg === '--interval-ms' && interval === undefined && value && /^\d{1,5}$/.test(value) && Number(value) >= 1000 && Number(value) <= 60000) interval = Number(value);
    else { emit({ v: 1, error: 'invalid_arguments' }); return 2; }
  }
  if (!lane || interval === undefined) { emit({ v: 1, error: 'invalid_arguments' }); return 2; }
  const stop = new AbortController();
  let interrupted = 130;
  const abort = () => stop.abort();
  const onInt = () => { interrupted = 130; abort(); };
  const onTerm = () => { interrupted = 143; abort(); };
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  deps.signal?.addEventListener('abort', abort, { once: true });
  if (deps.signal?.aborted) abort();
  try {
    const read = deps.readLedger ?? readResourceLedger;
    const now = deps.now ?? Date.now;
    if (stop.signal.aborted) { emit({ v: 1, error: 'interrupted' }); return interrupted; }
    const before = sample(await read(), lane, now());
    if (!stop.signal.aborted) await (deps.wait ?? waitForInterval)(interval, stop.signal);
    if (stop.signal.aborted) { emit({ v: 1, error: 'interrupted' }); return interrupted; }
    const after = sample(await read(), lane, now());
    if (stop.signal.aborted) { emit({ v: 1, error: 'interrupted' }); return interrupted; }
    emit(usageDeltaProbe(lane, before, after));
    return 0;
  } catch {
    emit({ v: 1, error: stop.signal.aborted ? 'interrupted' : 'probe_failed' });
    return stop.signal.aborted ? interrupted : 1;
  } finally {
    process.removeListener('SIGINT', onInt);
    process.removeListener('SIGTERM', onTerm);
    deps.signal?.removeEventListener('abort', abort);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runUsageDeltaProbe(process.argv.slice(2));
}
