#!/usr/bin/env -S npx tsx
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFleetRunsDirState, type FleetRunsDirState } from '../../src/core/fleet/runs-dir-state.js';
import { readResourceLedger, type ResourceLedgerV1 } from '../../src/core/fleet/runs-resource-ledger.js';

type Readers = {
  runs: typeof readFleetRunsDirState;
  ledger: typeof readResourceLedger;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

/** Project the union of lanes without treating an absent observation as zero. */
export function capacityReport(runs: FleetRunsDirState, ledger: ResourceLedgerV1) {
  const dispatch = new Map(runs.lanes.map(lane => [lane.lane, lane]));
  const resources = new Map(ledger.lanes.map(lane => [lane.lane, lane]));
  const names = [...new Set([...dispatch.keys(), ...resources.keys()])].sort();
  return {
    v: 1,
    observation: {
      runs: { generatedAt: runs.generatedAt, lastTick: runs.lastTick, sourceState: runs.sourceState, sources: runs.sources },
      ledger: { generatedAt: ledger.generatedAt, asOf: ledger.asOf, sources: ledger.sources },
      paused: runs.paused,
      switches: runs.switches,
    },
    lanes: names.map(lane => {
      const d = dispatch.get(lane);
      const r = resources.get(lane);
      const join = !d || !r || !runs.lastTick || !ledger.asOf || r.running === null || r.target === null || r.held === null
        ? 'unknown'
        : Date.parse(runs.lastTick) !== Date.parse(ledger.asOf) || d.running !== r.running || d.target !== r.target || d.held !== r.held
          ? 'mismatched' : 'matched';
      return {
        lane, join,
        running: d?.running ?? null, target: d?.target ?? null, queued: d?.queued ?? null,
        held: d?.held ?? null, heldReason: d?.heldReason ?? null,
        usage: r ? {
          window: r.window, usedPct: r.usedPct, creditsRemaining: r.creditsRemaining,
          resetAt: r.resetAt, burnPctPerHour: r.burnPctPerHour, tokensPerHour6h: r.tokensPerHour6h,
          projectedExhaustion: r.projectedExhaustion, source: r.source,
          tokensLastHour: d?.tokensLastHour ?? null,
        } : null,
      };
    }),
  };
}

const help = `Usage: npx tsx examples/agents/capacity-report.ts [--runs-dir PATH] [--help|-h]
Read-only JSON capacity report from the local runs directory (default: ~/.ashlr-runs).
`;

/** Run the CLI; readers and output are injectable for callers and tests. */
export async function runCapacityReport(args: string[], overrides: Partial<Readers> = {}): Promise<number> {
  const deps: Readers = {
    runs: readFleetRunsDirState, ledger: readResourceLedger,
    stdout: text => process.stdout.write(text), stderr: text => process.stderr.write(text), ...overrides,
  };
  let runsDir: string | undefined;
  let wantsHelp = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--runs-dir' && runsDir === undefined && args[i + 1] && !args[i + 1]!.startsWith('-')) runsDir = args[++i];
    else if ((arg === '--help' || arg === '-h') && !wantsHelp) wantsHelp = true;
    else { deps.stderr('Invalid arguments; use --help.\n'); return 2; }
  }
  if (wantsHelp) { deps.stdout(help); return 0; }
  try {
    const [runs, ledger] = await Promise.all([deps.runs({ runsDir }), deps.ledger({ runsDir })]);
    deps.stdout(`${JSON.stringify(capacityReport(runs, ledger), null, 2)}\n`);
    return 0;
  } catch {
    deps.stderr('Unable to read capacity report.\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runCapacityReport(process.argv.slice(2));
}
