/** Group matching deliveries whose timestamps all fall within the same window. */
export function dedupeInboxEntries<T extends { at: string; source: string; text: string }>(
  entries: readonly T[], windowMs = 6 * 60 * 60 * 1000,
): Array<{ entry: T; repeats: number; otherSources: string[] }> {
  const groups: Array<{ entry: T; text: string; earliest: number; latest: number; sources: string[]; repeats: number }> = [];
  for (const entry of entries) {
    const text = entry.text.trim().replace(/^\[[^\]]+\]\s*/, '').replace(/\s+/g, ' ').replace(/[\p{P}\s]+$/gu, '').toLowerCase();
    const at = Date.parse(entry.at);
    const group = Number.isFinite(at) ? groups.find((candidate) =>
      candidate.text === text && Number.isFinite(candidate.earliest)
      && Math.max(candidate.latest, at) - Math.min(candidate.earliest, at) <= windowMs) : undefined;
    if (group) {
      group.repeats++;
      group.sources.push(entry.source);
      if (at < group.earliest) {
        group.entry = entry;
        group.earliest = at;
      }
      group.latest = Math.max(group.latest, at);
    } else {
      groups.push({ entry, text, earliest: at, latest: at, sources: [entry.source], repeats: 1 });
    }
  }
  return groups.map(({ entry, repeats, sources }) => {
    const seen = new Set([entry.source.toLowerCase()]);
    const otherSources = sources.filter((source) => {
      const key = source.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { entry, repeats, otherSources };
  });
}
