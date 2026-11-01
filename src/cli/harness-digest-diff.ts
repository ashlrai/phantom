import type { HarnessDigest } from '../core/learn/harness-digest-reader.js';

type Source = HarnessDigest['sources'][number];
interface TakeawayChange { id: string; text: string; urls: string[]; checkedAt: string | null }
interface ChangedSource {
  id: string;
  kind: 'citation_date' | 'content';
  before: Source;
  after: Source;
}

function group(digest: HarnessDigest): Map<string, Source[]> {
  const groups = new Map<string, Source[]>();
  for (const source of digest.sources) {
    const records = groups.get(source.id) ?? [];
    records.push(source);
    groups.set(source.id, records);
  }
  return groups;
}

/** Compare retained parser data only. Never choose a winner for an ambiguous ID. */
export function diffHarnessDigests(previous: HarnessDigest, current: HarnessDigest) {
  const before = group(previous), after = group(current);
  const ids = new Set([...before.keys(), ...after.keys()]);
  const ambiguousIds = new Set<string>();
  for (const digest of [previous, current]) {
    for (const issue of digest.issues) {
      if (issue.code === 'duplicate_id' || issue.code === 'malformed_id') ambiguousIds.add(issue.id);
    }
  }
  for (const id of ids) {
    if ((before.get(id)?.length ?? 0) > 1 || (after.get(id)?.length ?? 0) > 1) ambiguousIds.add(id);
  }
  const added: Source[] = [], removed: Source[] = [], changed: ChangedSource[] = [];
  const addedTakeaways: TakeawayChange[] = [], removedTakeaways: TakeawayChange[] = [];
  const notes = (source: Source | undefined) => new Set(source?.takeaways ?? []);
  // Stable field order and set comparison avoid JSON property/Markdown ordering noise.
  const content = (source: Source) => JSON.stringify([
    source.title, [...new Set(source.urls)].sort(), source.license ?? null,
    [...new Set(source.licenseUrls ?? [])].sort(), [...notes(source)].sort(),
    source.takeawaysTruncated?.count ?? false, source.takeawaysTruncated?.bytes ?? false,
  ]);
  const takeaway = (source: Source, text: string): TakeawayChange => ({
    id: source.id, text, urls: source.urls, checkedAt: source.checkedAt,
  });
  for (const id of ids) {
    if (ambiguousIds.has(id)) continue;
    const old = before.get(id)?.[0], next = after.get(id)?.[0];
    if (!old && next) added.push(next);
    else if (old && !next) removed.push(old);
    else if (old && next) {
      const contentChanged = content(old) !== content(next);
      if (contentChanged || old.checkedAt !== next.checkedAt) {
        changed.push({ id, kind: contentChanged ? 'content' : 'citation_date', before: old, after: next });
      }
    }
    if (next) for (const text of notes(next)) {
      if (!notes(old).has(text)) addedTakeaways.push(takeaway(next, text));
    }
    if (old) for (const text of notes(old)) {
      if (!notes(next).has(text)) removedTakeaways.push(takeaway(old, text));
    }
  }
  return {
    v: 1 as const,
    added, removed, changed, addedTakeaways, removedTakeaways,
    ambiguous: [...ambiguousIds].map(id => ({ id, before: before.get(id) ?? [], after: after.get(id) ?? [] })),
    issues: { previous: previous.issues, current: current.issues },
  };
}
