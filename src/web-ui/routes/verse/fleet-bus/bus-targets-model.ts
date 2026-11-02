import type { FleetRuns } from '../ops/ops-runs-model.js';

type Runs = Pick<FleetRuns, 'lanes' | 'workers'> | null | undefined;
// Address validation in src/core/fleet/bus-envelope.ts (TOKEN and MAX_BUS_ADDRESS_LENGTH).
const ADDRESS = /^[\x21-\x7e]+(?![\s\S])/;
const valid = (value: string) => value.length <= 128 && ADDRESS.test(value);
const workers = (runs: Runs) => [...(runs?.workers ?? [])]
  .sort((a, b) => (a.ageSeconds ?? Infinity) - (b.ageSeconds ?? Infinity))
  .map(worker => worker.job).filter(valid);

export function busTargets({ senders, runs }: { senders: readonly string[]; runs: Runs }) {
  const seen = new Set<string>();
  return [
    { group: 'Leaders', items: ['leaders'] },
    { group: 'Lanes', items: (runs?.lanes ?? []).map(lane => lane.lane) },
    { group: 'Workers', items: workers(runs) },
    { group: 'Recent senders', items: [...senders] },
  ].map(({ group, items }) => ({ group, items: items.filter(item => {
    if (!valid(item) || seen.has(item)) return false;
    seen.add(item); return true;
  }) }));
}

function mentionStart(text: string, caret: number) {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
  return match ? { start: caret - match[1].length - 1, query: match[1] } : null;
}

export function mentionCandidates(text: string, caretIndex: number, runs: Runs) {
  const mention = mentionStart(text, caretIndex);
  if (!mention) return null;
  const prefix = mention.query.toLowerCase();
  return { query: mention.query, items: [...new Set(workers(runs))].filter(job => job.toLowerCase().startsWith(prefix)).slice(0, 8) };
}

export function applyMention(text: string, caretIndex: number, job: string) {
  const mention = mentionStart(text, caretIndex);
  if (!mention) return { text, caret: caretIndex };
  const end = caretIndex + (text.slice(caretIndex).match(/^[^\s@]*/)?.[0].length ?? 0);
  const insertion = `@${job} `;
  return { text: text.slice(0, mention.start) + insertion + text.slice(end), caret: mention.start + insertion.length };
}
