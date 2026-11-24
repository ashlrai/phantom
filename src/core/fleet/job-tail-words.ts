/**
 * job-tail-words.ts — the plain-words status of one fleet job, shared by
 * `phm job tail` (runs-job-tail.ts) and the desktop worker-log pane so both
 * surfaces say the same thing about the same `fleet.job.v1` detail.
 *
 * Pure and browser-safe: no node imports. Every input field is optional
 * because the desktop reads it off the wire from possibly older producers.
 */

export type JobTailStatus = 'unknown' | 'finished' | 'no-log' | 'live';

export interface JobWordsInput {
  job?: string | null;
  state?: string | null;
  lane?: string | null;
  model?: string | null;
  launchedAt?: string | null;
  publish?: { prUrl?: string | null } | null;
  log?: { source?: string | null; bytes?: number | null; tail?: readonly string[] | null } | null;
  sources?: Partial<Record<string, string | null>> | null;
}

export interface JobWords {
  status: JobTailStatus;
  /** One sentence for a human; null while a live log is the answer. */
  text: string | null;
  /** The log has lines worth showing (live, or a finished job's last output). */
  showLog: boolean;
}

function age(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} hr${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
}

/** No launch, metadata, publish or log evidence at all: this host never saw the job. */
function unknownJob(d: JobWordsInput): boolean {
  const seen = Object.values(d.sources ?? {}).some(s => s != null && s !== 'missing');
  const hasLog = d.log != null && d.log.source != null && d.log.source !== 'missing';
  return !seen && !hasLog && d.publish == null && !d.launchedAt && !d.lane && !d.model
    && (d.state == null || d.state === 'unknown');
}

export function describeJob(d: JobWordsInput, nowMs: number): JobWords {
  const name = d.job ? `Job ${d.job}` : 'This job';
  if (unknownJob(d)) {
    return { status: 'unknown', showLog: false, text: `${name} is unknown here: no launch, log or result is recorded on this machine.` };
  }
  const missing = !d.log || d.log.source == null || d.log.source === 'missing';
  const empty = !missing && d.log?.bytes === 0 && (d.log?.tail?.length ?? 0) === 0;
  const unreadable = d.sources?.['log'] === 'degraded' && (d.log?.tail?.length ?? 0) === 0;
  if (d.state === 'published' || d.state === 'archived') {
    const pr = d.publish?.prUrl ?? null;
    const result = d.state === 'published' ? (pr ? `published ${pr}` : 'published, no PR link recorded') : 'ended without publishing';
    if (unreadable) return { status: 'finished', showLog: false, text: `Log is unavailable on this machine. Result: ${result}.` };
    if (missing) return { status: 'finished', showLog: false, text: `This job ended without a log. Result: ${result}.` };
    return { status: 'finished', showLog: !empty, text: `${name} finished. Result: ${result}.` };
  }
  if (unreadable) return { status: 'no-log', showLog: false, text: 'Log is unavailable on this machine.' };
  if (d.state === 'running' && (missing || empty)) {
    const launched = d.launchedAt ? Date.parse(d.launchedAt) : NaN;
    if (d.lane === 'devin') {
      const elapsed = Number.isFinite(launched) ? ` (running ${age((nowMs - launched) / 1000)})` : '';
      return { status: 'no-log', showLog: false, text: `Devin writes its log when the job ends${elapsed}. Watch the PR link above instead.` };
    }
    return { status: 'no-log', showLog: false, text: empty ? 'Log is open but empty so far.' : 'No log yet.' };
  }
  if (missing || empty) return { status: 'no-log', showLog: false, text: 'No log yet.' };
  return { status: 'live', showLog: true, text: null };
}
