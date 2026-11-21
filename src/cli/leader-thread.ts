/**
 * `phm leader thread --since <hours|time> [--limit <n>] [--json]`: the whole Leader conversation
 * (MASON-INBOX, MASON-OUTBOX and PLAN-LOG "Reply for Mason") as one list, oldest
 * first. Read-only. Logic lives in core/fleet/leader-thread-merge.ts.
 */
import { parseThreadWindow, type LeaderThreadEntry } from '../core/fleet/leader-thread-merge.js';

export const LEADER_THREAD_USAGE = 'Usage: phm leader thread --since <hours|time> [--limit <n>] [--json]';

/** A plain line per message: time, who, channel, then the text. */
export function leaderThreadLine(entry: LeaderThreadEntry): string {
  const when = entry.at === null ? 'time unknown    ' : entry.at.slice(0, 16).replace('T', ' ');
  const who = entry.from === 'mason' ? 'Mason' : entry.from === 'leader' ? 'Leader' : entry.from === 'teammate' ? 'Teammate' : 'Unknown';
  const refs = entry.refs.length > 0 ? `  [${entry.refs.map(n => `#${n}`).join(' ')}]` : '';
  return `${when} ${who} (${entry.channel})\n  ${entry.text.replace(/\s+/g, ' ').trim()}${refs}`;
}

/** `args` is what follows `thread`. Plain lines by default; `--json` prints the typed LeaderThreadRead. */
export async function runLeaderThreadCli(args: string[]): Promise<number> {
  const rest = [...args];
  const take = (name: string): boolean => { const i = rest.indexOf(name); if (i < 0) return false; rest.splice(i, 1); return true; };
  const json = take('--json');
  const value = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    if (i < 0) return undefined;
    const v = rest[i + 1] ?? '';
    rest.splice(i, 2);
    return v;
  };
  const raw = value('--since');
  const limitRaw = value('--limit');
  const opts = parseThreadWindow(raw, limitRaw);
  if (rest.length > 0 || opts === null) { console.error(LEADER_THREAD_USAGE); return 2; }
  const { readLeaderThread } = await import('../core/fleet/leader-thread-merge.js');
  const read = await readLeaderThread(opts);
  if (json) { console.log(JSON.stringify(read, null, 2)); return 0; }
  if (read.thread.length === 0) console.log(raw === undefined ? 'No messages yet.' : `No messages since ${raw}.`);
  for (const entry of read.thread) console.log(leaderThreadLine(entry));
  for (const [name, state] of Object.entries(read.sources)) if (state === 'unknown') console.log(`(${name} could not be read)`);
  return 0;
}
