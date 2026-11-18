/** Phone projection of the desktop Library's existing typed reads. No writes. */
import { scrubSecrets } from '../../../../core/util/scrub-secrets.js';
import type { QueryDef } from '../../../data/queries.js';
import { verseProjectMemoryQuery } from '../context/context-queries.js';
import { agentBusPageQuery, agentBusStatusQuery } from '../fleet-bus/agent-bus-queries.js';
import { verseSessionsQuery } from '../verse-queries.js';
import { libraryBusLines, withReceiptTtl } from './library-bus-model.js';
import { leaderFileLabel } from './library-leader-files-model.js';
import { recentProjects } from './library-model.js';
import { cosMemoryQuery, handoffsQuery, leaderFilesQuery, libraryMediaQuery, libraryPinsQuery } from './library-queries.js';

export interface LibraryItem { id: string; kind: string; title: string; at: number; content: string | null }

// Scrub before deriving titles or searching; env assignments are private even
// when their values do not have a recognizable credential shape.
export function libraryText(text: string): string {
  if (/(?:["']?(?:env|environment)["']?\s*:|\b(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=|["']?[A-Z_][A-Z0-9_]*["']?\s*:)/.test(text)) return '[REDACTED]';
  return scrubSecrets(text);
}

export function findLibraryItems(items: readonly LibraryItem[], search: string): LibraryItem[] {
  const q = search.trim().toLocaleLowerCase();
  return items.map(item => ({ ...item, title: libraryText(item.title), content: item.content === null ? null : libraryText(item.content) }))
    .filter(item => `${item.title} ${item.kind} ${item.content ?? ''}`.toLocaleLowerCase().includes(q))
    .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}

export const libraryItemsQuery: QueryDef<LibraryItem[]> = {
  key: 'verse-library-items',
  fetch: async signal => {
    const item = (id: string, kind: string, title: string, time: string | number, content: string | null): LibraryItem =>
      ({ id: `${kind}:${id}`, kind, title, at: typeof time === 'number' ? time : Date.parse(time) || 0, content });
    const sources: [string, () => Promise<LibraryItem[]>][] = [
      ['Pinned items', async () => (await libraryPinsQuery.fetch(signal))?.pins.map(pin =>
        item(pin.id, 'Pinned', pin.title, pin.pinnedAt, null)) ?? []],
      ['Files', async () => {
        const data = await leaderFilesQuery.fetch(signal);
        if (data.state === 'unavailable') throw new Error('unavailable');
        return data.files.map(row => item(row.name, 'File', leaderFileLabel(row.name), row.modifiedAt, row.unavailable ? null : row.preview));
      }],
      ['Media', async () => {
        const data = await libraryMediaQuery.fetch(signal);
        if (data.state === 'unavailable') throw new Error('unavailable');
        return data.items.map(row => item(row.name, 'Media', row.name, row.modifiedAt, null));
      }],
      ['Context', async () => {
        const data = await handoffsQuery.fetch(signal);
        if (data.state === 'unavailable') throw new Error('unavailable');
        return data.handoffs.map(row => item(`${row.folder}/${row.name}`, 'Context', `${row.folder}: ${row.name}`, row.modifiedAt, row.preview));
      }],
      ['Memory', async () => (await cosMemoryQuery.fetch(signal)).map(row =>
        item(row.id, 'Memory', libraryText(row.text).split('\n')[0]!.slice(0, 100), row.updated, row.text))],
      ['Project memory', async () => {
        const projects = recentProjects(await verseSessionsQuery.fetch(signal));
        return Promise.all(projects.map(async project => {
          let content: string | null = null;
          let at = project.latest;
          try {
            const data = await verseProjectMemoryQuery(project.path).fetch(signal);
            if (typeof data.content === 'string') content = data.content;
            at = Date.parse(data.updatedAt ?? '') || at;
          } catch { /* Keep the known title when this one project cannot be read. */ }
          return item(project.path, 'Memory', `${project.name} memory`, at, content);
        }));
      }],
      ['Agent messages', async () => {
        const status = await agentBusStatusQuery.fetch(signal);
        if (!status || status.source === 'unavailable') throw new Error('unavailable');
        if (status.source === 'missing') return [];
        const page = await agentBusPageQuery(Math.max(0, (status.retainedCount ?? 0) - 50), 50).fetch(signal);
        if (!page) throw new Error('unavailable');
        return libraryBusLines(withReceiptTtl(page, Date.now()), Date.now()).map(line => {
          const receipt = page.messages.find(row => row.envelope.id === line.id)!;
          const body = receipt.envelope.body;
          const text = typeof body === 'string' ? body : body && typeof body === 'object'
            ? ['text', 'message', 'summary'].map(key => (body as Record<string, unknown>)[key]).find(value => typeof value === 'string') : null;
          return item(line.id, 'Agent message', `${line.from} → ${line.to}`, receipt.receivedAt, typeof text === 'string' ? text : null);
        });
      }],
    ];
    const settled = await Promise.allSettled(sources.map(([, read]) => read()));
    if (signal?.aborted) throw signal.reason;
    return findLibraryItems(settled.flatMap((result, i) => result.status === 'fulfilled' ? result.value
      : [item('unavailable', sources[i]![0], sources[i]![0], 0, null)]), '');
  },
};
