#!/usr/bin/env -S npx tsx
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readResourceLedger, type ResourceLedgerV1 } from '../../src/core/fleet/runs-resource-ledger.js';
import { readFleetRunsDirState, type FleetRunsDirState } from '../../src/core/fleet/runs-dir-state.js';

type Dependencies = {
  ledger: typeof readResourceLedger;
  runs: typeof readFleetRunsDirState;
  now: () => number;
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
  write: (text: string) => void;
  signal?: AbortSignal;
};

const MAX_LANES = 100;
const isClaude = (lane: string) => lane === 'claude' || lane.startsWith('claude-');
const isFiveHour = (window: unknown) => typeof window === 'string' && /^(?:5|five)[\s_-]*(?:h|hr|hrs|hour|hours)$/i.test(window);

/** Compose two independent, public projections without inferring quota or changing holds. */
export function claudeWindowReport(ledger: ResourceLedgerV1, runs: FleetRunsDirState) {
  const resources = new Map(ledger.lanes.filter(row => isClaude(row.lane)).map(row => [row.lane, row]));
  const dispatch = new Map(runs.lanes.filter(row => isClaude(row.lane)).map(row => [row.lane, row]));
  const names = [...new Set(['claude', 'claude-api', ...resources.keys(), ...dispatch.keys()])].sort();
  const violations = names.filter(name => isFiveHour(resources.get(name)?.window));
  return {
    v: 1,
    observation: {
      ledger: { generatedAt: ledger.generatedAt, asOf: ledger.asOf, sources: ledger.sources },
      runs: { generatedAt: runs.generatedAt, lastTick: runs.lastTick, sourceState: runs.sourceState, sources: runs.sources },
    },
    violationCount: violations.length,
    lanesOmitted: Math.max(0, names.length - MAX_LANES),
    lanes: names.slice(0, MAX_LANES).map(lane => {
      const resource = resources.get(lane);
      const run = dispatch.get(lane);
      const join = !resource || !run || !ledger.asOf || !runs.lastTick || resource.running === null || resource.target === null || resource.held === null
        ? 'unknown'
        : Date.parse(ledger.asOf) !== Date.parse(runs.lastTick) || resource.running !== run.running || resource.target !== run.target || resource.held !== run.held
          ? 'mismatched' : 'matched';
      const window: unknown = resource?.window;
      const validWindow = window === 'weekly' || window === 'credits' || window === 'none' ? window : null;
      const reason = join === 'matched' && run?.held ? run.heldReason : null;
      return {
        lane, join,
        window: validWindow, usedPct: resource?.usedPct ?? null, creditsRemaining: resource?.creditsRemaining ?? null,
        resetAt: resource?.resetAt ?? null, source: resource?.source ?? null,
        held: resource?.held ?? null, heldReason: reason,
        holdKind: reason && /\b(?:auth(?:entication|orization)?|unauthori[sz]ed|login|sign[ -]?in)\b/i.test(reason) ? 'authentication' : 'unknown',
        violation: isFiveHour(window),
      };
    }),
  };
}

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolveWait => {
    if (signal.aborted) { resolveWait(); return; }
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolveWait(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

const usage = 'npx tsx examples/agents/claude-window-check.ts [--runs-dir PATH] [--samples 1..10 [--interval-ms 1000..60000]] [--help]';

/** Run a bounded sequence of reads; all output, including errors, is JSON lines. */
export async function runClaudeWindowCheck(args: readonly string[], overrides: Partial<Dependencies> = {}): Promise<number> {
  const deps: Dependencies = { ledger: readResourceLedger, runs: readFleetRunsDirState, now: Date.now, wait: waitFor,
    write: text => process.stdout.write(text), ...overrides };
  const emit = (value: unknown) => deps.write(JSON.stringify(value) + '\n');
  let runsDir: string | undefined;
  let samples: number | undefined;
  let interval: number | undefined;
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];
    if (arg === '--runs-dir' && runsDir === undefined && next && !next.startsWith('-') && next.length <= 4096 && !/\p{Cc}/u.test(next)) { runsDir = next; i++; }
    else if ((arg === '--samples' || arg === '--interval-ms') && next && /^\d{1,5}$/.test(next)) {
      const value = Number(next);
      if (arg === '--samples' && samples === undefined && value >= 1 && value <= 10) samples = value;
      else if (arg === '--interval-ms' && interval === undefined && value >= 1000 && value <= 60000) interval = value;
      else { emit({ v: 1, error: 'invalid_arguments', usage }); return 2; }
      i++;
    } else if ((arg === '--help' || arg === '-h') && !help) help = true;
    else { emit({ v: 1, error: 'invalid_arguments', usage }); return 2; }
  }
  if (interval !== undefined && (samples ?? 1) < 2) { emit({ v: 1, error: 'invalid_arguments', usage }); return 2; }
  if (help) { emit({ v: 1, usage }); return 0; }
  const stop = new AbortController();
  const abort = () => stop.abort();
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  deps.signal?.addEventListener('abort', abort, { once: true });
  if (deps.signal?.aborted) abort();
  let code = 0;
  try {
    for (let i = 0; i < (samples ?? 1) && !stop.signal.aborted; i++) {
      try {
        const now = deps.now();
        const [ledger, runs] = await Promise.all([deps.ledger({ runsDir, now: () => now }), deps.runs({ runsDir, now: () => now })]);
        const report = claudeWindowReport(ledger, runs);
        emit(report);
        if (report.violationCount) code = 1;
      } catch {
        emit({ v: 1, error: 'read_failed' });
        code = 1;
      }
      if (i + 1 < (samples ?? 1) && !stop.signal.aborted) {
        try { await deps.wait(interval ?? 5000, stop.signal); }
        catch {
          if (!stop.signal.aborted) { emit({ v: 1, error: 'wait_failed' }); code = 1; }
          break;
        }
      }
    }
    return stop.signal.aborted ? 130 : code;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    deps.signal?.removeEventListener('abort', abort);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runClaudeWindowCheck(process.argv.slice(2));
}
