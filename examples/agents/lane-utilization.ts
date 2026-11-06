#!/usr/bin/env -S npx tsx
/* global process */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRunsHistory, type ReadRunsHistoryOptions, type RunsHistory } from '../../src/core/fleet/runs-history.js';

const HELP = `Usage: npx tsx examples/agents/lane-utilization.ts --hours 1..168 [--lane ID]

Report observed lane capacity from retained runs history as versioned JSON.
Each observation supplies values until the next observation, capped at five minutes;
coverage requires the lane at both endpoints. Window edges outside those intervals
are unknown. Duplicate timestamps are ambiguous and do not supply coverage.
Occupied and target slot-seconds include held and paused time. Spare slot-seconds
are max(target - running, 0) only when neither held nor paused; an unknown pause
state is reported separately. Held and paused durations can overlap. Sampling is
on-read and partial or degraded history is not proof of complete fleet activity.
`;
const MAX_GAP_MS = 5 * 60_000;
type Dependencies = {
  read?: (options: ReadRunsHistoryOptions) => Promise<RunsHistory>;
  write?: (text: string) => void;
};

/** Read existing observations without sampling or changing history. */
export async function run(args: string[], deps: Dependencies = {}): Promise<number> {
  const write = deps.write ?? (text => process.stdout.write(text));
  if (args.length === 1 && args[0] === '--help') { write(HELP); return 0; }
  let hours: number | undefined;
  let lane: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if ((key !== '--hours' && key !== '--lane') || seen.has(key) || !value || value.startsWith('--')) {
      write(`${JSON.stringify({ error: 'Invalid arguments. Use --help for usage.' })}\n`); return 2;
    }
    seen.add(key);
    if (key === '--hours') {
      if (!/^\d+$/.test(value)) { write(`${JSON.stringify({ error: 'Invalid hours.' })}\n`); return 2; }
      hours = Number(value);
    } else lane = value;
  }
  if (hours === undefined || !Number.isInteger(hours) || hours < 1 || hours > 168) {
    write(`${JSON.stringify({ error: 'Invalid hours. Use --help for usage.' })}\n`); return 2;
  }
  try {
    const history = await (deps.read ?? readRunsHistory)({ hours });
    const from = Date.parse(history.from);
    const to = Date.parse(history.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) throw new Error();
    const samples = history.samples.map(sample => ({ sample, time: Date.parse(sample.at) }))
      .filter(row => Number.isFinite(row.time) && row.time >= from && row.time <= to)
      .sort((a, b) => a.time - b.time);
    const names = lane === undefined
      ? [...new Set(samples.flatMap(row => row.sample.lanes.map(item => item.lane)))].sort()
      : [lane];
    const lanes = names.map(name => {
      let coveredSeconds = 0, occupiedSlotSeconds = 0, targetSlotSeconds = 0, dispatchableSpareSlotSeconds = 0;
      let heldSeconds = 0, pausedSeconds = 0, pauseUnknownSeconds = 0;
      for (let i = 0; i + 1 < samples.length; i++) {
        const current = samples[i]!;
        const next = samples[i + 1]!;
        // Equal timestamps (and intervals touching them) have no reliable ordering.
        if (current.time === next.time || (i > 0 && samples[i - 1]!.time === current.time) ||
            (i + 2 < samples.length && samples[i + 2]!.time === next.time)) continue;
        const currentLanes = current.sample.lanes.filter(item => item.lane === name);
        const nextLanes = next.sample.lanes.filter(item => item.lane === name);
        if (currentLanes.length !== 1 || nextLanes.length !== 1) continue;
        const item = currentLanes[0]!;
        const seconds = Math.min(next.time - current.time, MAX_GAP_MS) / 1000;
        coveredSeconds += seconds;
        occupiedSlotSeconds += item.running * seconds;
        targetSlotSeconds += item.target * seconds;
        if (item.held) heldSeconds += seconds;
        if (current.sample.paused === true) pausedSeconds += seconds;
        if (current.sample.paused === null) pauseUnknownSeconds += seconds;
        if (!item.held && current.sample.paused === false) {
          dispatchableSpareSlotSeconds += Math.max(item.target - item.running, 0) * seconds;
        }
      }
      return { lane: name, coveredSeconds, unknownSeconds: (to - from) / 1000 - coveredSeconds,
        occupiedSlotSeconds, targetSlotSeconds, dispatchableSpareSlotSeconds, heldSeconds, pausedSeconds, pauseUnknownSeconds };
    });
    write(`${JSON.stringify({ schema: 'phantom.lane-utilization.v1', from: history.from, to: history.to,
      generatedAt: history.generatedAt, hours, maxGapSeconds: MAX_GAP_MS / 1000,
      sourceState: history.sourceState, dropped: history.dropped, sampleCount: samples.length, lanes })}\n`);
    return 0;
  } catch {
    write(`${JSON.stringify({ error: 'Unable to read runs history.' })}\n`); return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
