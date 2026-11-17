import { parseFeedQuery, readFeed } from '../core/feed.js';

const usage = 'Usage: phm feed [--json] [--since 1h] [--limit N] (since: 1m to 7d; limit: 1 to 1000)';

export async function cmdFeed(args: string[], read: typeof readFeed = readFeed): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(usage); return 0; }
  let limit = '30';
  let since: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--limit' && args[i + 1]) limit = args[++i]!;
    else if (args[i] === '--since' && args[i + 1]) since = args[++i];
    else { console.error(usage); return 2; }
  }
  const query = parseFeedQuery(limit, since);
  if (!query) { console.error(usage); return 2; }
  const report = await read(query.limit, query);
  console.log(json ? JSON.stringify(report) : `${report.items.map(item => `${item.at}  ${item.text}  ${item.href ?? ''}`).join('\n') || 'No events found.'}\nUnknown sources: ${Object.entries(report.sources).filter(([, state]) => state === 'unknown').map(([name]) => name).join(', ') || 'none'}`);
  return 0;
}
