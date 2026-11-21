/**
 * routes/verse/leader-thread/command-arg-model.ts: the pure half of the
 * picker that fills in a typed command's argument in the Leader reply box.
 * After `/release ` it offers the lanes that are held, after `/hold ` every
 * lane and then a few lengths of hold, after `/lane ` every lane, after
 * `/stop ` the jobs running now, after `/log `, `/thread ` and
 * `/summary ` the sessions in the session list, after `/app ` the Mac apps
 * Phantom can open, and after `/open ` the panes.
 *
 * Each list is built from the read the matching pane already makes (lane
 * targets, live sessions, the Mac host's app list, the pane registry), so the
 * picker offers what the command would accept and nothing else. Nothing is
 * invented: a lane record that is not healthy says so, and an app whose state
 * was not read keeps the words the Apps card uses for it.
 */
import { flatTree, spoke, type LiveSessionsV1 } from '../../../../core/fleet/live-sessions.js';
import type { MacAppsReport } from '../../../../core/apps-known.js';
import { validJob } from '../fleet/workers-card-model.js';
import { STATE_WORD } from '../fleet-sessions/session-thread-model.js';
import { clockTime } from '../leader/thread-model.js';
import type { LaneTargetsV1 } from '../ops/lane-targets-model.js';
import { appWords } from './composer-app-commands.js';
import { sessionArg, type ComposerCommandName } from './composer-commands.js';

/** `minutes` is the second argument of `/hold`: a fixed list, read from nowhere. */
export type ArgSource = 'lanes' | 'sessions' | 'apps' | 'panes' | 'minutes';
export type ArgCommand = Extract<ComposerCommandName, 'release' | 'hold' | 'lane' | 'stop' | 'log' | 'thread' | 'summary' | 'app' | 'open'>;

const SOURCE: Readonly<Record<ArgCommand, ArgSource>> = {
  release: 'lanes', hold: 'lanes', lane: 'lanes', stop: 'sessions', log: 'sessions', thread: 'sessions', summary: 'sessions', app: 'apps', open: 'panes',
};

/** What the list is called, by command. */
export const ARG_LIST_NAME: Readonly<Record<ArgCommand, string>> = {
  release: 'Held lanes', hold: 'Lanes', lane: 'Lanes', stop: 'Running jobs', log: 'Jobs', thread: 'Sessions', summary: 'Sessions', app: 'Mac apps', open: 'Panes',
};

export interface ArgQuery {
  name: ArgCommand;
  source: ArgSource;
  /** What is typed of the argument so far. */
  query: string;
  /** Where the argument starts in the draft. */
  start: number;
}

/**
 * The argument being typed, or null when the draft is not a command waiting
 * for an argument with the caret at the end. A space ends the argument,
 * except in an app's name; after `/hold <lane> ` the argument is the minutes,
 * for as long as only digits are typed.
 */
export function argQuery(draft: string, caret: number): ArgQuery | null {
  if (caret !== draft.length) return null;
  const match = /^(\s*\/([A-Za-z]+)[ \t]+)([^\n]*)$/.exec(draft);
  const name = match?.[2]!.toLowerCase();
  if (!match || name === undefined || !Object.hasOwn(SOURCE, name)) return null;
  const source = SOURCE[name as ArgCommand];
  const query = match[3]!;
  const minutes = name === 'hold' ? /^(\S+[ \t]+)(\d*)$/.exec(query) : null;
  if (minutes) return { name: 'hold', source: 'minutes', query: minutes[2]!, start: match[1]!.length + minutes[1]!.length };
  if (source !== 'apps' && /\s/.test(query)) return null;
  return { name: name as ArgCommand, source, query, start: match[1]!.length };
}

export interface ArgOption {
  /** What choosing it writes after the command. */
  value: string;
  label: string;
  /** State in a few words: "held until 2:05 PM", "running · claude · spoke 2m ago". */
  facts: string;
  /** The longer line: a hold's reason, the last thing a session said. Null when there is none on record. */
  note: string | null;
  /** The dot before the name; `none` draws no dot. */
  tone: 'ok' | 'warn' | 'bad' | 'off' | 'none';
  /** The lane whose provider mark the row carries, when it has one. */
  lane: string | null;
}

export interface ArgOptions {
  shown: ArgOption[];
  /** Matches beyond the shown ones. */
  more: number;
  /** The sentence shown instead of a list; null when there are rows. */
  empty: string | null;
  /** Why the list may be incomplete; null when the read was whole. */
  caveat: string | null;
}

export const ARG_LIMIT = 6;

/** Narrows by what is typed: a start of the name first, then anywhere in it, then in its facts. The list's own order holds inside each. */
function pick(all: readonly ArgOption[], query: string, words: { none: string; noun: string }, caveat: string | null = null): ArgOptions {
  const needle = query.trim().replace(/^@/, '').toLowerCase();
  const ranked = all.flatMap((option, index) => {
    const names = [option.value.toLowerCase(), option.label.toLowerCase()];
    const rank = names.some(name => name.startsWith(needle)) ? 0 : names.some(name => name.includes(needle)) ? 1
      : `${option.facts} ${option.note ?? ''}`.toLowerCase().includes(needle) ? 2 : -1;
    return rank < 0 ? [] : [{ option, rank, index }];
  }).sort((a, b) => a.rank - b.rank || a.index - b.index).map(({ option }) => option);
  const shown = ranked.slice(0, ARG_LIMIT);
  const empty = shown.length > 0 ? null : all.length === 0 ? words.none : `No ${words.noun} matches “${query.trim()}”.`;
  return { shown, more: ranked.length - shown.length, empty, caveat };
}

/** `/release`: the held lanes with why and until when. `/hold`: every lane, the ones not yet held first. `/lane`: every lane as listed. */
export function laneOptions(targets: LaneTargetsV1, name: 'release' | 'hold' | 'lane', query: string): ArgOptions {
  const rows = name === 'release' ? targets.lanes.filter(row => row.held)
    : name === 'lane' ? targets.lanes : [...targets.lanes].sort((a, b) => Number(a.held) - Number(b.held));
  const options = rows.map((row): ArgOption => {
    const until = row.heldUntil ? clockTime(row.heldUntil) : '';
    return {
      value: row.lane, label: row.lane, lane: row.lane, tone: row.held ? 'warn' : 'none',
      facts: row.held ? `${name === 'hold' ? 'already held' : 'held'}${until ? ` until ${until}` : ''}` : `not held · target ${row.target}`,
      note: row.held ? row.heldReason ?? 'reason not recorded' : null,
    };
  });
  const none = targets.lanes.length === 0 ? 'No lane is listed.' : 'No lane is held right now.';
  return pick(options, query, { none, noun: name === 'release' ? 'held lane' : 'lane' },
    targets.sourceState === 'healthy' ? null : `The lane record is ${targets.sourceState}; this list may be incomplete.`);
}

const STATE_ORDER = ['running', 'idle', 'failed', 'done', 'unknown'];
const SESSION_NONE: Readonly<Record<'stop' | 'log' | 'thread' | 'summary', string>> = {
  stop: 'No job is running right now.', log: 'No job is in the session list.',
  thread: 'No session is in the session list.', summary: 'No session is in the session list.',
};

/**
 * `/stop`: the jobs running now. `/log`: every job in the list. `/thread` and
 * `/summary`: every session, the Leader and helpers included. Running ones
 * come first, then the list's own order.
 */
export function sessionOptions(list: LiveSessionsV1, name: 'stop' | 'log' | 'thread' | 'summary', query: string): ArgOptions {
  const quiet = new Set(list.sessions.filter(row => row.quiet === true).map(row => row.job));
  const seen = new Set<string>();
  const options = flatTree(list.tree.roots).map(({ node }) => node)
    .filter(node => node.kind !== 'unknown-parent')
    .sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state))
    .flatMap((node): ArgOption[] => {
      const job = node.kind === 'worker' ? node.jobId : null;
      const value = job ?? node.id;
      const fits = name === 'stop' ? job !== null && node.state === 'running' && validJob(job)
        : name === 'log' ? job !== null && validJob(job) : sessionArg(value) !== null;
      if (!fits || seen.has(value)) return [];
      seen.add(value);
      const isQuiet = node.state === 'running' && job !== null && quiet.has(job);
      return [{
        value, label: value, lane: node.lane === 'unknown' ? null : node.lane, note: node.lastMessage,
        tone: isQuiet ? 'warn' : node.state === 'running' ? 'ok' : node.state === 'failed' ? 'bad' : 'off',
        facts: [...(node.kind === 'subagent' ? ['helper'] : []), isQuiet ? 'quiet' : STATE_WORD[node.state],
          node.lane === 'unknown' ? 'lane unknown' : node.lane, spoke(node)].join(' · '),
      }];
    });
  return pick(options, query, { none: SESSION_NONE[name], noun: name === 'stop' ? 'running job' : name === 'log' ? 'job' : 'session' },
    // The list's own sentence about what it could not read; its notes about the Leader's row are not about this list.
    list.gaps.find(gap => !gap.startsWith('Leader')) ?? null);
}

/** `/app`: the installed apps whose Apps card row offers open or bring-to-front, in the report's order. */
export function appOptions(report: MacAppsReport, query: string): ArgOptions {
  const options = report.apps.filter(row => row.installed !== false && row.action !== null).map((row): ArgOption => ({
    value: row.id, label: row.name, lane: null,
    tone: row.running ? 'ok' : 'off',
    facts: appWords(row).slice(row.name.length + 1),
    note: row.action === 'focus' ? 'brings it to the front' : 'opens it',
  }));
  return pick(options, query, { none: 'No app on this Mac can be opened from here.', noun: 'app' },
    report.reason ? `Some app state is unknown: ${report.reason.replace(/[.\s]+$/, '')}.` : null);
}

/** `/open`: the registered panes by id, each with its title. */
export function paneOptions(panes: readonly { id: string; title: string }[], query: string): ArgOptions {
  const options = panes.map((pane): ArgOption => ({ value: pane.id, label: pane.id, facts: pane.title, note: null, tone: 'none', lane: null }));
  return pick(options, query, { none: 'No pane is registered.', noun: 'pane' });
}

/** The lengths of hold `/hold <lane> ` offers, in minutes. Any whole number from 1 to 1440 can still be typed. */
export const HOLD_PRESETS: readonly number[] = [15, 30, 60, 120, 240, 1440];
export const HOLD_MINUTES_LIST_NAME = 'Minutes to hold';

/** What the list is called: the command's own, or the minutes list once `/hold` has its lane. */
export const argListName = (at: ArgQuery): string => (at.source === 'minutes' ? HOLD_MINUTES_LIST_NAME : ARG_LIST_NAME[at.name]);

const span = (minutes: number): string =>
  minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;

/** When a hold of that length, started now, would end: "2:35 PM", with "tomorrow" when it crosses midnight. */
export function holdEnd(minutes: number, nowMs: number): string {
  const end = new Date(nowMs + minutes * 60_000);
  return `${clockTime(end.toISOString())}${end.toDateString() === new Date(nowMs).toDateString() ? '' : ' tomorrow'}`;
}

/**
 * `/hold <lane> `: a few lengths of hold, each with the time it would end.
 * A number typed by hand that is none of them is listed first with its own
 * end time, so the row Enter runs is always on screen; one the command would
 * refuse gets the command's own sentence instead of a list.
 */
export function minuteOptions(query: string, nowMs: number): ArgOptions {
  const typed = /^\d+$/.test(query) ? Number(query) : null;
  if (typed !== null && (typed < 1 || typed > 1440)) return { shown: [], more: 0, empty: 'Minutes must be a whole number from 1 to 1440.', caveat: null };
  const listed = [
    ...(typed !== null && !HOLD_PRESETS.includes(typed) ? [typed] : []),
    ...HOLD_PRESETS.filter(preset => typed === null || String(preset).startsWith(String(typed))),
  ];
  const shown = listed.map((minutes): ArgOption => ({
    value: String(minutes), label: span(minutes), facts: `until ${holdEnd(minutes, nowMs)}`, note: null, tone: 'none', lane: null,
  }));
  return { shown, more: 0, empty: null, caveat: null };
}

/** The draft with the argument filled in. `/hold` keeps a space after the lane, ready for the minutes. */
export function insertArg(draft: string, at: ArgQuery, value: string): string {
  return `${draft.slice(0, at.start)}${value}${moreFollows(at) ? ' ' : ''}`;
}

/** Whether filling this argument in leads to another list (`/hold`'s lane, then its minutes), so the picker stays open. */
export function moreFollows(at: ArgQuery): boolean {
  return at.name === 'hold' && at.source === 'lanes';
}

/**
 * Whether Enter fills in the highlighted row instead of running the command.
 * It does only while nothing is typed yet or after the arrows moved the
 * highlight, so a full argument typed by hand always runs as typed.
 */
export function enterFills(at: ArgQuery, moved: boolean): boolean {
  return moved || at.query.trim() === '';
}
