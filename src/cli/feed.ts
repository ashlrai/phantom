import { readFeed } from '../core/feed.js';

const usage = 'Usage: phm feed [--json] [--limit N]';

export async function cmdFeed(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(usage); return 0; }
  let limit = 30;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--limit' && /^\d+$/.test(args[i + 1] ?? '')) limit = Number(args[++i]);
    else { console.error(usage); return 2; }
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) { console.error('Limit must be between 1 and 1000.'); return 2; }
  const report = await readFeed(limit);
  console.log(json ? JSON.stringify(report) : `${report.items.map(item => `${item.at}  ${item.text}`).join('\n') || 'No events found.'}\nUnknown sources: ${Object.entries(report.sources).filter(([, state]) => state === 'unknown').map(([name]) => name).join(', ') || 'none'}`);
  return 0;
}
