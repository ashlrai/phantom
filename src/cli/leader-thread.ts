/**
 * `phm leader thread [--since <hours|time>] [--before <hours|time>] [--limit <n>] [--json|--text]`: the whole Leader conversation
 * (MASON-INBOX, MASON-OUTBOX and PLAN-LOG "Reply for Mason") as one list, oldest
 * first. Read-only. Logic lives in core/fleet/leader-thread-merge.ts.
 */
import { BUS_CLIS, type BusCli } from '../core/agents/bus-identity.js';
import { frameOwnerThread } from '../core/agents/bus-cli-adapters.js';
import { parseThreadWindow, type LeaderThreadEntry, type LeaderThreadRead } from '../core/fleet/leader-thread-merge.js';

export const LEADER_THREAD_USAGE = 'Usage: phm leader thread [--since <hours|time>] [--before <hours|time>] [--limit <n>] [--frame <cli>] [--json|--text]';

/** A plain line per message: time, who, channel, then the text. */
export function leaderThreadLine(entry: LeaderThreadEntry): string {
  const when = entry.at === null ? 'time unknown    ' : entry.at.slice(0, 16).replace('T', ' ');
  const who = entry.from === 'mason' ? 'Owner' : entry.from === 'leader' ? 'Leader' : entry.from === 'teammate' ? 'Teammate' : 'Unknown';
  const refs = entry.refs.length > 0 ? `  [${entry.refs.map(n => `#${n}`).join(' ')}]` : '';
  return `${when} ${who} (${entry.channel})\n  ${entry.text.replace(/\s+/g, ' ').trim()}${refs}`;
}

/** The same lines the plain read prints: one entry per `leaderThreadLine`
 * call (its own newline inside), the empty-window note or the unreadable
 * source notes. The frame flattens each to one row. */
function leaderThreadLines(read: LeaderThreadRead, raw: string | undefined, beforeRaw: string | undefined): string[] {
  const lines: string[] = [];
  if (read.thread.length === 0) {
    if (raw !== undefined && beforeRaw !== undefined) lines.push('No messages in the window.');
    else if (raw !== undefined) lines.push(`No messages since ${raw}.`);
    else if (beforeRaw !== undefined) lines.push(`No messages before ${beforeRaw}.`);
    else lines.push('No messages yet.');
  }
  for (const entry of read.thread) lines.push(leaderThreadLine(entry));
  for (const [name, state] of Object.entries(read.sources)) if (state === 'unknown') lines.push(`(${name} could not be read)`);
  return lines;
}

/** `args` is what follows `thread`. Plain lines by default; `--json` prints the typed LeaderThreadRead. */
export async function runLeaderThreadCli(args: string[]): Promise<number> {
  const rest = [...args];
  const take = (name: string): boolean => { const i = rest.indexOf(name); if (i < 0) return false; rest.splice(i, 1); return true; };
  const json = take('--json');
  const text = take('--text');
  const value = (name: string): string | undefined => {
    const i = rest.indexOf(name);
    if (i < 0) return undefined;
    const v = rest[i + 1] ?? '';
    rest.splice(i, 2);
    return v;
  };
  const raw = value('--since');
  const beforeRaw = value('--before');
  const limitRaw = value('--limit');
  const frame = value('--frame');
  const opts = parseThreadWindow(raw, limitRaw, beforeRaw);
  // The same --frame rule every owner-thread read applies: one of the
  // session CLIs; a missing or unknown value is a usage error.
  if (rest.length > 0 || opts === null || (json && text) ||
      (frame !== undefined && !(BUS_CLIS as readonly string[]).includes(frame))) {
    console.error(LEADER_THREAD_USAGE);
    return 2;
  }
  const { readLeaderThread } = await import('../core/fleet/leader-thread-merge.js');
  const read = await readLeaderThread(opts);
  // --frame prints the same lines as one bounded block marked untrusted —
  // every entry is channel-relayed conversation text — with --json carrying
  // it as `framed` beside the full read, the same discipline `phm comms
  // thread` applies under the shared OWNER THREAD markers.
  if (frame !== undefined) {
    const framed = frameOwnerThread(frame as BusCli, leaderThreadLines(read, raw, beforeRaw).flatMap(line => line.split('\n')));
    console.log(json ? JSON.stringify({ ...read, framed }, null, 2) : framed);
    return 0;
  }
  if (json) { console.log(JSON.stringify(read, null, 2)); return 0; }
  for (const line of leaderThreadLines(read, raw, beforeRaw)) console.log(line);
  return 0;
}
