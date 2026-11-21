/**
 * "Since you last looked", the pure half: what reached the Leader conversation while Mason was not looking at
 * it. Built only from what the pane already holds (the merged thread, the bus replies, the fleet read's merged
 * PRs), counted inside one fixed window: from the last moment the pane was on screen to the moment he came
 * back. Nothing is invented: a count the reads cannot give says "unknown" and is never shown as 0.
 */
import type { Merged } from '../fleet-merges/fleet-merges-model.js';
import type { BusReply } from './thread-bus-replies.js';
import type { MergedLine } from './thread-merge-model.js';

/** Epoch ms of the last moment the Leader pane was on screen. Operational state, never a secret. */
export const LEADER_LAST_LOOKED_KEY = 'phantom.leaderLastLooked.v1';
/** A gap shorter than this is the same sitting: looking away for a moment is not being away. */
export const AWAY_MIN_MS = 2 * 60_000;
/** The fleet read lists merges for the last hour only, so a longer absence has a partial merge count. */
export const MERGE_LOOKBACK_MS = 60 * 60_000;

const MINUTE_MS = 60_000;
const LANE_CHANGES_SHOWN = 2;
const LATEST_MAX = 200;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'> | null;

/** The stored moment, or null when absent or unreadable (a first visit records a baseline and shows nothing). */
export function loadLastLooked(storage: StorageLike): number | null {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(LEADER_LAST_LOOKED_KEY) ?? 'null');
    return typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  } catch {
    return null;
  }
}

export function saveLastLooked(storage: StorageLike, atMs: number): void {
  try { storage?.setItem(LEADER_LAST_LOOKED_KEY, JSON.stringify(atMs)); } catch { /* best-effort */ }
}

export interface AwayWindow { since: number; until: number }

/** The stretch Mason was away for, or null on a first visit or inside the same sitting. */
export function awayWindow(lastLooked: number | null, returnedAt: number): AwayWindow | null {
  return lastLooked !== null && returnedAt - lastLooked >= AWAY_MIN_MS ? { since: lastLooked, until: returnedAt } : null;
}

export interface CatchUp {
  since: number;
  /** What the Leader said in the window, on any channel. */
  leaderMessages: number;
  /** Of those, the outbox lines that ask for a decision or raise an alert. */
  needsYou: number;
  /** Questions the Leader asked in the window that the thread still holds no answer to. */
  questions: number;
  busReplies: number;
  /** PRs merged in the window; null when the fleet read has not answered. */
  merged: number | null;
  /** True when the window is longer than the read's one hour of merges. */
  mergedPartial: boolean;
  /** "codex-personal held: usage_limit", oldest first. */
  laneChanges: string[];
  /** The newest thing the Leader said in the window. */
  latest: { at: number; text: string } | null;
  /** The earliest new line in the conversation, for the jump; null when only merges are new. */
  firstNewAt: number | null;
  total: number;
}

const laneLine = (line: MergedLine) => line.source === 'system' && line.id.startsWith('lane-');

export interface CatchUpInput {
  lines: readonly MergedLine[];
  busRows: readonly BusReply[];
  merged: readonly Merged[] | null;
  /** The Leader's open questions (still unanswered now); one with no readable time is not counted as new. */
  asks?: readonly { atMs: number | null }[];
}

export function catchUp(input: CatchUpInput, window: AwayWindow): CatchUp {
  // Inbox and outbox times are whole minutes, so a line written later in the minute Mason left would read as
  // older than his leaving. The window opens at the start of that minute: a line shown twice beats one missed.
  const from = Math.floor(window.since / MINUTE_MS) * MINUTE_MS;
  const inside = (at: number) => Number.isFinite(at) && at >= from && at <= window.until;
  // Callers may hand over two time-ordered lists joined end to end, so the order is restored here.
  const fresh = input.lines.filter(line => inside(line.at)).sort((a, b) => a.at - b.at);
  const said = fresh.filter(line => line.who === 'leader' && line.source !== 'system');
  const lanes = fresh.filter(laneLine);
  const bus = input.busRows.filter(row => inside(Date.parse(row.at)));
  const merged = input.merged === null ? null : input.merged.filter(item => inside(Date.parse(item.mergedAt ?? item.at ?? ''))).length;
  const newest = said.at(-1);
  const times = [...said, ...lanes].map(line => line.at).concat(bus.map(row => Date.parse(row.at)));
  return {
    since: window.since,
    leaderMessages: said.length,
    needsYou: said.filter(line => line.source === 'outbox' && (line.kind === 'decision' || line.kind === 'alert')).length,
    // A question is also one of the Leader messages above, so it adds nothing to the total.
    questions: (input.asks ?? []).filter(ask => ask.atMs !== null && inside(ask.atMs)).length,
    busReplies: bus.length,
    merged,
    mergedPartial: window.until - window.since > MERGE_LOOKBACK_MS,
    laneChanges: lanes.map(line => line.text),
    latest: newest ? { at: newest.at, text: oneLine(newest.text) } : null,
    firstNewAt: times.length ? Math.min(...times) : null,
    total: said.length + bus.length + lanes.length + (merged ?? 0),
  };
}

/** Markdown marks and line breaks removed, so the newest message reads as one line. */
function oneLine(text: string): string {
  const flat = text.replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
  return flat.length > LATEST_MAX ? `${flat.slice(0, LATEST_MAX - 1).trimEnd()}…` : flat;
}

export interface CatchUpPart { key: string; text: string; tone?: 'attention' | 'unknown' }

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The counts in reading order: what was said, what needs Mason, then what moved around it. */
export function catchUpParts(view: CatchUp): CatchUpPart[] {
  const out: CatchUpPart[] = [];
  if (view.leaderMessages > 0) out.push({ key: 'leader', text: plural(view.leaderMessages, 'Leader message', 'Leader messages') });
  if (view.needsYou > 0) out.push({ key: 'needs-you', text: plural(view.needsYou, 'needs you', 'need you'), tone: 'attention' });
  if (view.questions > 0) out.push({ key: 'questions', text: `${plural(view.questions, 'question', 'questions')} for you`, tone: 'attention' });
  if (view.busReplies > 0) out.push({ key: 'bus', text: plural(view.busReplies, 'bus reply', 'bus replies') });
  if (view.merged === null) out.push({ key: 'merged', text: 'merged PRs unknown', tone: 'unknown' });
  else if (view.merged > 0) out.push({ key: 'merged', text: `${plural(view.merged, 'PR merged', 'PRs merged')}${view.mergedPartial ? ' in the last hour' : ''}` });
  view.laneChanges.slice(-LANE_CHANGES_SHOWN).forEach((text, index) => out.push({ key: `lane-${index}`, text }));
  const more = view.laneChanges.length - LANE_CHANGES_SHOWN;
  if (more > 0) out.push({ key: 'lane-more', text: plural(more, 'earlier lane change', 'earlier lane changes') });
  return out;
}
