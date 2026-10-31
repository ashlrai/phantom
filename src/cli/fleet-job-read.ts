import { getFleetJobDetail, isFleetJobId, type FleetJobDetailV1 } from '../core/fleet/runs-job-detail.js';
import { getFleetJobChanges, type FleetJobChangesV1 } from '../core/fleet/runs-job-changes.js';
import { getFleetJobText } from '../core/fleet/runs-job-texts.js';

interface Readers {
  detail: typeof getFleetJobDetail;
  changes: typeof getFleetJobChanges;
  text?: typeof getFleetJobText;
  output?: { log: (text: string) => void; stdout: (text: string) => void; stderr: (text: string) => void };
}

interface WatchOptions {
  signal?: AbortSignal;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const readers: Readers = { detail: getFleetJobDetail, changes: getFleetJobChanges, text: getFleetJobText };
const usage = 'Usage: phm fleet job <id> [--json] [--require-published | --changes | --log [--tail-lines N] [--log-find literal [--context-lines N]] | --prompt | --notes] [--watch [--interval-ms N]] [--help]';
const value = (v: string | number | null): string => v === null ? 'unknown' : String(v);

const WATCH_INTERVAL_MIN_MS = 1000;
const WATCH_INTERVAL_MAX_MS = 60000;
const WATCH_INTERVAL_DEFAULT_MS = 5000;
const WATCH_DEAD_SNAPSHOT_LIMIT = 3;
const WATCH_FAILURE_LIMIT = 5;

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

function formatDetail(job: FleetJobDetailV1, tail: string[] = job.log.tail): string {
  return [
    `Fleet job ${job.job}: ${job.state} (artifact evidence; process liveness not checked)`,
    `Sources: ${Object.entries(job.sources).map(([name, state]) => `${name}=${state}`).join(' ')}`,
    `Lane: ${value(job.lane)}; tier: ${value(job.tier)}; model: ${value(job.model)}; pid: ${value(job.pid)}`,
    `Base: ${value(job.baseSha)}; branch: ${value(job.branch)}; launched: ${value(job.launchedAt)}`,
    `Publish: ${job.publish ? `PR ${value(job.publish.prUrl)}; ${value(job.publish.testLine)}` : 'no evidence'}`,
    `Log: ${job.log.source}${job.log.truncated ? ' (truncated)' : ''}`,
    ...tail,
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

function waitForTick(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** Tail lines of `current` appended since `previous` was emitted (longest suffix/prefix overlap). */
function freshTailLines(previous: string[], current: string[]): string[] {
  for (let overlap = Math.min(previous.length, current.length); overlap > 0; overlap--) {
    if (previous.slice(previous.length - overlap).join('\n') === current.slice(0, overlap).join('\n')) return current.slice(overlap);
  }
  return current;
}

/** A published result or an archived log without publish evidence ends the watch. */
function terminalReason(job: FleetJobDetailV1): string | null {
  if (job.state === 'published') return `job ${job.job} published${job.publish?.prUrl ? `; PR ${job.publish.prUrl}` : ''}`;
  if (job.state === 'archived') return `job ${job.job} ended without publish evidence (archived log)`;
  return null;
}

/** A live launch record or live log means the worker may still produce evidence. */
function hasLiveEvidence(job: FleetJobDetailV1): boolean {
  return job.state === 'running' || job.launchedAt !== null || job.log.source === 'live';
}

/** Read the host's existing job projections; no path options are accepted. */
export async function cmdFleetJobRead(args: string[], deps: Readers = readers, watch: WatchOptions = {}): Promise<number> {
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
  let intervalMs = WATCH_INTERVAL_DEFAULT_MS;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const flag = arg === '-h' ? '--help' : arg;
    if (flag === '--log-find' || flag.startsWith('--log-find=')) {
      if (seen.has('--log-find')) return invalid();
      seen.add('--log-find');
      const inline = flag.startsWith('--log-find=');
      literal = inline ? flag.slice('--log-find='.length) : args[++i];
      if (!literal || (!inline && ['--json', '--require-published', '--changes', '--log', '--prompt', '--notes', '--help', '-h', '--tail-lines', '--log-find', '--context-lines', '--watch', '--interval-ms'].includes(literal))) return invalid();
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
    } else if (flag === '--interval-ms') {
      if (seen.has(flag)) return invalid();
      seen.add(flag);
      const count = args[++i];
      if (!count || /[^0-9]/.test(count)) return invalid();
      intervalMs = Number(count);
      if (!Number.isSafeInteger(intervalMs) || intervalMs < WATCH_INTERVAL_MIN_MS || intervalMs > WATCH_INTERVAL_MAX_MS) return invalid();
    } else if (['--json', '--require-published', '--changes', '--log', '--prompt', '--notes', '--help', '--watch'].includes(flag)) {
      if (seen.has(flag)) return invalid();
      seen.add(flag);
    } else if (!id && isFleetJobId(arg)) {
      id = arg;
    } else {
      return invalid();
    }
  }
  if (['--changes', '--log', '--prompt', '--notes'].filter(flag => seen.has(flag)).length > 1) return invalid();
  if (seen.has('--require-published') && (!seen.has('--json') || ['--changes', '--log', '--prompt', '--notes'].some(flag => seen.has(flag)))) return invalid();
  if (seen.has('--tail-lines') && !seen.has('--log')) return invalid();
  if (seen.has('--log-find') && !seen.has('--log')) return invalid();
  if (seen.has('--context-lines') && !seen.has('--log-find')) return invalid();
  if (seen.has('--interval-ms') && !seen.has('--watch')) return invalid();
  if (seen.has('--watch') && ['--changes', '--prompt', '--notes', '--require-published'].some(flag => seen.has(flag))) return invalid();
  if (seen.has('--help')) {
    output.log(`${usage}\nReads host run artifacts; --changes reads the bounded worktree change projection; --log reads the scrubbed log tail; --prompt and --notes read scrubbed worker artifacts. --tail-lines accepts 1..120 with --log. --log-find searches that tail for case-sensitive literal text; use --log-find=<literal> for a flag as the literal. --context-lines accepts 0..10 with --log-find.\n--require-published requires --json and default detail mode. It adds a published handoff evidence check for a PR URL and test line; exit 1 if either is absent. This does not verify a merge or evidence freshness.\n--watch repeats the detail or --log read every --interval-ms (1000..60000, default 5000) until SIGINT/SIGTERM or a terminal state (published, ended without publish evidence, or no live evidence for 3 consecutive snapshots), then prints one line saying why it stopped. Text snapshots are headed --- <ISO time> snapshot N --- and show only newly appended tail lines; --json emits one object per snapshot, read errors emit fleet.job.error.v1, and 5 consecutive read failures exit 1. --watch cannot combine with --changes, --prompt, --notes or --require-published.\nAgent examples: phm fleet job JOB1 --log --tail-lines 10 --json; phm fleet job JOB1 --require-published --json; phm fleet job JOB1 --watch --interval-ms 2000`);
    return 0;
  }
  if (!id) return invalid();
  if (seen.has('--watch')) {
    const controller = new AbortController();
    const signal = controller.signal;
    const stop = () => controller.abort();
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    watch.signal?.addEventListener('abort', stop, { once: true });
    if (watch.signal?.aborted) stop();
    const json = seen.has('--json');
    let snapshots = 0;
    let deadSnapshots = 0;
    let failures = 0;
    let printedTail: string[] = [];
    let code = 0;
    let reason = 'interrupted';
    try {
      while (!signal.aborted) {
        let job: FleetJobDetailV1;
        try {
          job = maxTailLines === undefined ? await deps.detail(id) : await deps.detail(id, { maxTailLines });
        } catch (error) {
          if (signal.aborted) break;
          failures += 1;
          const message = error instanceof Error ? error.message : String(error);
          if (json) output.log(JSON.stringify({ schema: 'fleet.job.error.v1', job: id, at: new Date().toISOString(), error: message }));
          else output.stderr('error: fleet job unavailable\n');
          if (failures >= WATCH_FAILURE_LIMIT) { code = 1; reason = `${WATCH_FAILURE_LIMIT} consecutive read failures`; break; }
          if (!signal.aborted) await (watch.wait ?? waitForTick)(intervalMs, signal);
          continue;
        }
        if (signal.aborted) break;
        failures = 0;
        snapshots += 1;
        if (seen.has('--log')) {
          const search = literal === undefined ? undefined : searchTail(job.log.tail, literal, context);
          if (json) {
            const log = search ? { ...job.log, tail: search.tail } : job.log;
            output.log(JSON.stringify({ schema: 'fleet.job.log.v1', job: job.job, generatedAt: job.generatedAt, log, sources: { log: job.sources.log }, ...(search ? { matchCount: search.matchCount, scannedLines: search.scannedLines } : {}) }));
          } else {
            const fresh = search ? search.tail : freshTailLines(printedTail, job.log.tail);
            output.stdout(`--- ${job.generatedAt} snapshot ${snapshots} ---\n`);
            if (fresh.length) output.stdout(`${fresh.join('\n')}\n`);
            output.stderr(`Log: ${job.log.source}; health: ${job.sources.log}; truncated: ${job.log.truncated ? 'yes' : 'no'}${search ? `; scrubbed tail search: ${search.matchCount} matching lines / ${search.scannedLines} scanned` : ''}\n`);
          }
        } else if (json) {
          output.log(JSON.stringify(job));
        } else {
          output.log(`--- ${job.generatedAt} snapshot ${snapshots} ---\n${formatDetail(job, freshTailLines(printedTail, job.log.tail))}`);
        }
        printedTail = job.log.tail;
        const terminal = terminalReason(job);
        if (terminal) { reason = terminal; break; }
        deadSnapshots = hasLiveEvidence(job) ? 0 : deadSnapshots + 1;
        if (deadSnapshots >= WATCH_DEAD_SNAPSHOT_LIMIT) { reason = `no live evidence for ${WATCH_DEAD_SNAPSHOT_LIMIT} consecutive snapshots`; break; }
        if (!signal.aborted) await (watch.wait ?? waitForTick)(intervalMs, signal);
      }
      if (json) output.log(JSON.stringify({ schema: 'fleet.job.watch.stop.v1', job: id, at: new Date().toISOString(), snapshots, reason }));
      else output.log(`watch stopped: ${reason}`);
      return code;
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      watch.signal?.removeEventListener('abort', stop);
    }
  }
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
        if (seen.has('--require-published')) {
          const hasPrUrl = Boolean(job.publish?.prUrl?.trim());
          const hasTestLine = Boolean(job.publish?.testLine?.trim());
          const check = { kind: 'published_handoff_evidence', ok: hasPrUrl && hasTestLine, hasPrUrl, hasTestLine };
          output.log(JSON.stringify({ ...job, check }));
          return check.ok ? 0 : 1;
        }
        output.log(seen.has('--json') ? JSON.stringify(job) : formatDetail(job));
      }
    }
    return 0;
  } catch {
    output.stderr('error: fleet job unavailable\n');
    return 1;
  }
}
