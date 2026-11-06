import { getFleetJobDetail, isFleetJobId, type FleetJobDetailV1 } from '../core/fleet/runs-job-detail.js';
import { getFleetJobText, type FleetJobTextV1 } from '../core/fleet/runs-job-texts.js';

const usage = 'Usage: phm fleet wait-jobs --job ID (repeatable, 1..32 distinct) --timeout-ms N [--interval-ms N] [--require-notes] --json';
type Outcome = 'published' | 'ended-without-publication' | 'timed-out' | 'unavailable' | 'interrupted';
interface NotesEvidence {
  state: 'not-checked' | 'missing' | 'empty' | 'ok' | 'unreadable';
  source: FleetJobTextV1['source'];
  bytes: number | null;
  truncated: boolean;
}
interface Row {
  job: string;
  state: 'pending' | 'published' | 'ended-without-publication' | 'unavailable';
  artifactState: FleetJobDetailV1['state'] | null;
  sources: FleetJobDetailV1['sources'] | null;
  prUrl: string | null;
  processLiveness: 'not-checked';
  notes?: NotesEvidence;
}
export interface FleetWaitJobsDeps {
  read?: (job: string, signal: AbortSignal) => Promise<FleetJobDetailV1>;
  readNotes?: (job: string, signal: AbortSignal) => Promise<FleetJobTextV1>;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  output?: (text: string) => void;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
  });
}

/** Bound the wait for a reader that cannot itself cancel filesystem I/O. */
function bounded<T>(read: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const stop = () => { signal.removeEventListener('abort', stop); resolve(undefined); };
    read.then(value => { signal.removeEventListener('abort', stop); resolve(value); },
      error => { signal.removeEventListener('abort', stop); reject(error); });
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
  });
}

export async function cmdFleetWaitJobs(args: string[], deps: FleetWaitJobsDeps = {}): Promise<number> {
  const output = deps.output ?? console.log;
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    output(`${usage}\nTimeout: 1..3600000 ms (required). Interval: 1000..60000 ms (default 5000). --require-notes waits for nonempty retained notes or body. Artifact evidence only; process liveness is not checked. No workers or queue state are changed.`);
    return 0;
  }
  const jobs: string[] = [];
  const seen = new Set<string>();
  let timeout: number | undefined;
  let interval = 5000;
  const invalid = () => { output(usage); return 2; };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag !== '--job' && seen.has(flag)) return invalid();
    seen.add(flag);
    if (flag === '--json' || flag === '--require-notes') continue;
    const value = args[++i];
    if (flag === '--job') {
      if (!value || !isFleetJobId(value) || jobs.includes(value) || jobs.length === 32) return invalid();
      jobs.push(value);
    } else if (flag === '--timeout-ms' || flag === '--interval-ms') {
      if (!value || !/^\d+$/.test(value)) return invalid();
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n < (flag === '--timeout-ms' ? 1 : 1000) || n > (flag === '--timeout-ms' ? 3600000 : 60000)) return invalid();
      if (flag === '--timeout-ms') timeout = n;
      else interval = n;
    } else return invalid();
  }
  if (!jobs.length || timeout === undefined || !seen.has('--json')) return invalid();
  const now = deps.now ?? (() => performance.now());
  const deadline = now() + timeout;
  const controller = new AbortController();
  const { signal } = controller;
  let outcome: Outcome | undefined;
  const stop = (reason: Outcome) => { if (!outcome) { outcome = reason; controller.abort(); } };
  const expire = () => stop('timed-out');
  const interrupt = () => stop(now() >= deadline ? 'timed-out' : 'interrupted');
  const check = () => { if (now() >= deadline) expire(); };
  const timer = setTimeout(expire, timeout);
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  deps.signal?.addEventListener('abort', interrupt, { once: true });
  if (deps.signal?.aborted) interrupt();
  const rows: Row[] = jobs.map(job => ({ job, state: 'pending', artifactState: null, sources: null, prUrl: null, processLiveness: 'not-checked' }));
  const read = deps.read ?? ((job: string) => getFleetJobDetail(job));
  const requireNotes = seen.has('--require-notes');
  if (requireNotes) for (const row of rows) row.notes = { state: 'not-checked', source: null, bytes: null, truncated: false };
  const readNotes = deps.readNotes ?? ((job: string) => getFleetJobText(job, 'notes'));
  try {
    while (!outcome) {
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, async () => {
        while (!outcome) {
          check();
          if (outcome || cursor >= rows.length) return;
          const row = rows[cursor++]!;
          if (row.state === 'published') continue;
          let readingNotes = false;
          try {
            const detail = await bounded(read(row.job, signal), signal);
            check();
            if (!detail || outcome) return;
            row.artifactState = detail.state;
            row.sources = detail.sources;
            row.prUrl = detail.publish?.prUrl ?? null;
            if (requireNotes) row.notes = { state: 'not-checked', source: null, bytes: null, truncated: false };
            // A stale publish from an earlier attempt must not release a join.
            if (detail.state === 'published' && detail.sources.publish === 'healthy' && row.prUrl && detail.publish?.testLine) {
              if (!requireNotes) row.state = 'published';
              else {
                readingNotes = true;
                const notes = await bounded(readNotes(row.job, signal), signal);
                check();
                if (!notes || outcome) return;
                const state = notes.state === 'ok' && !notes.text.trim() ? 'empty' : notes.state;
                row.notes = { state, source: notes.source, bytes: notes.bytes, truncated: notes.truncated };
                if (state === 'ok') row.state = 'published';
                else if (state === 'unreadable') row.state = 'unavailable';
              }
            }
            else if (detail.state === 'archived') row.state = 'ended-without-publication';
            else if (Object.values(detail.sources).includes('degraded')) row.state = 'unavailable';
            else if (detail.state === 'published') row.state = 'unavailable';
            if (row.state === 'ended-without-publication' || row.state === 'unavailable') stop(row.state);
          } catch {
            check();
            if (!outcome) {
              if (readingNotes) row.notes = { state: 'unreadable', source: null, bytes: null, truncated: false };
              row.state = 'unavailable'; stop('unavailable');
            }
          }
        }
      }));
      if (!outcome && rows.every(row => row.state === 'published')) stop('published');
      if (!outcome) {
        await bounded((deps.wait ?? wait)(Math.min(interval, Math.max(0, deadline - now())), signal), signal);
        check();
      }
    }
    output(JSON.stringify({ schema: 'fleet.wait-jobs.v1', outcome, jobs: rows }));
    return { published: 0, 'ended-without-publication': 1, 'timed-out': 3, unavailable: 4, interrupted: 130 }[outcome];
  } finally {
    controller.abort();
    clearTimeout(timer);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    deps.signal?.removeEventListener('abort', interrupt);
  }
}
