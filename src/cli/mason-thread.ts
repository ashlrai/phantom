/** `phm mason thread [--since <dur>] [--json]`: Mason's one thread across every
 * channel, with each message's reply state and linked jobs. Read-only: it never
 * calls a channel transport and sends nothing. Logic lives in core/comms/mason-thread.ts. */
import { join } from 'node:path';
import { rejectUnknownOptions } from './args.js';
import { ashlrHome } from '../core/cloud/store.js';
import { fixedOwnerConfigDir, fixedOwnerRunsDir, loadOwnerThreadSettings } from '../core/comms/owner-channel.js';
import { masonThreadText, readMasonThread, type MasonThreadOptions } from '../core/comms/mason-thread.js';
import { parseSince } from '../core/fleet/agent-messages.js';
import { cmdFleetMasonDigest, type MasonDigestCliDeps } from './fleet-mason-digest.js';

const USAGE = 'usage: phm mason thread [--since <15m|2h|1d>] [--json]\n       phm mason digest [--since 1h] [--post] [--json]';
const DEFAULT_SINCE = '1d';

export async function cmdMason(args: string[], overrides: Partial<MasonThreadOptions> = {}, digestDeps: MasonDigestCliDeps = {}): Promise<number> {
  if (args[0] === 'digest') return cmdFleetMasonDigest(args.slice(1), { runsDir: overrides.runsDir, ...digestDeps });
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  const bad = args[0] !== 'thread' ? { message: `unknown mason command: ${args[0] ?? '(none)'}` } : rejectUnknownOptions(args.slice(1), { flags: ['--json'], values: ['--since'] });
  if (bad) { console.error(bad.message); console.error(USAGE); return 2; }
  const at = args.indexOf('--since');
  const now = Date.now();
  const sinceMs = parseSince(at < 0 ? DEFAULT_SINCE : args[at + 1] ?? '', now);
  if (sinceMs === null) { console.error('--since takes 15m, 2h, 1d, epoch ms or an ISO time.'); console.error(USAGE); return 2; }
  const runsDir = overrides.runsDir ?? fixedOwnerRunsDir();
  const thread = await readMasonThread({
    runsDir, busRoot: join(ashlrHome(), 'fleet'), sinceMs, now,
    owner: { runsDir, settings: loadOwnerThreadSettings(fixedOwnerConfigDir()) },
    ...overrides,
  });
  console.log(args.includes('--json') ? JSON.stringify(thread) : masonThreadText(thread));
  return 0;
}
