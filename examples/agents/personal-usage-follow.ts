#!/usr/bin/env -S npx tsx
/**
 * Follow the local personal Codex session usage source without writing a ledger.
 * Usage: npx tsx examples/agents/personal-usage-follow.ts [--samples 2..60] [--interval-ms 1000..60000]
 * Defaults: 2 samples, 5000 ms. Reads only the personal home ~/.codex-2.
 * stdout is JSONL: sample records followed by one summary. Summary delta is
 * percentage points, or null when evidence cannot establish a comparison.
 * stderr errors are JSONL: {"type":"error","code":"invalid_arguments"|"observation_failed"}.
 * Exit codes: 0 completed, 2 invalid arguments, 1 observation failure, 130 cancelled.
 * Symlinks within the sessions tree are refused; concurrent changes are not isolated.
 */
/* global AbortController, AbortSignal, NodeJS */
import { homedir } from 'node:os';
import { lstatSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import {
  buildCodexResourceReport, collectCodexSessionUsages,
  type CodexAccountResource, type CodexSessionUsage,
} from '../../src/core/fleet/codex-session-usage.js';

type Dependencies = {
  homeDir: string;
  now: () => number;
  read: typeof collectCodexSessionUsages;
  wait: (ms: number, signal?: AbortSignal) => Promise<void>;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  signal?: AbortSignal;
};

type Sample = { type: 'sample'; sampledAt: string; resource: CodexAccountResource };

// The collector follows symlinks within sessions. Refuse them before calling it
// so a personal sessions tree cannot redirect ordinary reads to another home.
function readPersonal(opts: NonNullable<Parameters<typeof collectCodexSessionUsages>[0]>): CodexSessionUsage[] {
  const home = opts.env?.['CODEX_HOME'];
  if (!home) throw new Error();
  let visited = 0;
  const inspect = (path: string, depth: number): void => {
    let stat;
    try { stat = lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error();
    if (!stat.isDirectory() || depth === 0) return;
    for (const entry of readdirSync(path)) {
      if (++visited > 10000) throw new Error();
      inspect(join(path, entry), depth - 1);
    }
  };
  // Collector traverses sessions/year/month/day and opens the files there.
  inspect(home, 0);
  inspect(join(home, 'sessions'), 4);
  return collectCodexSessionUsages(opts);
}

function missingUsage(): CodexSessionUsage {
  return {
    accountId: 'codex-personal', slot: 'secondary', observedAt: null,
    planType: null, limitId: null, limitName: null, rateLimitReachedType: null,
    spendControlReached: null, individualLimit: null, model: null, originator: null,
    cliVersion: null, primary: null, secondary: null, credits: null,
  };
}

function summary(samples: Sample[], cancelled: boolean) {
  const first = samples[0];
  const last = samples.at(-1);
  let comparable = !cancelled && samples.length >= 2;
  for (let i = 0; i < samples.length; i++) {
    const current = samples[i]!.resource;
    const previous = samples[i - 1]?.resource;
    const weekly = current.weekly;
    if (current.state !== 'current' || !current.observedAt || !weekly || weekly.usedPct === null ||
        !weekly.resetsAt || Date.parse(current.observedAt) > Date.parse(samples[i]!.sampledAt) ||
        Date.parse(weekly.resetsAt) <= Date.parse(samples[i]!.sampledAt)) comparable = false;
    if (previous && (current.observedAt === null || previous.observedAt === null ||
        Date.parse(current.observedAt) < Date.parse(previous.observedAt) ||
        weekly?.id !== previous.weekly?.id || weekly?.windowMinutes !== previous.weekly?.windowMinutes ||
        weekly?.resetsAt !== previous.weekly?.resetsAt || weekly?.usedPct == null ||
        previous.weekly?.usedPct == null || weekly.usedPct < previous.weekly.usedPct ||
        (current.observedAt === previous.observedAt && weekly.usedPct !== previous.weekly.usedPct))) comparable = false;
  }
  if (!first?.resource.observedAt || !last?.resource.observedAt ||
      Date.parse(last.resource.observedAt) <= Date.parse(first.resource.observedAt)) comparable = false;
  return {
    type: 'summary', status: cancelled ? 'cancelled' : 'completed', samples: samples.length,
    first: first ? { observedAt: first.resource.observedAt, usedPct: first.resource.weekly?.usedPct ?? null } : null,
    last: last ? { observedAt: last.resource.observedAt, usedPct: last.resource.weekly?.usedPct ?? null } : null,
    weeklyUsedPctDelta: comparable ? last!.resource.weekly!.usedPct! - first!.resource.weekly!.usedPct! : null,
  };
}

/** Observe a bounded sequence; clock, source, wait, and output are injectable. */
export async function runPersonalUsageFollow(args: string[], overrides: Partial<Dependencies> = {}): Promise<number> {
  const deps: Dependencies = {
    homeDir: homedir(), now: Date.now, read: readPersonal,
    wait: async (ms, signal) => { await delay(ms, undefined, { signal }); },
    stdout: line => { process.stdout.write(line); }, stderr: line => { process.stderr.write(line); },
    ...overrides,
  };
  const values: Record<string, number> = { '--samples': 2, '--interval-ms': 5000 };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    const raw = args[++i];
    const min = key === '--samples' ? 2 : 1000;
    const max = key === '--samples' ? 60 : 60000;
    if (!Object.hasOwn(values, key) || seen.has(key) || !raw || !/^\d+$/.test(raw) ||
        !Number.isSafeInteger(Number(raw)) || Number(raw) < min || Number(raw) > max) {
      deps.stderr(`${JSON.stringify({ type: 'error', code: 'invalid_arguments' })}\n`);
      return 2;
    }
    seen.add(key);
    values[key] = Number(raw);
  }
  const samples: Sample[] = [];
  const personalHome = join(deps.homeDir, '.codex-2');
  try {
    while (samples.length < values['--samples']! && !deps.signal?.aborted) {
      const nowMs = deps.now();
      const usages = deps.read({ env: { CODEX_HOME: personalHome, CODEX_HOME_ALT: personalHome }, homeDir: deps.homeDir });
      const usage = usages[0] ? { ...usages[0], accountId: 'codex-personal', slot: 'secondary' as const,
        limitId: null, limitName: null, model: null, originator: null, cliVersion: null } : missingUsage();
      const resource = buildCodexResourceReport([usage], [], nowMs).resources[0]!;
      const sample: Sample = { type: 'sample', sampledAt: new Date(nowMs).toISOString(), resource };
      samples.push(sample);
      deps.stdout(`${JSON.stringify(sample)}\n`);
      if (samples.length < values['--samples']! && !deps.signal?.aborted) {
        try { await deps.wait(values['--interval-ms']!, deps.signal); }
        catch (error) { if (!deps.signal?.aborted) throw error; }
      }
    }
    const cancelled = deps.signal?.aborted === true;
    deps.stdout(`${JSON.stringify(summary(samples, cancelled))}\n`);
    return cancelled ? 130 : 0;
  } catch {
    deps.stderr(`${JSON.stringify({ type: 'error', code: 'observation_failed' })}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const cancel = () => { controller.abort(); };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try { process.exitCode = await runPersonalUsageFollow(process.argv.slice(2), { signal: controller.signal }); }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
