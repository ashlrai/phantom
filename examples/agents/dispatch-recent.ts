#!/usr/bin/env -S npx tsx
import process from 'node:process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFleetRunsDirState, type FleetRunsDirState } from '../../src/core/fleet/runs-dir-state.js';

const kinds = ['LAUNCH', 'PUBLISHED', 'PUBLISH_START', 'PUBLISH_ABORT', 'INCIDENT', 'LANE_HOLD'] as const;
type Kind = typeof kinds[number];
const usage = `Usage: npx tsx examples/agents/dispatch-recent.ts [--kind ${kinds.join('|')}] [--help]`;

export interface DispatchRecentDeps {
  read: () => Promise<FleetRunsDirState>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** Print the existing reader's bounded, scrubbed evidence; never dispatch work. */
export async function runDispatchRecent(args: string[], deps: DispatchRecentDeps = {
  read: readFleetRunsDirState,
  stdout: text => { process.stdout.write(text); },
  stderr: text => { process.stderr.write(text); },
}): Promise<number> {
  let kind: Kind | undefined;
  let help = false;
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--help' || args[i] === '-h') && !help) help = true;
    else if (args[i] === '--kind' && !kind && kinds.some(value => value === args[i + 1])) kind = args[++i] as Kind;
    else {
      deps.stderr(`error: invalid arguments\n${usage}\n`);
      return 2;
    }
  }
  if (help) { deps.stdout(`${usage}\n`); return 0; }
  try {
    const state = await deps.read();
    const events = state.events.filter(event => kinds.some(value => value === event.kind) && (!kind || event.kind === kind));
    deps.stdout(`${JSON.stringify({
      generatedAt: state.generatedAt,
      runsDirPresent: state.runsDirPresent,
      sourceState: state.sourceState,
      sources: state.sources,
      lastTick: state.lastTick,
      events,
    })}\n`);
    return 0;
  } catch {
    deps.stderr('error: dispatch evidence unavailable\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runDispatchRecent(process.argv.slice(2));
}
