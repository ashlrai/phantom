import { getFleetJobDetail, isFleetJobId, type FleetJobDetailV1 } from '../core/fleet/runs-job-detail.js';
import { getFleetJobChanges, type FleetJobChangesV1 } from '../core/fleet/runs-job-changes.js';
import { getFleetJobText } from '../core/fleet/runs-job-texts.js';

interface Readers {
  detail: typeof getFleetJobDetail;
  changes: typeof getFleetJobChanges;
  text?: typeof getFleetJobText;
}

const readers: Readers = { detail: getFleetJobDetail, changes: getFleetJobChanges, text: getFleetJobText };
const usage = 'Usage: phm fleet job <id> [--json] [--changes | --log [--tail-lines N] | --prompt | --notes] [--help]';
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
  let maxTailLines: number | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const flag = arg === '-h' ? '--help' : arg;
    if (flag === '--tail-lines') {
      if (seen.has(flag)) return invalid();
      seen.add(flag);
      const count = args[++i];
      if (!count || /[^0-9]/.test(count)) return invalid();
      maxTailLines = Number(count);
      if (!Number.isSafeInteger(maxTailLines) || maxTailLines < 1 || maxTailLines > 120) return invalid();
    } else if (['--json', '--changes', '--log', '--prompt', '--notes', '--help'].includes(flag)) {
      if (seen.has(flag)) return invalid();
      seen.add(flag);
    } else if (!id && isFleetJobId(arg)) {
      id = arg;
    } else {
      return invalid();
    }
  }
  if (['--changes', '--log', '--prompt', '--notes'].filter(flag => seen.has(flag)).length > 1) return invalid();
  if (seen.has('--tail-lines') && !seen.has('--log')) return invalid();
  if (seen.has('--help')) {
    console.log(`${usage}\nReads host run artifacts; --changes reads the bounded worktree change projection; --log reads the scrubbed log tail; --prompt and --notes read scrubbed worker artifacts. --tail-lines accepts 1..120 with --log.\nAgent example: phm fleet job JOB1 --log --tail-lines 10 --json`);
    return 0;
  }
  if (!id) return invalid();
  try {
    if (seen.has('--prompt') || seen.has('--notes')) {
      const kind = seen.has('--prompt') ? 'prompt' : 'notes';
      const artifact = await (deps.text ?? getFleetJobText)(id, kind);
      if (seen.has('--json')) {
        console.log(JSON.stringify(artifact));
      } else {
        if (artifact.text) process.stdout.write(artifact.text.endsWith('\n') ? artifact.text : `${artifact.text}\n`);
        process.stderr.write(`${kind}: ${artifact.state}; truncated: ${artifact.truncated ? 'yes' : 'no'}\n`);
      }
      return artifact.state === 'ok' ? 0 : 1;
    } else if (seen.has('--changes')) {
      const job = await deps.changes(id);
      console.log(seen.has('--json') ? JSON.stringify(job) : formatChanges(job));
    } else {
      const job = maxTailLines === undefined ? await deps.detail(id) : await deps.detail(id, { maxTailLines });
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
