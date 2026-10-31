export interface InboxEntry { at: string; source: string; priority: string; text: string }
const record = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
const label = (v: unknown) => typeof v === 'string' && v.trim() ? v : '—';

export function readInboxEntries(dedicated: unknown, snapshot: unknown) {
  const route = record(dedicated), fleet = record(snapshot);
  const origin = route?.v === 1 && Array.isArray(route.entries) ? 'route'
    : fleet?.v === 1 && Array.isArray(fleet.inbox) ? 'snapshot' : 'none';
  const raw: unknown[] = origin === 'route' ? route!.entries as unknown[]
    : origin === 'snapshot' ? fleet!.inbox as unknown[] : [];
  const entries = raw.flatMap(value => {
    const row = record(value);
    if (!row || typeof row.text !== 'string') return [];
    return [{ at: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(label(row.at)) ? row.at as string : '—',
      source: label(row.source), priority: label(row.priority), text: row.text }];
  });
  return { entries, sourceState: label(origin === 'route' ? route!.sourceState
    : record(fleet?.sources)?.inbox), origin } as const;
}

export function filterEntries(entries: readonly InboxEntry[], filters: { source: string; text: string }) {
  const text = filters.text.trim().toLocaleLowerCase();
  return entries.filter(e => (!filters.source || e.source === filters.source) && e.text.toLocaleLowerCase().includes(text));
}

export function groupByDay<T extends InboxEntry>(entries: readonly T[], todayEt: string) {
  const yesterday = new Date(`${todayEt}T12:00:00Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const previous = yesterday.toISOString().slice(0, 10);
  const groups = new Map<string, { day: string; label: string; entries: T[] }>();
  for (const entry of [...entries].sort((a, b) => (a.at === '—' ? 1 : b.at === '—' ? -1 : b.at.localeCompare(a.at)))) {
    const day = entry.at === '—' ? '—' : entry.at.slice(0, 10);
    if (!groups.has(day)) groups.set(day, { day, label: day === todayEt ? 'Today' : day === previous ? 'Yesterday' : day, entries: [] });
    groups.get(day)!.entries.push(entry);
  }
  return [...groups.values()];
}

export function quoteForMessage(entry: InboxEntry) {
  return `${entry.text.replace(/\r\n?/g, '\n').split('\n').map(line => `> ${line}`).join('\n')}\n— ${entry.source}, ${entry.at} ET`;
}
