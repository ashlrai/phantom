#!/usr/bin/env -S npx tsx
/** Compare artifact facts from two fleet jobs; this does not evaluate success. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getFleetJobDetail, isFleetJobId, type FleetJobDetailV1 } from '../../src/core/fleet/runs-job-detail.js';
import { getFleetJobChanges, type FleetJobChangesV1 } from '../../src/core/fleet/runs-job-changes.js';
import { redactHomePaths, scrubSecrets } from '../../src/core/util/scrub.js';

const USAGE = `Usage: npx tsx examples/agents/job-pair-compare.ts --before ID --after ID

Compare artifact facts, not success verdicts. File sets describe observed paths;
complete is false when either changes source is missing, degraded, or truncated.
Line totals are null when unavailable or when any observed file has unknown counts.
Exit codes: 0 comparison, 1 reader error, 2 invalid arguments.
Errors are JSON: {"schema":"fleet.job-pair-compare.error.v1","error":"invalid_arguments"|"reader_unavailable"}.
`;

type Dependencies = {
  readDetail?: (job: string) => Promise<FleetJobDetailV1>;
  readChanges?: (job: string) => Promise<FleetJobChangesV1>;
  write?: (text: string) => void;
};

function parseArgs(args: readonly string[]): { before: string; after: string } | null {
  if (args.length !== 4) return null;
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1]!;
    if (!['--before', '--after'].includes(key) || options.has(key) || !isFleetJobId(value)) return null;
    options.set(key, value);
  }
  const before = options.get('--before'), after = options.get('--after');
  return before && after ? { before, after } : null;
}

function attempt(detail: FleetJobDetailV1, changes: FleetJobChangesV1) {
  const known = (field: 'added' | 'removed') => changes.state === 'live'
    && changes.files.every(file => file[field] !== null);
  return {
    job: detail.job, lane: detail.lane, model: detail.model, artifactState: detail.state,
    testLine: detail.publish?.testLine ?? null, prUrl: detail.publish?.prUrl ?? null,
    sources: { ...detail.sources, changes: changes.state },
    changes: {
      generatedAt: changes.generatedAt, baseSha: changes.baseSha,
      comparisonBase: changes.comparisonBase ?? null, truncated: changes.truncated,
      observedTotals: changes.state === 'missing' ? null : {
        files: changes.totals.files,
        added: known('added') ? changes.totals.added : null,
        removed: known('removed') ? changes.totals.removed : null,
      },
    },
    detailGeneratedAt: detail.generatedAt,
  };
}

/** Read both jobs through injectable readers and emit one versioned JSON record. */
export async function runJobPairCompare(args: readonly string[], deps: Dependencies = {}): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const emit = (value: unknown) => write(`${JSON.stringify(value)}\n`);
  if (args.length === 1 && args[0] === '--help') { write(USAGE); return 0; }
  const options = parseArgs(args);
  if (!options) { emit({ schema: 'fleet.job-pair-compare.error.v1', error: 'invalid_arguments' }); return 2; }
  try {
    const detail = deps.readDetail ?? getFleetJobDetail;
    const changes = deps.readChanges ?? getFleetJobChanges;
    const [beforeDetail, beforeChanges, afterDetail, afterChanges] = await Promise.all([
      detail(options.before), changes(options.before), detail(options.after), changes(options.after),
    ]);
    const before = new Set(beforeChanges.files.map(file => file.path));
    const after = new Set(afterChanges.files.map(file => file.path));
    const display = (paths: string[]) => paths.map(path => redactHomePaths(scrubSecrets(path))).sort();
    emit({
      schema: 'fleet.job-pair-compare.v1',
      before: attempt(beforeDetail, beforeChanges), after: attempt(afterDetail, afterChanges),
      changedFiles: {
        complete: [beforeChanges, afterChanges].every(source => source.state === 'live' && !source.truncated),
        added: display([...after].filter(path => !before.has(path))),
        removed: display([...before].filter(path => !after.has(path))),
        common: display([...before].filter(path => after.has(path))),
      },
    });
    return 0;
  } catch {
    emit({ schema: 'fleet.job-pair-compare.error.v1', error: 'reader_unavailable' });
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runJobPairCompare(process.argv.slice(2));
}
