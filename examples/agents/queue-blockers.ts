#!/usr/bin/env -S npx tsx
import { resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { readFleetQueue } from '../../src/core/fleet/runs-parked-queue.js';

interface Dependencies {
  readQueue?: typeof readFleetQueue;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

/** Read the public queue projection without changing queue files or holds. */
export async function runQueueBlockers(args: string[], deps: Dependencies = {}): Promise<number> {
  const stdout = deps.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = deps.stderr ?? ((text: string) => process.stderr.write(text));
  if (args.length !== 0 && !(args.length === 2 && args[0] === '--lane' && args[1] && !args[1].startsWith('--'))) {
    stderr('Usage: npx tsx examples/agents/queue-blockers.ts [--lane LANE]\n');
    return 2;
  }

  try {
    const queue = await (deps.readQueue ?? readFleetQueue)();
    const groups = args.length ? queue.groups.filter((group) => group.lane === args[1]) : queue.groups;
    stdout(`${JSON.stringify({
      v: queue.v, generatedAt: queue.generatedAt, sources: queue.sources,
      total: queue.total, ready: queue.ready, parked: queue.parked, malformed: queue.malformed,
      groups,
    }, null, 2)}\n`);
    return Object.values(queue.sources).every((source) => source === 'healthy') ? 0 : 1;
  } catch {
    stderr('Unable to read the fleet queue.\n');
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runQueueBlockers(process.argv.slice(2));
}
