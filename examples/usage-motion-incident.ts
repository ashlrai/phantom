#!/usr/bin/env -S npx tsx
import { isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { auditUsageMotion } from '../src/core/fleet/usage-motion-audit.js';
import { listLiveWorkers } from '../src/core/fleet/runs-live-workers.js';
import { scrubSecrets } from '../src/core/util/scrub.js';

const HELP = `Usage: npx tsx examples/usage-motion-incident.ts --queue-dir ABSOLUTE_PATH

Read one usage audit and one local worker process snapshot; print JSON to stdout.
The snapshots are independent observations, not proof of causation or continuous activity.
Diagnostic commands are argument arrays for existing CLI commands, not executed here.
Exit codes: 0 report produced, 1 reader failure, 2 invalid arguments.
`;

type Options = { runPs?: () => Promise<string>; now?: () => number };

/** Read only the existing local projections. Tests may supply the process transport and clock. */
export async function main(args: string[], options: Options = {}): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.length !== 2 || args[0] !== '--queue-dir' || !args[1] || !isAbsolute(args[1]) || args[1].includes('\0')) {
    process.stderr.write('Invalid arguments. Use --help.\n');
    return 2;
  }
  const queueDir = args[1];
  const now = options.now ?? Date.now;
  try {
    const [audit, live] = await Promise.all([
      auditUsageMotion({ queueDir, now: () => new Date(now()) }),
      listLiveWorkers({ runPs: options.runPs, now }),
    ]);
    const workers = new Map<string, number>();
    for (const worker of live.workers) workers.set(worker.lane, (workers.get(worker.lane) ?? 0) + 1);
    const lanes = audit.lanes.map(lane => {
      // The process parser recognizes this narrower lane alphabet. It cannot prove
      // absence for other names or for a token changed by the canonical scrubber.
      const comparable = /^[a-z0-9-]{1,32}$/.test(lane.lane) && scrubSecrets(lane.lane) === lane.lane;
      const liveWorkers = live.sourceState === 'healthy' && comparable ? workers.get(lane.lane) ?? 0 : null;
      const unchanged = lane.classification === 'incident' || lane.classification === 'idle';
      const explanation = lane.classification === 'insufficient-evidence' ? 'insufficient-usage-or-queue-evidence'
        : !unchanged ? lane.classification
        : liveWorkers === null ? 'unchanged-process-evidence-unknown'
        : liveWorkers > 0 ? 'unchanged-with-live-workers' : 'unchanged-without-live-workers';
      return { audit: lane, liveWorkers, explanation };
    });
    const auditLanes = new Set(audit.lanes.map(lane => lane.lane));
    const uncorrelatedWorkers = [...workers].filter(([lane]) => !auditLanes.has(lane))
      .map(([lane, count]) => ({ lane, count }));
    const commands = [
      ['ashlr', 'fleet', 'usage-audit', '--queue-dir', queueDir, '--json'],
      ['ashlr', 'fleet', 'lanes', '--queue-dir', queueDir, '--json'],
      ['ashlr', 'fleet', 'workers', '--json'],
    ];
    process.stdout.write(`${JSON.stringify({
      schema: 'usage-motion-incident.v1',
      observation: {
        audit: { generatedAt: audit.generatedAt, windowMinutes: audit.windowMinutes,
          freshnessMinutes: audit.freshnessMinutes, sources: audit.sources, incidents: audit.incidents },
        workers: { generatedAt: live.generatedAt, sourceState: live.sourceState },
      },
      lanes, uncorrelatedWorkers, commands,
    })}\n`);
    return 0;
  } catch {
    process.stderr.write('Unable to produce usage motion report.\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
