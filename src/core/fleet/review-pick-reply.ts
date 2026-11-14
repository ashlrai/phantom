/**
 * core/fleet/review-pick-reply.ts: turn a fleet.review-pick.v1 report into a
 * short, paste-ready thread reply — the answer a reply worker posts when the
 * owner asks "review" in the Slack Leader thread (RQ-PHX-SLACKREVIEWASK374).
 *
 * The formatter is pure: no I/O, no clock reads, only the report's own as_of.
 * One line, hard cap 600 chars. A pick names repo#pr, head sha7 and a
 * ≤100-char title with owner none and the honesty clause; no pick names the
 * report's reason, then each unreadable ownership source and an unreadable
 * PR list. The reply is evidence only — it is never a claim.
 *
 * Every interpolated value is scrubbed here, not trusted from upstream:
 * control characters become spaces, /Users|/home/<name> shapes become '~'
 * and IPs are dropped (sanitizeIdentityText), so a hand-built report cannot
 * smuggle a path or handle into a thread reply.
 */
import { sanitizeIdentityText } from './runtime-identity.js';
import type { ReviewPickReport } from './review-pick.js';

/** Hard cap on the whole reply, including the trailing ellipsis when clipped. */
const REPLY_MAX = 600;
/** A pick's title field is cut at 100 chars before the cap applies. */
const TITLE_MAX = 100;
/** Home-dir shape from any user — /Users/<name>, /home/<name> → '~'. */
const HOME_PATH = /\/(?:Users|home)\/[^/\s;,)]+/g;
/** Control characters never reach a thread reply. */
const CONTROL = /\p{Cc}/gu;

/** Redact control chars, home paths and IP addresses from one value. */
function scrub(value: string): string {
  return sanitizeIdentityText(value.replace(CONTROL, ' ').replace(HOME_PATH, '~'), '');
}

/** `none — <reason>.` with exactly one closing period. */
function noneReason(reason: string): string {
  const text = scrub(reason).replace(/\.+\s*$/, '');
  return `none — ${text === '' ? 'no pick' : text}.`;
}

/** Format a review-pick report as one paste-ready thread reply. */
export function formatReviewPickReply(report: ReviewPickReport): string {
  const asOf = scrub(typeof report?.as_of === 'string' && report.as_of !== '' ? report.as_of : 'unknown');
  const picked = report?.picked ?? null;
  let text: string;
  if (picked !== null) {
    const repo = scrub(typeof picked.repo === 'string' && picked.repo !== '' ? picked.repo : report.repo);
    const sha = scrub(String(picked.head_sha ?? '')).slice(0, 7) || 'unknown';
    const title = scrub(String(picked.title ?? '')).slice(0, TITLE_MAX);
    text = `Phantom review pick (as of ${asOf}): ${repo}#${picked.pr} head ${sha} "${title}"`
      + ' — owner: none (no live claim or running worker names it). Evidence only; this is not a claim.';
  } else {
    const notes: string[] = [];
    const unavailable = Array.isArray(report?.source?.unavailable) ? report.source.unavailable : [];
    if (unavailable.length > 0) notes.push(`Unreadable sources: ${unavailable.map(s => scrub(String(s))).join(', ')}.`);
    if (report?.source?.prs === 'unavailable') notes.push('PR list unreadable.');
    text = `Phantom review pick (as of ${asOf}): ${noneReason(String(report?.reason ?? ''))}`
      + (notes.length > 0 ? ` ${notes.join(' ')}` : '');
  }
  return text.length <= REPLY_MAX ? text : `${text.slice(0, REPLY_MAX - 1)}…`;
}
