import { getFleetJobDetail, isFleetJobId, type FleetJobDetailV1 } from '../core/fleet/runs-job-detail.js';
import { getFleetJobChanges, type FleetJobChangesV1 } from '../core/fleet/runs-job-changes.js';
import { getFleetJobText } from '../core/fleet/runs-job-texts.js';

interface Readers {
  detail: typeof getFleetJobDetail;
  changes: typeof getFleetJobChanges;
  text?: typeof getFleetJobText;
  output?: { log: (text: string) => void; stdout: (text: string) => void; stderr: (text: string) => void };
}

const readers: Readers = { detail: getFleetJobDetail, changes: getFleetJobChanges, text: getFleetJobText };
const usage = 'Usage: phm fleet job <id> [--json] [--changes | --log [--tail-lines N] [--log-find literal [--context-lines N]] | --prompt | --notes] [--help]';
const value = (v: string | number | null): string => v === null ? 'unknown' : String(v);

function searchTail(tail: string[], literal: string, context: number): { tail: string[]; matchCount: number; scannedLines: number } {
  const included = new Set<number>();
  let matchCount = 0;
  for (let i = 0; i < tail.length; i++) {
    if (!tail[i]!.includes(literal)) continue;
    matchCount++;
    for (let j = Math.max(0, i - context); j <= Math.min(tail.length - 1, i + context); j++) included.add(j);
  }
  return { tail: tail.filter((_, i) => included.has(i)), matchCount, scannedLines: tail.length };
}

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
  const output = deps.output ?? {
    log: (text: string) => console.log(text),
    stdout: (text: string) => { process.stdout.write(text); },
    stderr: (text: string) => { process.stderr.write(text); },
  };
  const invalid = (): number => {
    output.stderr(`error: invalid fleet job arguments\n${usage}\n`);
    return 2;
  };
  let id: string | undefined;
  let maxTailLines: number | undefined;
  let literal: string | undefined;
  let context = 0;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const flag = arg === '-h' ? '--help' : arg;
    if (flag === '--log-find' || flag.startsWith('--log-find=')) {
      if (seen.has('--log-find')) return invalid();
      seen.add('--log-find');
      const inline = flag.startsWith('--log-find=');
      literal = inline ? flag.slice('--log-find='.length) : args[++i];
      if (!literal || (!inline && ['--json', '--changes', '--log', '--prompt', '--notes', '--help', '-h', '--tail-lines', '--log-find', '--context-lines'].includes(literal))) return invalid();
    } else if (flag === '--context-lines') {
      if (seen.has(flag)) return invalid();
      seen.add(flag);
      const count = args[++i];
      if (!count || /[^0-9]/.test(count)) return invalid();
      context = Number(count);
      if (!Number.isSafeInteger(context) || context > 10) return invalid();
    } else if (flag === '--tail-lines') {
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
  if (seen.has('--log-find') && !seen.has('--log')) return invalid();
  if (seen.has('--context-lines') && !seen.has('--log-find')) return invalid();
  if (seen.has('--help')) {
    output.log(`${usage}\nReads host run artifacts; --changes reads the bounded worktree change projection; --log reads the scrubbed log tail; --prompt and --notes read scrubbed worker artifacts. --tail-lines accepts 1..120 with --log. --log-find searches that tail for case-sensitive literal text; use --log-find=<literal> for a flag as the literal. --context-lines accepts 0..10 with --log-find.\nAgent example: phm fleet job JOB1 --log --tail-lines 10 --json`);
    return 0;
  }
  if (!id) return invalid();
  try {
    if (seen.has('--prompt') || seen.has('--notes')) {
      const kind = seen.has('--prompt') ? 'prompt' : 'notes';
      const artifact = await (deps.text ?? getFleetJobText)(id, kind);
      if (seen.has('--json')) {
        output.log(JSON.stringify(artifact));
      } else {
        if (artifact.text) output.stdout(artifact.text.endsWith('\n') ? artifact.text : `${artifact.text}\n`);
        output.stderr(`${kind}: ${artifact.state}; truncated: ${artifact.truncated ? 'yes' : 'no'}\n`);
      }
      return artifact.state === 'ok' ? 0 : 1;
    } else if (seen.has('--changes')) {
      const job = await deps.changes(id);
      output.log(seen.has('--json') ? JSON.stringify(job) : formatChanges(job));
    } else {
      const job = maxTailLines === undefined ? await deps.detail(id) : await deps.detail(id, { maxTailLines });
      if (seen.has('--log')) {
        const search = literal === undefined ? undefined : searchTail(job.log.tail, literal, context);
        const log = search ? { ...job.log, tail: search.tail } : job.log;
        if (seen.has('--json')) {
          output.log(JSON.stringify({ schema: 'fleet.job.log.v1', job: job.job, generatedAt: job.generatedAt, log, sources: { log: job.sources.log }, ...(search ? { matchCount: search.matchCount, scannedLines: search.scannedLines } : {}) }));
        } else {
          if (log.tail.length) output.stdout(`${log.tail.join('\n')}\n`);
          output.stderr(`Log: ${job.log.source}; health: ${job.sources.log}; truncated: ${job.log.truncated ? 'yes' : 'no'}${search ? `; scrubbed tail search: ${search.matchCount} matching lines / ${search.scannedLines} scanned` : ''}\n`);
        }
      } else {
        output.log(seen.has('--json') ? JSON.stringify(job) : formatDetail(job));
      }
    }
    return 0;
  } catch {
    output.stderr('error: fleet job unavailable\n');
    return 1;
  }
}
