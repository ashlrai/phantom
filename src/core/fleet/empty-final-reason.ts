/**
 * Why an EMPTY job said it stopped (RQ-EMPTYWHYN20SQ8). Reads the final lines of a finished job's
 * log and returns one reason from a fixed list plus the sentence that matched. Plain pattern rules,
 * no model calls. Pure: callers read the file. A log with no final message is `unknown` with no quote.
 */
import { scrubSecrets } from '../util/scrub.js';

export const FINAL_EMPTY_REASONS = ['already-shipped', 'no-change-needed', 'repo-rule', 'blocked-dependency', 'tool-missing', 'usage-out', 'timeout', 'unknown'] as const;
export type FinalEmptyReason = (typeof FINAL_EMPTY_REASONS)[number];
export interface FinalEmptyVerdict { reason: FinalEmptyReason; /** The matched sentence, secrets scrubbed, at most 200 characters; null for unknown. */ sentence: string | null }

/** Only the end of the log is the final message. */
export const FINAL_EMPTY_LOG_LINES = 40;
const QUOTE_MAX = 200;

// Checked in order; the first rule with a matching sentence wins. Hard stops outrank "nothing to do" wording.
const RULES: ReadonlyArray<readonly [Exclude<FinalEmptyReason, 'unknown'>, RegExp]> = [
  ['usage-out', /\breached (?:your|the|our|my) [\w .-]{0,30}\b(?:limit|quota|cap)\b|\b(?:out of|ran out of|exhausted|hit (?:the |my |our |your )?)\s*(?:usage|quota|credits?|tokens)\b|\busage[ -]?limit\b|\brate[ -]?limit(?:ed)?\b|\bquota (?:exceeded|exhausted)\b|\binsufficient[_ ]quota\b|\b(?:HTTP|status(?: code)?) 429\b/i],
  ['timeout', /\btimed? ?out\b|\btimeout\b|\bdeadline exceeded\b|\btoo slow\b|\btook too long\b|\bexceeded (?:the |my )?time limit\b/i],
  ['repo-rule', /\bblocked by (?:a |the )?(?:repo(?:sitory)?|project) rules?\b|\b(?:repo(?:sitory)?|project) rules?\b[^.]{0,60}\b(?:forbid|prohibit|disallow|block|do(?:es)? not allow)|\b(?:forbidden|not allowed|prohibited) by\b|\bCODEOWNERS\b|\breserved for (?:the )?owner\b|\boff[- ]limits\b|\b(?:must|may|should) not (?:edit|touch|change|modify)\b|\bnever touch\b/i],
  ['tool-missing', /\bcommand not found\b|\bno such file\b|\bmissing (?:the )?(?:file|tool|permission|access)\b|\bENOENT\b|\b(?:EPERM|EACCES)\b|\bpermission denied\b|\bnot installed\b|\b(?:tool|binary|cli|executable|MCP server|dependency|gh)\b[^.]{0,40}\b(?:missing|unavailable|not found|not available)\b/i],
  ['blocked-dependency', /\bblocked (?:on|by) (?:an? |the |another )?(?:other |open |upstream |earlier |prior )?(?:job|pr|pull request|issue|task|dependency|merge)\b|\bwaiting (?:on|for) (?:an? |the )?(?:other |open |upstream )?(?:job|pr|pull request|merge|dependency|review|owner)\b|\bdepends on\b|\bupstream (?:change|pr|job)\b/i],
  ['already-shipped', /\balready (?:on|in) (?:origin\/)?(?:master|main)\b|\balready (?:shipped|landed|merged|implemented|exists?|done|fixed|covered|present)\b|\b(?:open|existing) (?:pr|pull request)\b[^.]{0,60}\bcovers?\b|\bduplicate of\b/i],
  ['no-change-needed', /\bno (?:code )?changes? (?:is |are |was |were )?(?:needed|necessary|required)\b|\bnothing (?:left )?to (?:change|do|fix)\b|\bno[- ]op\b|\bended with no change\b|\balready correct\b/i],
];

/** Split the final lines into sentences, oldest first. Bullets and markdown marks are dropped. */
function sentences(text: string): string[] {
  const lines = text.split(/\r?\n/).filter(line => line.trim() !== '').slice(-FINAL_EMPTY_LOG_LINES);
  return lines.flatMap(line => line.replace(/^[\s>*#_-]+/, '').split(/(?<=[.!?])\s+/)).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

export function classifyFinalEmpty(log: string | null): FinalEmptyVerdict {
  const all = log === null ? [] : sentences(log);
  for (const [reason, pattern] of RULES) {
    // The newest matching sentence is the closest to the worker's own conclusion.
    const hit = [...all].reverse().find(sentence => pattern.test(sentence));
    if (hit) return { reason, sentence: scrubSecrets(hit.length > QUOTE_MAX ? `${hit.slice(0, QUOTE_MAX - 1)}…` : hit) };
  }
  return { reason: 'unknown', sentence: null };
}

export interface FinalEmptyJob { id: string; lane: string; verdict: FinalEmptyVerdict }
export interface FinalEmptyExample { id: string; lane: string; sentence: string | null }
export interface FinalEmptyReport {
  schema: 'jobs.empty-final.v1';
  reasons: Record<FinalEmptyReason, number>;
  /** Counts per lane, busiest lane first. */
  lanes: { lane: string; total: number; top: FinalEmptyReason; reasons: Record<FinalEmptyReason, number> }[];
  /** The newest examples per reason, newest first; reasons with no job are omitted. */
  examples: Partial<Record<FinalEmptyReason, FinalEmptyExample[]>>;
}
export const FINAL_EMPTY_EXAMPLES = 5;

const zero = (): Record<FinalEmptyReason, number> => Object.fromEntries(FINAL_EMPTY_REASONS.map(r => [r, 0])) as Record<FinalEmptyReason, number>;

/** `jobs` oldest first (ledger order). */
export function summarizeFinalEmpty(jobs: readonly FinalEmptyJob[]): FinalEmptyReport {
  const reasons = zero();
  const byLane = new Map<string, Record<FinalEmptyReason, number>>();
  const examples: FinalEmptyReport['examples'] = {};
  for (const job of [...jobs].reverse()) {
    const reason = job.verdict.reason;
    reasons[reason]++;
    const lane = byLane.get(job.lane) ?? zero();
    lane[reason]++;
    byLane.set(job.lane, lane);
    const list = examples[reason] ??= [];
    if (list.length < FINAL_EMPTY_EXAMPLES) list.push({ id: scrubSecrets(job.id), lane: job.lane, sentence: job.verdict.sentence });
  }
  const lanes = [...byLane].map(([lane, counts]) => ({
    lane, reasons: counts, total: Object.values(counts).reduce((a, b) => a + b, 0),
    // Real reasons outrank unknown on a tie, so the badge names a cause when it has one.
    top: [...FINAL_EMPTY_REASONS].sort((a, b) => counts[b] - counts[a])[0]!,
  })).sort((a, b) => b.total - a.total || a.lane.localeCompare(b.lane));
  return { schema: 'jobs.empty-final.v1', reasons, lanes, examples };
}
