import { getFleetJobDetail, isFleetJobId, type FleetJobDetailV1 } from '../core/fleet/runs-job-detail.js';
import { getFleetJobChanges, type FleetJobChangesV1 } from '../core/fleet/runs-job-changes.js';

interface Readers {
  detail: typeof getFleetJobDetail;
  changes: typeof getFleetJobChanges;
}

const readers: Readers = { detail: getFleetJobDetail, changes: getFleetJobChanges };
const usage = 'Usage: phm fleet job <id> [--json] [--changes | --log] [--help]';
const value = (v: string | number | null): string => v === null ? 'unknown' : String(v);

function formatDetail(job: FleetJobDetailV1): string {
  return [
    `Fleet job ${job.job}: ${job.state} (artifact evidence; process liveness not checked)`,
    `Sources: ${Object.entries(job.sources).map(([name, state]) => `${name}=${state}`).join(' ')}`,
    `Lane: ${value(job.lane)}; tier: ${value(job.tier)}; model: ${value(job.model)}; pid: ${value(job.pid)}`,
    `Base: ${value(job.baseSha)}; branch: ${value(job.branch)}; launched: ${value(job.launchedAt)}`,
    `Publish: ${job.publish ? `PR ${value(job.publish.prUrl)}; ${value(job.publish.testLine)}` : 'no evidence'}`,
    `Log: ${job.log.source}${job.log.truncated ? ' (truncated)' : ''}`,
    ...job.log.tail,
  ].join('\n');
}

function formatChanges(job: FleetJobChangesV1): string {
  return [
    `Fleet job ${job.job} changes: ${job.state}`,
    `Base: ${job.comparisonBase ?? value(job.baseSha)}; files: ${job.totals.files}; +${job.totals.added} -${job.totals.removed}${job.truncated ? '; truncated' : ''}`,
    ...(job.state === 'missing' ? ['Worktree evidence unavailable.'] : []),
    ...job.files.map(file => `${file.status} ${file.path} (+${value(file.added)} -${value(file.removed)})`),
  ].join('\n');
}

/** Read the host's existing job projections; no path options are accepted. */
export async function cmdFleetJobRead(args: string[], deps: Readers = readers): Promise<number> {
  let id: string | undefined;
  const seen = new Set<string>();
  for (const arg of args) {
    const flag = arg === '-h' ? '--help' : arg;
    if (['--json', '--changes', '--log', '--help'].includes(flag)) {
      if (seen.has(flag)) return invalid();
      seen.add(flag);
    } else if (!id && isFleetJobId(arg)) {
      id = arg;
    } else {
      return invalid();
    }
  }
  if (seen.has('--log') && seen.has('--changes')) return invalid();
  if (seen.has('--help')) {
    console.log(`${usage}\nReads host run artifacts; --changes reads the bounded worktree change projection; --log reads the scrubbed log tail.`);
    return 0;
  }
  if (!id) return invalid();
  try {
    if (seen.has('--changes')) {
      const job = await deps.changes(id);
      console.log(seen.has('--json') ? JSON.stringify(job) : formatChanges(job));
    } else {
      const job = await deps.detail(id);
      if (seen.has('--log')) {
        if (seen.has('--json')) {
          console.log(JSON.stringify({ schema: 'fleet.job.log.v1', job: job.job, generatedAt: job.generatedAt, log: job.log, sources: { log: job.sources.log } }));
        } else {
          if (job.log.tail.length) process.stdout.write(`${job.log.tail.join('\n')}\n`);
          process.stderr.write(`Log: ${job.log.source}; health: ${job.sources.log}; truncated: ${job.log.truncated ? 'yes' : 'no'}\n`);
        }
      } else {
        console.log(seen.has('--json') ? JSON.stringify(job) : formatDetail(job));
      }
    }
    return 0;
  } catch {
    process.stderr.write('error: fleet job unavailable\n');
    return 1;
  }
}

function invalid(): number {
  process.stderr.write(`error: invalid fleet job arguments\n${usage}\n`);
  return 2;
}
