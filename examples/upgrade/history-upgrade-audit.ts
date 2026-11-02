#!/usr/bin/env -S npx tsx
/* global process */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readRunsHistory, RUNS_HISTORY_DEFAULT_HOURS, RUNS_HISTORY_MAX_HOURS, RUNS_HISTORY_MIN_HOURS,
  type ReadRunsHistoryOptions, type RunsHistory,
} from '../../src/core/fleet/runs-history.js';

const HELP = `Usage: npx tsx examples/upgrade/history-upgrade-audit.ts --max-gap-minutes MINUTES [--hours HOURS]

Audit retained fleet history without taking or changing samples.
Exit codes: 0 verified, 1 gap or reader failure, 2 usage, 3 insufficient evidence.
`;
const MAX_REPORTED_GAPS = 100;
type Dependencies = {
  read?: (options: ReadRunsHistoryOptions) => Promise<RunsHistory>;
  write?: (text: string) => void;
};

/** Audit an existing history without changing process state or sampling. */
export async function run(args: string[], deps: Dependencies = {}): Promise<number> {
  const write = deps.write ?? (text => process.stdout.write(text));
  if (args.length === 1 && args[0] === '--help') { write(HELP); return 0; }
  let hours = RUNS_HISTORY_DEFAULT_HOURS;
  let maxGap: number | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if ((key !== '--hours' && key !== '--max-gap-minutes') || seen.has(key) ||
        value === undefined || !/^\d+(?:\.\d+)?$/.test(value)) {
      write(`${JSON.stringify({ error: 'Invalid arguments. Use --help for usage.' })}\n`); return 2;
    }
    seen.add(key);
    const number = Number(value);
    if (key === '--hours') hours = number;
    else maxGap = number;
  }
  if (!Number.isInteger(hours) || hours < RUNS_HISTORY_MIN_HOURS || hours > RUNS_HISTORY_MAX_HOURS ||
      maxGap === undefined || !Number.isFinite(maxGap) || maxGap <= 0 || maxGap > Number.MAX_SAFE_INTEGER / 60_000) {
    write(`${JSON.stringify({ error: 'Invalid arguments. Use --help for usage.' })}\n`); return 2;
  }

  try {
    const history = await (deps.read ?? readRunsHistory)({ hours });
    const from = Date.parse(history.from);
    const to = Date.parse(history.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) throw new Error();
    const times = history.samples.map(sample => Date.parse(sample.at));
    if (times.some(time => !Number.isFinite(time))) throw new Error();
    const futureSamples = times.filter(time => time > to).length;
    const observations = times.filter(time => time >= from && time <= to).sort((a, b) => a - b);
    const distinct = [...new Set(observations)];
    const gaps: { from: string; to: string; minutes: number }[] = [];
    let gapCount = 0;
    if (distinct.length > 0) {
      const boundaries = [from, ...distinct, to];
      for (let i = 1; i < boundaries.length; i++) {
        const start = boundaries[i - 1]!;
        const end = boundaries[i]!;
        if (end - start > maxGap * 60_000) {
          gapCount++;
          if (gaps.length < MAX_REPORTED_GAPS) gaps.push({
            from: new Date(start).toISOString(), to: new Date(end).toISOString(), minutes: (end - start) / 60_000,
          });
        }
      }
    }
    const status = distinct.length >= 2 && gapCount > 0 ? 'mismatch'
      : distinct.length < 2 || history.sourceState !== 'healthy' || history.dropped > 0 || futureSamples > 0
        ? 'insufficient' : 'verified';
    write(`${JSON.stringify({
      schema: 'phantom.history-upgrade-audit.v1', status,
      from: new Date(from).toISOString(), to: new Date(to).toISOString(), hours, maxGapMinutes: maxGap,
      sourceState: history.sourceState, dropped: history.dropped, futureSamples,
      sampleCount: observations.length, distinctInstants: distinct.length,
      firstObservation: observations.length ? new Date(observations[0]!).toISOString() : null,
      lastObservation: observations.length ? new Date(observations[observations.length - 1]!).toISOString() : null,
      gapCount, gaps, gapsTruncated: gapCount > gaps.length,
    })}\n`);
    return status === 'verified' ? 0 : status === 'mismatch' ? 1 : 3;
  } catch {
    write(`${JSON.stringify({ error: 'Unable to audit history.' })}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
