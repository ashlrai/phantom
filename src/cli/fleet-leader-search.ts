import { listThread } from '../core/vision/leader-thread.js';
import { LEADER_THREAD_CHANNELS, type LeaderThreadChannel } from '../core/vision/leader-thread-types.js';

export async function cmdFleetLeaderSearch(args: string[]): Promise<number> {
  const terms: string[] = [];
  let channel: LeaderThreadChannel | undefined;
  let from: 'mason' | 'leader' | undefined;
  let limit = 20;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: ashlr fleet leader-search <terms...> [--channel CHANNEL] [--from mason|leader] [--limit 20] [--json]');
      return 0;
    }
    if (arg === '--json') { json = true; continue; }
    if (arg === '--channel' || arg === '--from' || arg === '--limit') {
      const value = args[++i];
      if (arg === '--channel' && value && (LEADER_THREAD_CHANNELS as readonly string[]).includes(value)) channel = value as LeaderThreadChannel;
      else if (arg === '--from' && (value === 'mason' || value === 'leader')) from = value;
      else if (arg === '--limit' && value && /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 200) limit = Number(value);
      else { console.error(`invalid ${arg}`); return 2; }
    } else if (arg.startsWith('-')) { console.error(`unknown option: ${arg}`); return 2; }
    else terms.push(arg);
  }
  if (!terms.join(' ').trim()) { console.error('search terms are required'); return 2; }
  const matches = listThread({ q: terms.join(' '), channel, from, limit });
  if (json) console.log(JSON.stringify({ matches }));
  else if (!matches.length) console.log('no matches');
  else for (const message of matches) {
    console.log(`${new Date(message.at).toLocaleString()} ${message.from}/${message.channel} ${message.id} ${message.text.replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  return 0;
}
