/** Offline research source for DRIVER-3. The caller owns queue locking and persistence. */
export interface ResearchRestockInput {
  topics: string;
  /** Full queue, including completed entries, so retries cannot recreate their IDs. */
  queue: string;
  /** Topic IDs, queue IDs, or literal phrases that must not be scheduled. */
  holdList: readonly string[];
  now: Date;
  dailyTarget?: number;
}

export const RESEARCH_ACCEPTANCE_TAIL =
  'Acceptance: cite primary sources with dates and links; compare alternatives; ' +
  'give an actionable recommendation and limitations; write findings only to docs/research/; ' +
  'no code changes; no new tokens; no em dashes.';

/** Return additions only. Empty/unsafe/exhausted topic lists fail closed. */
export function generateResearchLines(input: ResearchRestockInput): string[] {
  const target = input.dailyTarget ?? 3;
  if (!Number.isInteger(target) || target < 2 || target > 4) {
    throw new RangeError('dailyTarget must be an integer from 2 to 4');
  }
  const day = input.now.toISOString().slice(0, 10).replaceAll('-', '');
  const ids = new Set(input.queue.match(/\bRQ-[A-Z0-9][A-Z0-9-]*\b/gi)?.map(id => id.toUpperCase()) ?? []);
  const prefix = `RQ-RESEARCH-${day}-`;
  const existing = [...ids].filter(id => id.startsWith(prefix)).length;
  const remaining = Math.max(0, target - existing);
  const holds = input.holdList.map(value => value.trim().toLowerCase()).filter(Boolean);
  const topics = new Map<string, string>();
  for (const line of input.topics.split(/\r?\n/)) {
    const match = /^- ([A-Z][A-Z0-9-]{0,63}) \| (.+)$/.exec(line);
    if (!match) continue;
    const [, id, question] = match;
    // Reject queue delimiters, control characters, protected paths and em dashes.
    const hasControl = [...question].some(character => character.charCodeAt(0) < 32);
    if (hasControl || /[\u007f\u0085\u2014\u2028\u2029|]/.test(question) || /\.github/i.test(question)) continue;
    if (!question.trim()) continue;
    if (topics.has(id)) continue;
    topics.set(id, question.trim());
  }
  // Rotate the starting topic daily without random state or a provider call.
  const candidates = [...topics];
  const offset = candidates.length ? Math.floor(input.now.getTime() / 86_400_000) % candidates.length : 0;
  const additions: string[] = [];
  for (let index = 0; index < candidates.length && additions.length < remaining; index++) {
    const [topic, question] = candidates[(index + offset + candidates.length) % candidates.length];
    const id = `${prefix}${topic}`;
    const line = `${id} (P2, pool=codex-personal, tier=work, repo=phantom): Research ${question}. ${RESEARCH_ACCEPTANCE_TAIL}`;
    if (ids.has(id) || holds.some(hold => line.toLowerCase().includes(hold))) continue;
    ids.add(id);
    additions.push(line);
  }
  return additions;
}
