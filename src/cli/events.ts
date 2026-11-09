/**
 * cli/events.ts — `phm events`: event-sourced per-job run state
 * (RQ-SWE5-EVENT-LOG; core: src/core/events/run-event-log.ts).
 *
 * Thin dispatcher: parse argv, delegate to the core module, print.
 * Reads never lock; appends hold <job>.events.lock under runsDir.
 */

import { parseArgs } from 'node:util';
import {
  appendRunEvent,
  forkRun,
  isRunEventJobId,
  moveRunHead,
  readRunEventLog,
  replayRunState,
  runBranches,
  runEventLogPath,
  runHead,
  RunEventLogError,
  RUN_EVENT_KINDS,
  type RunEvent,
} from '../core/events/run-event-log.js';

const HELP = `Usage: phm events <command> <job> [options]

Event-sourced run state: one append-only <runs-dir>/<job>.events.jsonl per
dispatched job; history is a tree with a movable head so runs can fork,
seek and replay without rewriting records.

  list <job> [--branch <b>]         events in append order (optionally one branch)
  head <job>                      current append position (event id + branch)
  branches <job>                  branch labels with tip and depth
  replay <job> [--at <event>]     fold the head path into a run-state view
  append <job> --kind <k> [--data <json>] [--at <iso>]
                                  record launch/tool-call/tool-result/
                                  checkpoint/note/finish/publish
  note <job> <text...>            record a note event
  checkout <job> --at <event> [--reason <text>]
                                  move the head to an existing event
  fork <job> --at <event> [--branch <name>] [--reason <text>]
                                  move the head to an event under a new branch

Options: --runs-dir <absolute> (default ~/.ashlr-runs) --json --help
checkpoint events require data.ref; replay surfaces the newest checkpoint
on the head path as the resume point (see docs/RUN-EVENT-LOG.md).`;

const KINDS = RUN_EVENT_KINDS.filter(k => k !== 'head');
const VALUE_OPTIONS = [
  'kind', 'data', 'at', 'branch', 'reason', 'runs-dir',
] as const;

interface Parsed {
  command: string | undefined;
  positionals: string[];
  values: Record<string, string | boolean | (string | boolean)[] | undefined>;
  json: boolean;
}

function parse(args: string[]): Parsed | { error: string } {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      options: {
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        ...Object.fromEntries(VALUE_OPTIONS.map(k => [k, { type: 'string' as const }])),
      },
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Invalid arguments' };
  }
  return {
    command: parsed.positionals[0],
    positionals: parsed.positionals.slice(1),
    values: parsed.values,
    json: parsed.values.json === true,
  };
}

function renderEvent(event: RunEvent): string {
  const summary = event.kind === 'head'
    ? `-> ${String(event.data.event)}${event.data.branch ? ` [${String(event.data.branch)}]` : ''}`
    : Object.entries(event.data).slice(0, 3).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ');
  return `${String(event.seq).padStart(4)} ${event.id} ${event.branch.padEnd(12)} ${(event.parent ?? '-').padEnd(6)} ${event.kind.padEnd(12)} ${event.at} ${summary}`.trimEnd();
}

function out(value: unknown, json: boolean): void {
  if (json || typeof value !== 'string') console.log(JSON.stringify(value, null, json ? undefined : 2));
  else console.log(value);
}

export async function cmdEvents(args: string[]): Promise<number> {
  const parsed = parse(args);
  if ('error' in parsed) { console.error(`${parsed.error}\n${HELP}`); return 2; }
  const { command, positionals, values, json } = parsed;
  if (!command || values.help === true || command === 'help') { console.log(HELP); return 0; }

  const runsDir = typeof values['runs-dir'] === 'string' ? values['runs-dir'] : undefined;
  // `--at` is the event timestamp on append and the target event on
  // checkout/fork/replay — only thread it into append options.
  const options = { runsDir, at: typeof values.at === 'string' ? values.at : undefined };
  const navOptions = { runsDir };
  const job = positionals[0];

  const usage = (message: string): number => { console.error(`${message}\n${HELP}`); return 2; };
  const fail = (error: unknown): number => {
    const message = error instanceof RunEventLogError ? error.message
      : error instanceof Error ? error.message : 'Event log operation failed';
    if (json) console.log(JSON.stringify({ error: message, code: error instanceof RunEventLogError ? error.code : 'error' }));
    else console.error(message);
    return error instanceof RunEventLogError && error.code === 'busy' ? 3 : 1;
  };

  if (!['list', 'head', 'branches', 'replay', 'append', 'note', 'checkout', 'fork'].includes(command)) {
    return usage(`Unknown events command: ${command}`);
  }
  if (!job || !isRunEventJobId(job)) return usage('A valid <job> id is required');

  try {
    switch (command) {
      case 'list': {
        const read = await readRunEventLog(job, options);
        const branch = typeof values.branch === 'string' ? values.branch : undefined;
        const events = branch ? read.events.filter(e => e.branch === branch) : read.events;
        if (json) out({ job, path: runEventLogPath(job, runsDir), head: runHead(read.events), deferred: read.deferred, events }, true);
        else if (!events.length) console.log(`No events for ${job}.`);
        else {
          console.log(`seq  id    branch        parent kind         at                summary`);
          for (const event of events) console.log(renderEvent(event));
          if (read.deferred) console.log('(deferred: torn trailing line ignored)');
        }
        return 0;
      }
      case 'head': {
        const read = await readRunEventLog(job, options);
        const head = runHead(read.events);
        if (json) out({ job, ...head, deferred: read.deferred }, true);
        else console.log(head.id ? `${head.id} (${head.branch})` : `empty log; next event roots branch '${head.branch}'`);
        return 0;
      }
      case 'branches': {
        const read = await readRunEventLog(job, options);
        const branches = runBranches(read.events);
        if (json) out({ job, branches }, true);
        else if (!branches.length) console.log(`No branches for ${job}.`);
        else for (const b of branches) console.log(`${b.name}\ttip=${b.tip}\tdepth=${b.depth}`);
        return 0;
      }
      case 'replay': {
        const read = await readRunEventLog(job, navOptions);
        const view = replayRunState(job, read, { at: typeof values.at === 'string' ? values.at : undefined });
        if (json) out(view, true);
        else {
          console.log(`job=${view.job} phase=${view.phase} head=${view.head?.id ?? '-'} branch=${view.head?.branch ?? '-'}`);
          console.log(`path: ${view.path.length ? view.path.join(' -> ') : '(empty)'}`);
          for (const [kind, count] of Object.entries(view.counts)) if (count) console.log(`  ${kind}: ${count}`);
          if (view.checkpoint) console.log(`checkpoint: ${view.checkpoint.ref} (${view.checkpoint.eventId})`);
          if (view.publish) console.log(`publish: ${JSON.stringify(view.publish)}`);
          if (view.finish) console.log(`finish: ${JSON.stringify(view.finish)}`);
        }
        return 0;
      }
      case 'append': {
        const kind = values.kind;
        if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) {
          return usage(`Required: --kind <${KINDS.join('|')}>`);
        }
        let data: Record<string, unknown> = {};
        if (values.data !== undefined) {
          if (typeof values.data !== 'string') return usage('Invalid --data');
          try {
            const value: unknown = JSON.parse(values.data);
            if (!value || typeof value !== 'object' || Array.isArray(value)) return usage('--data must be a JSON object');
            data = value as Record<string, unknown>;
          } catch { return usage('--data must be valid JSON'); }
        }
        const event = await appendRunEvent(job, kind as Exclude<RunEvent['kind'], 'head'>, data, options);
        out(json ? event : `recorded ${event.id} ${event.kind} on ${event.branch} (parent ${event.parent ?? '-'})`, json);
        return 0;
      }
      case 'note': {
        const text = positionals.slice(1).join(' ').trim();
        if (!text) return usage('note requires text');
        const event = await appendRunEvent(job, 'note', { text }, options);
        out(json ? event : `recorded ${event.id} note on ${event.branch}`, json);
        return 0;
      }
      case 'checkout': {
        const target = values.at;
        if (typeof target !== 'string') return usage('Required: --at <event>');
        const event = await moveRunHead(job, target, {
          ...navOptions, reason: typeof values.reason === 'string' ? values.reason : undefined,
        });
        const read = await readRunEventLog(job, navOptions);
        const head = runHead(read.events);
        out(json ? { recorded: event, head } : `head -> ${head.id} (${head.branch})`, json);
        return 0;
      }
      case 'fork': {
        const target = values.at;
        if (typeof target !== 'string') return usage('Required: --at <event>');
        const event = await forkRun(job, target, {
          ...navOptions,
          branch: typeof values.branch === 'string' ? values.branch : undefined,
          reason: typeof values.reason === 'string' ? values.reason : undefined,
        });
        const read = await readRunEventLog(job, navOptions);
        const head = runHead(read.events);
        out(json ? { recorded: event, head } : `head -> ${head.id} (${head.branch})`, json);
        return 0;
      }
    }
    return 2;
  } catch (error) {
    return fail(error);
  }
}
