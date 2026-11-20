import { isRecheckAsk } from './recheck-ask.js';

/** Signal groups for a long owner message that asks Phantom to recheck live
 * state, e.g. "recheck the current runtime ... return runtime identity, a fresh
 * shared context/claims read and the owner of the Dot bridge". */
export const LIVE_EVIDENCE_SIGNALS: readonly RegExp[] = [
  /\bre-?(?:check|verify)\b[^.\n]{0,40}\b(?:runtime|live state)\b/,
  /\bruntime identity\b/,
  /\bfresh\b[^.\n]{0,30}\bclaims?\b[^.\n]{0,20}\bread\b/,
  /\bowner of (?:the |a )?(?:\w+ )?bridge\b|\bbridge owner\b/,
  /\b(?:cannot|can't|can not|unable to) reach live state\b|\bmissing bridge\b/,
];

/** True for a message of at most 4000 chars matching at least two distinct
 * signal groups. Short exact asks keep their own path (isRecheckAsk). Pure. */
export function isLiveEvidenceAsk(text: string): boolean {
  if (typeof text !== 'string' || text.trim() === '' || text.length > 4000 || isRecheckAsk(text)) return false;
  const folded = text.toLowerCase().replace(/[’‘]/g, "'");
  return LIVE_EVIDENCE_SIGNALS.filter(signal => signal.test(folded)).length >= 2;
}
