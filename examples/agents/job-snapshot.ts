#!/usr/bin/env -S npx tsx
/* global process */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFleetJobDetail, isFleetJobId, type FleetJobDetailV1 } from '../../src/core/fleet/runs-job-detail.js';

const HELP = `Usage: npx tsx examples/agents/job-snapshot.ts --job ID

Print the desktop's bounded, scrubbed fleet.job.v1 projection as JSON.
Exit codes: 0 success, 1 reader error, 2 invalid arguments, 3 no job evidence, 4 degraded source.
`;

type Dependencies = {
  read?: (job: string) => Promise<FleetJobDetailV1>;
  write?: (text: string) => void;
};

/** Run the command without changing process state; dependencies can be replaced by tests. */
export async function runJobSnapshot(args: string[], dependencies: Dependencies = {}): Promise<number> {
  const write = dependencies.write ?? (text => process.stdout.write(text));
  if (args.length === 1 && args[0] === '--help') {
    write(HELP);
    return 0;
  }
  if (args.length !== 2 || args[0] !== '--job' || !isFleetJobId(args[1]!)) {
    write(`${JSON.stringify({ error: 'Expected --job followed by a valid job ID. Use --help for usage.' })}\n`);
    return 2;
  }

  try {
    const detail = await (dependencies.read ?? getFleetJobDetail)(args[1]!);
    write(`${JSON.stringify(detail)}\n`);
    const sources = Object.values(detail.sources);
    if (sources.includes('degraded')) return 4;
    if (sources.every(source => source === 'missing') && detail.promptBytes === null
      && !detail.notes.hasNotes && !detail.notes.hasBody) return 3;
    return 0;
  } catch {
    // Do not expose filesystem paths or other details from unexpected errors.
    write(`${JSON.stringify({ error: 'Unable to read job snapshot.' })}\n`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runJobSnapshot(process.argv.slice(2));
}
