/**
 * routes/verse/fleet/held-reason.ts — Parse fleet-lane heldReason strings
 * into a structured label + optional timestamp.
 *
 * Raw API strings look like:
 *   "token rejected 2026-10-31 02:11:29"
 *   "out of usage until 2026-11-01 01:22"
 *
 * Framework-free; tested directly.
 */

export interface HeldReason {
  /** Short human label, never null. */
  label: string;
  /** Normalised ISO timestamp (seconds included, UTC "Z" suffix), or null. */
  at: string | null;
  /** Whether "until" appeared before the timestamp. */
  until: boolean;
}

/** Regex that captures one of the two timestamp forms:
 *  1) `YYYY-MM-DD HH:MM`  (or `HH:MM:SS`) — space-separated
 *  2) `YYYY-MM-DDTHH:MM`  (or `HH:MM:SS`) followed by an optional `Z`
 */
const TS = /(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)?Z?/;

export function parseHeldReason(
  reason: string | null | undefined,
): HeldReason | null {
  if (!reason || /^\s*$/.test(reason)) return null;

  const match = reason.match(TS);

  if (match) {
    const [full, datePart, timePart] = match;
    const seconds = (timePart || '').split(':')[2] ?? '00';
    const time = (timePart || '').split(':').slice(0, 2).join(':');
    const normalized = `${datePart}T${time}:${seconds}Z`;

    // Determine if "until" appears before the matched timestamp in the raw text.
    const prefix = reason.slice(0, match.index!);
    const hasUntil = /\buntil\b/i.test(prefix);

    // Build label: remove only the timestamp, remove "until" from the prefix
    // only (not from the remainder after the timestamp), collapse whitespace.
    const before  = reason.slice(0, match.index!);
    const after   = reason.slice(match.index! + full.length);
    const stripped = before.replace(/\buntil\b/gi, '');
    const label    = [stripped, after].join(' ').replace(/\s+/g, ' ').trim();

    // Capitalise first letter if there's text left.
    const final = label.length > 0
      ? label.charAt(0).toUpperCase() + label.slice(1)
      : label;

    return { label: final, at: normalized, until: hasUntil };
  }

  // No timestamp — pure label, capped at 60 chars.
  const label = reason.replace(/\s+/g, ' ').trim();
  const ellipsis = '…';
  if (label.length > 60) {
    return {
      label: label.slice(0, 60 - ellipsis.length) + ellipsis,
      at: null,
      until: false,
    };
  }

  return {
    label: label.charAt(0).toUpperCase() + label.slice(1),
    at: null,
    until: false,
  };
}
