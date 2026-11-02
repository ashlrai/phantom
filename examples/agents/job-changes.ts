#!/usr/bin/env -S npx tsx
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getFleetJobChanges, type FleetJobChangesOptions } from '../../src/core/fleet/runs-job-changes.js';
import { isFleetJobId } from '../../src/core/fleet/runs-job-detail.js';

type Reader = typeof getFleetJobChanges;
export interface JobChangesDependencies {
  read?: Reader;
  readerOptions?: FleetJobChangesOptions;
  write?: (text: string) => void;
}

/** Run the command without exiting the host process; injected options are for callers and tests. */
export async function runJobChanges(args: readonly string[], deps: JobChangesDependencies = {}): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const emit = (value: unknown) => write(`${JSON.stringify(value)}\n`);
  if (args.length !== 2 || args[0] !== '--job' || !isFleetJobId(args[1] ?? '')) {
    emit({ error: 'usage: --job <fleet-job-id>' });
    return 2;
  }
  try {
    const result = await (deps.read ?? getFleetJobChanges)(args[1]!, deps.readerOptions);
    emit(result);
    return result.state === 'live' ? 0 : 1;
  } catch {
    // Do not expose internal paths or errors from the reader.
    emit({ error: 'job changes unavailable' });
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runJobChanges(process.argv.slice(2));
}
