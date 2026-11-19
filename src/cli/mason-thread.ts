/** `phm mason thread [--since <dur>] [--json]`: Mason's one thread across every
 * channel, with each message's reply state and linked jobs. Read-only: it never
 * calls a channel transport and sends nothing.
 * `phm mason digest [--since 1h] [--post] [--json]`: the hourly update in plain words; --post records it in
 * Mason's own thread through the owner-thread writer and nowhere else.
 * Logic lives in core/comms/mason-thread.ts and core/comms/mason-digest.ts. */
import { join } from 'node:path';
import { rejectUnknownOptions } from './args.js';
import { ashlrHome } from '../core/cloud/store.js';
import { fixedOwnerConfigDir, fixedOwnerRunsDir, loadOwnerThreadSettings } from '../core/comms/owner-channel.js';
import { masonThreadText, readMasonThread, type MasonThreadOptions } from '../core/comms/mason-thread.js';
import { masonDigestText, postMasonDigest, readMasonDigest, type MasonDigestPostOptions, type MasonDigestReaders } from '../core/comms/mason-digest.js';
import { parseSince } from '../core/fleet/agent-messages.js';
import { THROUGHPUT_MAX_HOURS } from '../core/fleet/throughput.js';

const USAGE = 'usage: phm mason thread [--since <15m|2h|1d>] [--json]\n       phm mason digest [--since 1h] [--post] [--json]';
const DEFAULT_SINCE = '1d';
const DIGEST_SINCE = '1h';

export interface MasonDigestCliDeps {
  now?: number;
  runsDir?: string;
  readers?: Partial<MasonDigestReaders>;
  post?: MasonDigestPostOptions['post'];
}

export async function cmdMason(args: string[], overrides: Partial<MasonThreadOptions> = {}, digestDeps: MasonDigestCliDeps = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(USAGE); return 0; }
  const verb = args[0];
  const digest = verb === 'digest';
  const bad = verb !== 'thread' && !digest ? { message: `unknown mason command: ${verb ?? '(none)'}` }
    : rejectUnknownOptions(args.slice(1), { flags: digest ? ['--json', '--post'] : ['--json'], values: ['--since'] });
  if (bad) { console.error(bad.message); console.error(USAGE); return 2; }
  const at = args.indexOf('--since');
  const now = digestDeps.now ?? Date.now();
  const sinceMs = parseSince(at < 0 ? (digest ? DIGEST_SINCE : DEFAULT_SINCE) : args[at + 1] ?? '', now);
  if (sinceMs === null) { console.error('--since takes 15m, 2h, 1d, epoch ms or an ISO time.'); console.error(USAGE); return 2; }
  const runsDir = digestDeps.runsDir ?? overrides.runsDir ?? fixedOwnerRunsDir();
  const owner = { runsDir, settings: loadOwnerThreadSettings(fixedOwnerConfigDir()) };

  if (digest) {
    if (!(sinceMs < now) || (now - sinceMs) / 3_600_000 > THROUGHPUT_MAX_HOURS) {
      console.error(`--since must be in the past and within ${THROUGHPUT_MAX_HOURS} hours (for example 1h or 6h).`); console.error(USAGE); return 2;
    }
    const report = await readMasonDigest({ runsDir, now, sinceMs, readers: digestDeps.readers });
    // A manual --post always posts (the hourly limit still holds); the self-tick hook adds the quiet and unchanged checks.
    const post = args.includes('--post') ? await postMasonDigest(report, { runsDir, now, owner: { ...owner, now: () => now }, force: true, post: digestDeps.post }) : null;
    console.log(args.includes('--json') ? JSON.stringify({ ...report, post }) : [masonDigestText(report), ...(post ? [post.reason] : [])].join('\n'));
    return post && (post.state === 'unavailable' || post.state === 'refused') ? 1 : 0;
  }

  const thread = await readMasonThread({
    runsDir, busRoot: join(ashlrHome(), 'fleet'), sinceMs, now,
    owner,
    ...overrides,
  });
  console.log(args.includes('--json') ? JSON.stringify(thread) : masonThreadText(thread));
  return 0;
}
