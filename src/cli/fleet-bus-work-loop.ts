import { runBusWorkLoop, validBusWorkLoopOptions, type BusWorkLoopOptions } from '../core/fleet/bus-work-loop.js';
import { BUS_PRIORITIES } from '../core/fleet/bus-envelope.js';
import { parseSince } from '../core/fleet/agent-messages.js';
import type { ContextWorkerIO } from '../core/fleet/context-worker-run.js';

const usage = 'Usage: ashlr fleet bus-work-loop --to <address> --owner <label> --lease-ms <ms> --wait-ms <ms> --max-jobs <1..16> --snapshot <absolute> --prompt <absolute> [--id <envelope-id>] [--contains <text>] [--since <15m|2h|1d|ISO>] [--before <15m|2h|1d|ISO>] [--priority <P0|P1|P2|P3>] [--channel <name>] [--topic <topic>] [--from <agent>] [--exclude-from <agent>] [--root <absolute>] [--cwd <absolute directory>] [--timeout-ms <1..3600000>] [--total-timeout-ms <1..3600000>] -- <program> [args...]';
const filters = 'The read filters are the same set every bus claim surface takes — --id keeps only the receipt whose own wire id is strictly equal, --contains only receipts whose scrubbed one-line summary carries the text, --since only receipts received at or after the cutoff and --before only receipts received strictly before its own so the two compose one [since, before) window, --priority only one P0..P3 band, --channel only receipts addressed to group:<name>:* of one bus channel, --topic only receipts addressed to a well-formed group:<room>:<topic> address carrying that exact topic (composing with --channel into one room and one topic), and --from/--exclude-from only receipts one sender wrote or did not write under every registered spelling of one identity — applied inside every claim poll, so the loop claims exactly what the matching read would list and a malformed value is invalid before the first launch.';

export async function cmdFleetBusWorkLoop(args: string[], io: ContextWorkerIO = {}): Promise<number> {
  const out = io.stdout ?? process.stdout, err = io.stderr ?? process.stderr;
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { out.write(`${usage}\n${filters}\n`); return 0; }
  const invalid = () => { err.write(`${usage}\n`); return 2; };
  const split = args.indexOf('--');
  if (split < 0 || split === args.length - 1) return invalid();
  const flags = new Map<string, string>();
  for (let i = 0; i < split; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!['--to', '--owner', '--lease-ms', '--wait-ms', '--max-jobs', '--snapshot', '--prompt', '--root', '--cwd', '--timeout-ms', '--total-timeout-ms',
      '--id', '--contains', '--since', '--before', '--priority', '--channel', '--topic', '--from', '--exclude-from'].includes(key) ||
      flags.has(key) || !value || value.startsWith('--') || value.includes('\0')) return invalid();
    flags.set(key, value);
  }
  const number = (key: string) => { const s = flags.get(key); return s && /^\d+(?![\s\S])/.test(s) ? Number(s) : NaN; };
  const sinceRaw = flags.get('--since');
  const since = sinceRaw === undefined ? undefined : parseSince(sinceRaw);
  const beforeRaw = flags.get('--before');
  const before = beforeRaw === undefined ? undefined : parseSince(beforeRaw);
  const priority = flags.get('--priority');
  if ((sinceRaw !== undefined && since === null) || (beforeRaw !== undefined && before === null) ||
      (priority !== undefined && !(BUS_PRIORITIES as readonly string[]).includes(priority))) return invalid();
  const cwd = flags.get('--cwd');
  const opts: BusWorkLoopOptions = { to: flags.get('--to')!, owner: flags.get('--owner')!, root: flags.get('--root'),
    leaseMs: number('--lease-ms'), waitMs: number('--wait-ms'), maxJobs: number('--max-jobs'),
    snapshot: flags.get('--snapshot')!, prompt: flags.get('--prompt')!, argv: args.slice(split + 1),
    contains: flags.get('--contains'), since: since ?? undefined, before: before ?? undefined,
    priority: priority as (typeof BUS_PRIORITIES)[number] | undefined,
    channel: flags.get('--channel'), topic: flags.get('--topic'),
    from: flags.get('--from'), excludeFrom: flags.get('--exclude-from'), id: flags.get('--id'),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(flags.has('--timeout-ms') ? { timeoutMs: number('--timeout-ms') } : {}),
    ...(flags.has('--total-timeout-ms') ? { totalTimeoutMs: number('--total-timeout-ms') } : {}) };
  if (!validBusWorkLoopOptions(opts)) return invalid();
  const result = await runBusWorkLoop(opts);
  out.write(`${JSON.stringify(result)}\n`);
  return result.status === 'max-jobs' || result.status === 'timeout' ? 0 : result.status === 'invalid' ? 2 : 1;
}
