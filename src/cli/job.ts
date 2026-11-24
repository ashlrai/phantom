import { isAbsolute } from 'node:path';
import { isFleetJobId } from '../core/fleet/runs-job-detail.js';
import { getFleetJobCost, type FleetJobCostV1 } from '../core/fleet/runs-job-cost.js';
import { followFleetJobTail, getFleetJobTail, type FleetJobTailEvent } from '../core/fleet/runs-job-tail.js';
import { isJobControlAction, jobControlText, type JobControlAction } from '../core/fleet/job-control-types.js';
import { JOB_NOTE_MAX, jobNotesLines, jobSayText } from '../core/fleet/job-notes-types.js';
import { LANE_ID_RE } from '../core/fleet/runs-lane-targets.js';
import { STRAY_ID_PATTERN } from '../core/fleet/stray-slots.js';

const controlTail = 'pause|resume|stop|move <id> [--lane <lane>] [--dry-run] [--json] [--runs-dir <abs>]';
const controlUsage = `phm job ${controlTail}`;
const sayUsage = 'phm job say <id> "<text>" [--dry-run] [--json] [--runs-dir <abs>]';
const notesUsage = 'phm job notes <id> [--json] [--runs-dir <abs>]';
const sayHelp = `Send one note to a running job, e.g. phm job say <id> "also update the docs". Notes are timestamped and kept on the job; a worker reads new notes between steps where its runner supports it, and every note shows as "Notes sent" in the job window. A finished job refuses the note. Up to ${JOB_NOTE_MAX} characters. The same note twice in a row is sent once. --json emits fleet.job.say.v1 with status sent, refused or unknown. Exit 0 sent, 1 refused, unknown or unavailable, 2 bad usage. \`phm job notes <id>\` lists the notes sent (fleet.job.notes.v1).`;
const usage = `Usage: phm job cost <id> [--json] [--runs-dir <abs>] [--help]\n       phm job tail <id> [--lines N] [--follow] [--json] [--runs-dir <abs>] [--help]\n       phm job show <id> [--tail N] [--follow] [--json] [--runs-dir <abs>] [--help]\n       ${controlUsage}\n       ${sayUsage}\n       ${notesUsage}`;
const controlHelp = 'Steer one fleet job. move needs --lane and refuses a lane that is held or full. ' +
  'Repeating a request changes nothing and returns the first receipt. --json emits fleet.job.control.v1 ' +
  'with status requested, applied, refused or unknown. Exit 0 requested or applied, 1 refused, unknown or unavailable, 2 bad usage.';
const showHelp = 'Show one fleet job as one window: its state in plain words, its facts, then its last N log lines (1..200, default 40); --follow prints new lines while it runs.';
const tailHelp = 'Tail one fleet job: status, lane, model, start time and PR, then its newest ledger events and last N log lines (1..120, default 40), every line redacted. --follow streams new lines until the job finishes or Ctrl-C. --json prints one {ts, source, text} object per line (source log, event or status). Exit 1 when the job is unknown on this machine.';

/**
 * `phm job|jobs pause|resume|stop|move <id>`: one control request for one job
 * (core/fleet/job-control.ts), the same call the desktop job detail makes.
 */
export async function cmdJobControl(action: JobControlAction, rest: string[], noun: 'job' | 'jobs' = 'job'): Promise<number> {
  const usageLine = `phm ${noun} ${controlTail}`;
  const invalid = (extra?: string): number => {
    console.error(`${extra ? `${extra}\n` : ''}Usage: ${usageLine}`);
    return 2;
  };
  let job: string | undefined;
  let lane: string | undefined;
  let runsDir: string | undefined;
  const flags = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (flags.has(arg)) return invalid();
    if (arg === '--help' || arg === '-h') { console.log(`Usage: ${usageLine}\n${controlHelp}`); return 0; }
    if (arg === '--json' || arg === '--dry-run') flags.add(arg);
    else if (arg === '--lane' || arg === '--runs-dir') {
      flags.add(arg);
      const value = rest[++i];
      if (!value || value.startsWith('--')) return invalid();
      if (arg === '--lane') lane = value; else runsDir = value;
    } else if (job === undefined && !arg.startsWith('-') && STRAY_ID_PATTERN.test(arg)) job = arg;
    else return invalid();
  }
  if (!job || (runsDir !== undefined && !isAbsolute(runsDir))) return invalid();
  if (action === 'move' ? !lane || !LANE_ID_RE.test(lane) : lane !== undefined) {
    return invalid(action === 'move' ? 'move needs --lane <lane>' : `--lane only applies to move, not ${action}`);
  }
  try {
    const { requestJobControl } = await import('../core/fleet/job-control.js');
    const receipt = await requestJobControl({ action, job, lane, dryRun: flags.has('--dry-run') }, { runsDir, by: 'cli' });
    console.log(flags.has('--json') ? JSON.stringify(receipt) : jobControlText(receipt));
    return receipt.status === 'requested' || receipt.status === 'applied' ? 0 : 1;
  } catch {
    console.error('error: job control unavailable');
    return 1;
  }
}
/**
 * `phm job say <id> "<text>"` and `phm job notes <id>`: send a note to one job
 * and list the notes sent (core/fleet/job-notes.ts), the same calls the job
 * window's note box makes. The text is one argument; quote it.
 */
export async function cmdJobNote(verb: 'say' | 'notes', rest: string[]): Promise<number> {
  const say = verb === 'say';
  const usageLine = say ? sayUsage : notesUsage;
  const invalid = (extra?: string): number => {
    console.error(`${extra ? `${extra}\n` : ''}Usage: ${usageLine}`);
    return 2;
  };
  const positional: string[] = [];
  let runsDir: string | undefined;
  const flags = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--help' || arg === '-h') {
      console.log(say ? `Usage: ${sayUsage}\n${sayHelp}` : `Usage: ${notesUsage}\nList the notes sent to one job, oldest first (the newest 50). --json emits fleet.job.notes.v1. Exit 0 listed, 1 unreadable, 2 bad usage.`);
      return 0;
    }
    if (positional.length < (say ? 2 : 1) && !arg.startsWith('--')) { positional.push(arg); continue; }
    if (flags.has(arg)) return invalid();
    if (arg === '--json' || (say && arg === '--dry-run')) flags.add(arg);
    else if (arg === '--runs-dir') {
      flags.add(arg);
      const value = rest[++i];
      if (!value || value.startsWith('--')) return invalid();
      runsDir = value;
    } else return invalid();
  }
  const [job, noteText] = positional;
  if (!job || !STRAY_ID_PATTERN.test(job) || (say && noteText === undefined)) return invalid(say && job && noteText === undefined ? 'Say what? Put the note in quotes.' : undefined);
  if (runsDir !== undefined && !isAbsolute(runsDir)) return invalid();
  const json = flags.has('--json');
  try {
    if (!say) {
      const { readJobNotes } = await import('../core/fleet/job-notes.js');
      const notes = await readJobNotes(job, { runsDir });
      if (json) console.log(JSON.stringify(notes));
      else if (notes.count === 0) console.log(`No notes sent to ${job}.`);
      else console.log([`Notes sent to ${job} (${notes.count}):`, ...jobNotesLines(notes.notes).map((line) => `  ${line}`)].join('\n'));
      return 0;
    }
    const { sayToJob } = await import('../core/fleet/job-notes.js');
    const receipt = await sayToJob(job, noteText!, { runsDir, by: 'cli', dryRun: flags.has('--dry-run') });
    console.log(json ? JSON.stringify(receipt) : jobSayText(receipt));
    return receipt.status === 'sent' ? 0 : 1;
  } catch (error) {
    if (error instanceof TypeError) return invalid(error.message.charAt(0).toUpperCase() + error.message.slice(1) + '.');
    console.error(`error: job ${say ? 'note' : 'notes'} unavailable`);
    return 1;
  }
}
const sessionTailUsage = 'Usage: phm sessions tail <id> [--follow] [--lines N] [--json] [--runs-dir <abs>]';
const sessionTailHelp = 'What one session is doing now: lane, model, start and PR, then its last N log lines (1..200, default 200), every line redacted. --follow streams new lines until it finishes or Ctrl-C. --json prints one {ts, source, text} object per line; the first also carries detail (lane, model, repo, tokens, PR) and controls (can it be paused, stopped or moved, and why not). The id is the job id `phm sessions` shows. Exit 2 when the id is unknown on this computer.';
const text = (v: number | string | null): string => v === null ? 'unknown' : String(v);
const money = (v: number | null): string => v === null ? 'unknown' : `$${v.toFixed(4)}`;

function formatCost(job: FleetJobCostV1): string {
  const { totals } = job;
  const priced = `${totals.reported.costUsd}/${totals.calls}`;
  const lines = [
    `Job ${job.job}: ${totals.calls} ${totals.calls === 1 ? 'call' : 'calls'}, ` +
      `${text(totals.inputTokens)} in / ${text(totals.outputTokens)} out, cost ${money(totals.costUsd)}` +
      (totals.calls > 0 && totals.reported.costUsd < totals.calls ? ` (priced ${priced})` : '') +
      (totals.errors > 0 ? `, ${totals.errors} errored` : ''),
  ];
  for (const call of job.calls) {
    lines.push(
      `  ${call.at ?? 'unknown'}  ${call.model ?? 'unknown'}  ` +
      `${text(call.inputTokens)}→${text(call.outputTokens)}  ${money(call.costUsd)}` +
      `${call.estimated ? ' (estimated)' : ''}${call.error ? ' [error]' : ''}`,
    );
  }
  if (job.jobTotals.finishes > 0) {
    lines.push(`Worker-reported tokens_total over ${job.jobTotals.finishes} finish ${job.jobTotals.finishes === 1 ? 'event' : 'events'}: ${text(job.jobTotals.tokensTotal)}`);
  }
  if (job.sources.apiSpend === 'missing' && job.sources.jobs === 'missing') {
    lines.push('No cost evidence recorded for this job.');
  } else if (job.calls.length === 0) {
    lines.push('No recorded model calls for this job.');
  }
  if (job.truncated) lines.push('Earlier rows may exist beyond the read window.');
  return lines.join('\n');
}

/**
 * `phm job cost <id>` — per-model-call cost breakdown for one fleet job
 * (fleet.job.cost.v1); `phm job pause|resume|stop|move` steers one (above). Reads the host's metrics ledgers; never fabricates:
 * a field with no evidence is null in --json and 'unknown' in text.
 * Exit codes: 0 ok, 1 read failure, 2 bad usage.
 */
export async function cmdJob(args: string[]): Promise<number> {
  const invalid = (extra?: string): number => {
    console.error(extra ? `${extra}\n${usage}` : usage);
    return 2;
  };
  const [verb, ...rest] = args;
  if (verb === undefined || verb === '--help' || verb === '-h' || verb === 'help') {
    console.log(`${usage}\nPer-model-call cost for a fleet job: tokens in/out, model and cost (or 'unknown'), from the runs metrics ledgers. --json emits fleet.job.cost.v1.\n${tailHelp}\n${showHelp}\n${controlHelp}\n${sayHelp}`);
    return 0;
  }
  if (verb === 'tail') return cmdJobTail(rest);
  if (verb === 'show') return (await import('./job-show.js')).cmdJobShow(rest);
  if (isJobControlAction(verb)) return cmdJobControl(verb, rest);
  if (verb === 'say' || verb === 'notes') return cmdJobNote(verb, rest);
  if (verb !== 'cost') return invalid(`unknown job command: ${verb}`);
  let id: string | undefined;
  let json = false;
  let runsDir: string | undefined;
  const seen = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json') {
      if (seen.has('--json')) return invalid();
      seen.add('--json'); json = true;
    } else if (arg === '--runs-dir') {
      if (seen.has('--runs-dir')) return invalid();
      seen.add('--runs-dir');
      const dir = rest[++i];
      if (!dir || dir.startsWith('--') || !isAbsolute(dir)) return invalid();
      runsDir = dir;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`${usage}\nPer-model-call cost for a fleet job: tokens in/out, model and cost (or 'unknown'), from the runs metrics ledgers. --json emits fleet.job.cost.v1.`);
      return 0;
    } else if (!id && !arg.startsWith('-') && isFleetJobId(arg)) {
      id = arg;
    } else {
      return invalid();
    }
  }
  if (!id) return invalid();
  try {
    const job = await getFleetJobCost(id, runsDir === undefined ? {} : { runsDir });
    console.log(json ? JSON.stringify(job) : formatCost(job));
    return 0;
  } catch {
    console.error('error: job cost unavailable');
    return 1;
  }
}

export interface JobTailDeps {
  snapshot?: typeof getFleetJobTail;
  follow?: typeof followFleetJobTail;
  out?: (line: string) => void;
  err?: (line: string) => void;
  signal?: AbortSignal;
  intervalMs?: number;
}

/**
 * `phm job tail <id>` — the CLI face of fleet.job.tail.v1, the same reads the
 * desktop worker-log pane uses. Exit codes: 0 ok (running, finished or no log
 * yet), 1 unknown job or read failure, 2 bad usage.
 *
 * `phm sessions tail <id>` is the same stream in 'session' mode: up to 200
 * lines (the default), an unknown id is a plain error with exit 2, and the
 * JSON status line also carries `detail` and `controls`.
 */
export async function cmdJobTail(args: string[], deps: JobTailDeps = {}, mode: 'job' | 'session' = 'job'): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const session = mode === 'session';
  const maxLines = session ? 200 : 120;
  const invalid = (): number => { err(session ? sessionTailUsage : usage); return 2; };
  let id: string | undefined;
  let lines: number | undefined;
  let runsDir: string | undefined;
  const flags = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') { out(session ? `${sessionTailUsage}\n${sessionTailHelp}` : `${usage}\n${tailHelp}`); return 0; }
    if (arg.startsWith('--') && flags.has(arg)) return invalid();
    flags.add(arg);
    if (arg === '--json' || arg === '--follow') continue;
    if (arg === '--lines') {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1 || n > maxLines) return invalid();
      lines = n;
    } else if (arg === '--runs-dir') {
      const dir = args[++i];
      if (!dir || !isAbsolute(dir)) return invalid();
      runsDir = dir;
    } else if (!id && isFleetJobId(arg)) {
      id = arg;
    } else return invalid();
  }
  if (!id) return invalid();
  const json = flags.has('--json');
  const print = (e: FleetJobTailEvent): void => {
    if (json) out(JSON.stringify(e));
    else out(e.source === 'log' ? e.text : `${e.source === 'event' ? `[event${e.ts ? ` ${e.ts}` : ''}]` : '»'} ${e.text}`);
  };
  try {
    if (session) lines ??= maxLines;
    const tail = await (deps.snapshot ?? getFleetJobTail)(id, { ...(runsDir ? { runsDir } : {}), ...(lines ? { lines } : {}) });
    if (session && tail.status === 'unknown') { err(`No session ${id} on this computer. See: phm sessions`); return 2; }
    const head = tail.message ? `${tail.headline}\n${tail.message}` : tail.headline;
    if (json) out(JSON.stringify({ ts: tail.generatedAt, source: 'status', text: head, status: tail.status, ...(session ? { detail: tail.detail, controls: tail.controls } : {}) }));
    else out(head);
    if (tail.truncated && !json) out('… earlier lines not shown');
    for (const event of tail.events) print(event);
    if (tail.status === 'unknown') return 1;
    if (!flags.has('--follow') || tail.status === 'finished') return 0;
    const controller = new AbortController();
    const stop = () => controller.abort();
    deps.signal?.addEventListener('abort', stop, { once: true });
    if (!deps.signal) process.once('SIGINT', stop);
    try {
      await (deps.follow ?? followFleetJobTail)(id, tail.cursor, {
        ...(runsDir ? { runsDir } : {}), signal: controller.signal, onEvent: print,
        ...(deps.intervalMs ? { intervalMs: deps.intervalMs } : {}),
      });
    } finally {
      deps.signal?.removeEventListener('abort', stop);
      process.removeListener('SIGINT', stop);
    }
    return 0;
  } catch {
    err(session ? 'error: session tail unavailable' : 'error: job tail unavailable');
    return 1;
  }
}
