/**
 * `phm leader thread [--since <hours>] [--json]`: the whole Leader conversation
 * (MASON-INBOX, MASON-OUTBOX and PLAN-LOG "Reply for Mason") as one list, oldest
 * first. Read-only. Logic lives in core/fleet/leader-thread-merge.ts.
 */
import type { LeaderThreadEntry } from '../core/fleet/leader-thread-merge.js';

export const LEADER_THREAD_USAGE = 'Usage: phm leader thread [--since <hours>] [--json]';

/** A plain line per message: time, who, channel, then the text. */
export function leaderThreadLine(entry: LeaderThreadEntry): string {
  const when = entry.at === null ? 'time unknown    ' : entry.at.slice(0, 16).replace('T', ' ');
  const who = entry.from === 'mason' ? 'Mason' : entry.from === 'leader' ? 'Leader' : entry.from === 'teammate' ? 'Teammate' : 'Unknown';
  return `${when} ${who} (${entry.channel})\n  ${entry.text.replace(/\s+/g, ' ').trim()}`;
}

/** `args` is what follows `thread`. Plain lines by default; `--json` prints the typed LeaderThreadRead. */
export async function runLeaderThreadCli(args: string[]): Promise<number> {
  const rest = [...args];
  const take = (name: string): boolean => { const i = rest.indexOf(name); if (i < 0) return false; rest.splice(i, 1); return true; };
  const json = take('--json');
  const at = rest.indexOf('--since');
  const raw = at < 0 ? undefined : rest[at + 1];
  if (at >= 0) rest.splice(at, 2);
  const hours = raw === undefined ? undefined : Number(raw);
  if (rest.length > 0 || (at >= 0 && !(hours! > 0 && hours! <= 24 * 365))) { console.error(LEADER_THREAD_USAGE); return 2; }
  const { readLeaderThread } = await import('../core/fleet/leader-thread-merge.js');
  const read = await readLeaderThread(hours === undefined ? {} : { sinceHours: hours });
  if (json) { console.log(JSON.stringify(read, null, 2)); return 0; }
  if (read.thread.length === 0) console.log(raw === undefined ? 'No messages yet.' : `No messages in the last ${raw} hours.`);
  for (const entry of read.thread) console.log(leaderThreadLine(entry));
  for (const [name, state] of Object.entries(read.sources)) if (state === 'unknown') console.log(`(${name} could not be read)`);
  return 0;
}
