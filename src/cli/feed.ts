import { FEED_QUERY_ERROR, parseFeedQuery, readFeed, type FeedReport } from '../core/feed.js';

const usage = `Usage: phm feed [--json] [--since 1h|<ISO time>] [--kind merged|released|failed|lane|incident|leader] [--limit N]
${FEED_QUERY_ERROR}`;

/** One line per event: time, kind, sentence (with a repeat count), link; a burst lists its merges beneath. Unknown sources are named, never shown as empty. */
export function renderFeed(report: FeedReport): string {
  const lines = report.items.flatMap(item => [`${item.at}  ${item.kind.padEnd(8)}  ${item.text}${item.count > 1 ? ` (x${item.count})` : ''}  ${item.href}`,
    ...(item.group ?? []).map(entry => `    ${entry.text}  ${entry.href}`)]);
  const unknown = Object.entries(report.sources).filter(([, state]) => state === 'unknown').map(([name]) => name);
  return [lines.join('\n') || 'Nothing happened in this window.', ...(report.more ? ['More events are older; raise --limit to see them.'] : []),
    `Unknown sources: ${unknown.join(', ') || 'none'}`].join('\n');
}

export async function cmdFeed(args: string[], read: (query: Parameters<typeof readFeed>[0]) => Promise<FeedReport> = query => readFeed(query)): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(usage); return 0; }
  const input: { limit?: string; since?: string; kind?: string } = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!, value = args[i + 1];
    if (flag === '--json') json = true;
    else if ((flag === '--limit' || flag === '--since' || flag === '--kind') && value !== undefined) { input[flag.slice(2) as keyof typeof input] = value; i++; }
    else { console.error(usage); return 2; }
  }
  const query = parseFeedQuery(input);
  if (!query) { console.error(usage); return 2; }
  const report = await read(query);
  console.log(json ? JSON.stringify(report) : renderFeed(report));
  return 0;
}
