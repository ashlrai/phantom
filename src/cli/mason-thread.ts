/** `phm mason thread`: Mason's one thread across every channel, with each
 * message's reply state and linked jobs, sliced by --since/--before window,
 * --channel, --direction and --contains. Read-only: it never calls a channel
 * transport and sends nothing. Logic lives in core/comms/mason-thread.ts. */
import { join } from 'node:path';
import { rejectUnknownOptions } from './args.js';
import { ashlrHome } from '../core/cloud/store.js';
import { fixedOwnerConfigDir, fixedOwnerRunsDir, loadOwnerThreadSettings } from '../core/comms/owner-channel.js';
import { MASON_THREAD_CHANNEL, masonThreadText, readMasonThread, type MasonThreadOptions } from '../core/comms/mason-thread.js';
import { OWNER_THREAD_CONTAINS_MAX } from '../core/comms/owner-thread.js';
import { parseSince } from '../core/fleet/agent-messages.js';
import { cmdFleetMasonDigest, type MasonDigestCliDeps } from './fleet-mason-digest.js';

const USAGE = 'usage: phm mason thread [--since <15m|2h|1d>] [--before <15m|2h|1d>] [--channel <name>] [--direction <inbound|outbound>] [--contains <text>] [--json]\n       phm mason digest [--since 1h] [--post] [--json]';
const DEFAULT_SINCE = '1d';

export async function cmdMason(args: string[], overrides: Partial<MasonThreadOptions> = {}, digestDeps: MasonDigestCliDeps = {}): Promise<number> {
  if (args[0] === 'digest') return cmdFleetMasonDigest(args.slice(1), { runsDir: overrides.runsDir, ...digestDeps });
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  const bad = args[0] !== 'thread' ? { message: `unknown mason command: ${args[0] ?? '(none)'}` } : rejectUnknownOptions(args.slice(1), { flags: ['--json'], values: ['--since', '--before', '--channel', '--direction', '--contains'] });
  if (bad) { console.error(bad.message); console.error(USAGE); return 2; }
  const at = args.indexOf('--since');
  const beforeAt = args.indexOf('--before');
  const now = Date.now();
  const sinceMs = parseSince(at < 0 ? DEFAULT_SINCE : args[at + 1] ?? '', now);
  if (sinceMs === null) { console.error('--since takes 15m, 2h, 1d, epoch ms or an ISO time.'); console.error(USAGE); return 2; }
  let beforeMs: number | undefined;
  if (beforeAt >= 0) {
    const parsed = parseSince(args[beforeAt + 1] ?? '', now);
    if (parsed === null) { console.error('--before takes 15m, 2h, 1d, epoch ms or an ISO time.'); console.error(USAGE); return 2; }
    beforeMs = parsed;
  }
  const channelAt = args.indexOf('--channel');
  let channel: string | undefined;
  if (channelAt >= 0) {
    const raw = args[channelAt + 1] ?? '';
    if (!MASON_THREAD_CHANNEL.test(raw)) { console.error('--channel takes a lowercase channel name (letters, digits, ".", "_" or "-").'); console.error(USAGE); return 2; }
    channel = raw;
  }
  const directionAt = args.indexOf('--direction');
  let direction: 'inbound' | 'outbound' | undefined;
  if (directionAt >= 0) {
    const raw = args[directionAt + 1];
    if (raw !== 'inbound' && raw !== 'outbound') { console.error('--direction takes inbound or outbound.'); console.error(USAGE); return 2; }
    direction = raw;
  }
  const containsAt = args.indexOf('--contains');
  let contains: string | undefined;
  if (containsAt >= 0) {
    const raw = args[containsAt + 1];
    // Same rule as `phm comms thread --contains`: free text, bounded; a
    // flag-looking or blank value is a missing needle, not a search.
    if (raw === undefined || raw.startsWith('--') || raw.trim() === '' || raw.length > OWNER_THREAD_CONTAINS_MAX) {
      console.error(`--contains takes a non-empty search text of at most ${OWNER_THREAD_CONTAINS_MAX} characters.`); console.error(USAGE); return 2;
    }
    contains = raw;
  }
  const runsDir = overrides.runsDir ?? fixedOwnerRunsDir();
  const thread = await readMasonThread({
    runsDir, busRoot: join(ashlrHome(), 'fleet'), sinceMs, now,
    ...(beforeMs === undefined ? {} : { beforeMs }),
    ...(channel === undefined ? {} : { channel }),
    ...(direction === undefined ? {} : { direction }),
    ...(contains === undefined ? {} : { contains }),
    owner: { runsDir, settings: loadOwnerThreadSettings(fixedOwnerConfigDir()) },
    ...overrides,
  });
  console.log(args.includes('--json') ? JSON.stringify(thread) : masonThreadText(thread));
  return 0;
}
