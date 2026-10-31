/**
 * fleet-steering/steering-model.ts — aligns each leaders'-inbox order with
 * the dispatcher events that followed it, so "did my 00:13 order cause
 * anything?" is one glance at one list.
 *
 * ZONE CAVEAT — READ BEFORE TOUCHING naiveClock. Inbox `at` stamps are
 * `YYYY-MM-DD HH:MM` written in the Mac's local clock
 * (core/fleet/mason-inbox.ts localTimestamp). Dispatch event `at` stamps are
 * `YYYY-MM-DDTHH:MM:SSZ`, but the Z is a labelling artefact: the digits are
 * stamped from the SAME local clock (core/fleet/runs-dir-state.ts
 * parseDispatchEvents). The two are therefore ordered as naive wall-clock
 * digits — routing either through `Date` would drag a timezone into the
 * comparison and silently reorder entries across DST edges. naiveClock is
 * pure arithmetic on the parsed digits and never touches `Date`.
 */

export interface SteeringEvent {
  at: string;
  kind: string;
  text: string;
}

export interface ReactionCounts {
  passes: number;
  launches: number;
  publishes: number;
  holds: number;
  incidents: number;
  other: number;
}

export interface SteeringEntry {
  at: string;
  source: string;
  text: string;
  after: ReactionCounts;
  /** Minutes from the order to the first leader pass inside its window; null when no LEADER/OPUS-LEADER event landed. */
  firstReactionMinutes: number | null;
  /** The window's events, oldest first (the order's own aftermath story). */
  events: SteeringEvent[];
}

const CLOCK = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/;

/**
 * Days since 1970-01-01 in the proleptic Gregorian calendar (Hinnant's
 * days-from-civil). Pure integer arithmetic — no `Date`, see the zone caveat.
 */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month > 2 ? month - 3 : month + 9) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** 0000-01-01 is 719528 days before 1970-01-01. */
const DAYS_ZERO_TO_EPOCH = 719_528;

function daysInMonth(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

/**
 * Minutes since 0000-01-01 parsed from the leading
 * `YYYY-MM-DD[ T]HH:MM(:SS)?` digits of `text` — seconds count as a fraction
 * of a minute — or null when the digits are absent or out of range. The
 * trailing `Z` (or anything else) after the time is ignored.
 */
export function naiveClock(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const m = CLOCK.exec(text);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) return null;
  return (daysFromCivil(year, month, day) + DAYS_ZERO_TO_EPOCH) * 1440 + hour * 60 + minute + second / 60;
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

const zeroCounts = (): ReactionCounts => ({ passes: 0, launches: 0, publishes: 0, holds: 0, incidents: 0, other: 0 });

/** Which fleet-effect bucket a dispatch event kind belongs to. */
function bucket(kind: string): keyof ReactionCounts {
  switch (kind.trim().toUpperCase()) {
    case 'LEADER':
    case 'OPUS-LEADER':
      return 'passes';
    case 'LAUNCH':
      return 'launches';
    case 'PUBLISHED':
      return 'publishes';
    case 'LANE_HOLD':
      return 'holds';
    case 'INCIDENT':
      return 'incidents';
    default:
      return 'other';
  }
}

/**
 * The fleet-runs snapshot → one row per inbox order, newest first. Each
 * order's window runs from its own stamp to the next NEWER order's stamp
 * (open-ended for the newest order); events before the oldest order are
 * attributed to nothing. Orders whose `at` will not parse get a zeroed
 * `after`, a null reaction and no events — and they cannot bound a window:
 * the next older order's window reaches past them to the nearest parseable
 * newer order, so no event is counted twice. Events whose `at` will not
 * parse are ignored entirely. Never throws on malformed input.
 */
export function buildSteering(snapshot: unknown): SteeringEntry[] {
  const data = record(snapshot);
  const inbox = (Array.isArray(data.inbox) ? data.inbox : []).flatMap((raw) => {
    const entry = record(raw);
    return typeof entry.at === 'string' && typeof entry.source === 'string' && typeof entry.text === 'string'
      ? [{ at: entry.at, source: entry.source, text: entry.text, clock: naiveClock(entry.at) }]
      : [];
  });
  // Newest first: parseable stamps by clock descending (stable, so equal
  // stamps keep inbox order); stamps that will not parse sink to the end.
  inbox.sort((a, b) => (b.clock ?? Number.NEGATIVE_INFINITY) - (a.clock ?? Number.NEGATIVE_INFINITY));
  const events = (Array.isArray(data.events) ? data.events : []).flatMap((raw) => {
    const event = record(raw);
    if (typeof event.at !== 'string' || typeof event.kind !== 'string' || typeof event.text !== 'string') return [];
    const clock = naiveClock(event.at);
    return clock === null ? [] : [{ at: event.at, kind: event.kind, text: event.text, clock }];
  });
  return inbox.map((entry, index) => {
    const base = { at: entry.at, source: entry.source, text: entry.text };
    if (entry.clock === null) return { ...base, after: zeroCounts(), firstReactionMinutes: null, events: [] };
    let upper = Number.POSITIVE_INFINITY;
    for (let i = index - 1; i >= 0; i -= 1) {
      const clock = inbox[i].clock;
      if (clock !== null) { upper = clock; break; }
    }
    const windowed = events
      .filter((event) => event.clock >= entry.clock! && event.clock < upper)
      .sort((a, b) => a.clock - b.clock);
    const after = zeroCounts();
    let firstPass = Number.POSITIVE_INFINITY;
    for (const event of windowed) {
      const kind = bucket(event.kind);
      after[kind] += 1;
      if (kind === 'passes' && event.clock < firstPass) firstPass = event.clock;
    }
    return {
      ...base,
      after,
      firstReactionMinutes: firstPass === Number.POSITIVE_INFINITY ? null : firstPass - entry.clock,
      events: windowed.map(({ at, kind, text }) => ({ at, kind, text })),
    };
  });
}

const PART_LABELS: ReadonlyArray<readonly [keyof ReactionCounts, string, string]> = [
  ['passes', 'pass', 'passes'],
  ['launches', 'launch', 'launches'],
  ['publishes', 'publish', 'publishes'],
  ['holds', 'hold', 'holds'],
  ['incidents', 'incident', 'incidents'],
  ['other', 'other event', 'other events'],
];

/** "2 passes, 5 launches, 1 publish" — or "No leader pass yet" when the window held nothing. */
export function summarizeReaction(entry: SteeringEntry): string {
  const parts = PART_LABELS.flatMap(([key, one, many]) => {
    const count = entry.after[key];
    return count > 0 ? [`${count} ${count === 1 ? one : many}`] : [];
  });
  return parts.length > 0 ? parts.join(', ') : 'No leader pass yet';
}

/** The snapshot's source-health pair this pane cares about (null = absent from the payload). */
export function fleetSourceHealth(snapshot: unknown): { inbox: string | null; runsDir: string | null } {
  const sources = record(record(snapshot).sources);
  return {
    inbox: typeof sources.inbox === 'string' ? sources.inbox : null,
    runsDir: typeof sources.runsDir === 'string' ? sources.runsDir : null,
  };
}
